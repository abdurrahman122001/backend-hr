const mongoose = require('mongoose');
const Hierarchy = require('../models/OrgHierarchy');
const Employee = require('../models/Employees');

/**
 * Helper: look for any path from `seniorId` down to `juniorId`.
 * If a path exists, adding seniorId -> juniorId would create a cycle.
 */
async function checkForCircularReference(ownerId, seniorId, juniorId) {
  const result = await Hierarchy.aggregate([
    { $match: { owner: new mongoose.Types.ObjectId(ownerId) } },
    {
      $graphLookup: {
        from: 'orghierarchies',
        startWith: new mongoose.Types.ObjectId(juniorId),
        connectFromField: 'junior',
        connectToField: 'senior',
        as: 'downstream',
        depthField: 'depth'
      }
    },
    { $unwind: '$downstream' },
    { $match: { 'downstream.junior': new mongoose.Types.ObjectId(seniorId) } }
  ]);

  return result.length > 0;
}

/**
 * Sync admin access from the hierarchy.
 * The top senior(s) — i.e. the root manager(s) of each chain — get isAdmin=true.
 * Every other employee for this owner gets isAdmin=false, so the hierarchy fully
 * drives admin-dashboard access (manual grants on non-roots are intentionally
 * cleared). Called from rebuildHierarchy after roots are recomputed.
 */
async function syncTopSeniorAdmin(ownerId, rootIds) {
  const rootObjectIds = rootIds.map((id) => new mongoose.Types.ObjectId(id));

  await Employee.updateMany(
    { owner: ownerId, _id: { $nin: rootObjectIds } },
    { $set: { isAdmin: false } }
  );

  if (rootObjectIds.length) {
    await Employee.updateMany(
      { owner: ownerId, _id: { $in: rootObjectIds } },
      { $set: { isAdmin: true } }
    );
  }
}

/**
 * Rebuild enterprise hierarchy metadata (hierarchyLevel, path, rootManager)
 * based on currently saved relationships (owner-scoped).
 *
 * Why: In bulkCreate, parents may be inserted after children, so computing meta
 * during insert can be wrong. This function fixes it deterministically.
 *
 * path format: "rootId.parentId.currentSeniorId" (dot-separated ObjectId strings)
 * hierarchyLevel: root link = 1, child link increments by 1
 * rootManager: top-most manager id for that chain
 */
async function rebuildHierarchy(ownerId) {
  const links = await Hierarchy.find({ owner: ownerId })
    .select('senior junior')
    .lean();

  // Build maps: senior -> [juniors], junior -> senior
  const childrenMap = new Map(); // key: seniorId, value: juniors[]
  const parentMap = new Map();   // key: juniorId, value: seniorId

  for (const l of links) {
    const s = String(l.senior);
    const j = String(l.junior);

    if (!childrenMap.has(s)) childrenMap.set(s, []);
    childrenMap.get(s).push(j);

    // If you ever want matrix reporting, do NOT use parentMap (a junior can have multiple seniors).
    // For now, assume single manager.
    parentMap.set(j, s);
  }

  // Roots = seniors that never appear as juniors
  const allSeniors = new Set(links.map(l => String(l.senior)));
  const allJuniors = new Set(links.map(l => String(l.junior)));

  const roots = [...allSeniors].filter(sid => !allJuniors.has(sid));

  // Top senior(s) become admins; everyone else loses admin access.
  await syncTopSeniorAdmin(ownerId, roots);

  // If there are no roots (shouldn't happen unless cycle or empty), stop
  if (!roots.length) return;

  // Walk and update each edge (senior -> junior)
  // We update documents by (owner, senior, junior)
  const visited = new Set();

  async function dfs(seniorId, level, pathArr, rootId) {
    const key = `${seniorId}|${level}|${rootId}|${pathArr.join('.')}`;
    if (visited.has(key)) return;
    visited.add(key);

    const juniors = childrenMap.get(seniorId) || [];
    for (const juniorId of juniors) {
      const nextLevel = level; // edge level represents distance from root senior to this edge's senior
      const edgePath = pathArr.join('.'); // path is the chain of seniors up to current senior

      await Hierarchy.updateOne(
        { owner: ownerId, senior: seniorId, junior: juniorId },
        {
          $set: {
            hierarchyLevel: nextLevel,
            path: edgePath,
            rootManager: rootId
          }
        }
      );

      // Recurse to child's reports: now child becomes next senior
      await dfs(juniorId, nextLevel + 1, [...pathArr, juniorId], rootId);
    }
  }

  for (const root of roots) {
    // For root, path starts with root
    await dfs(root, 1, [root], root);
  }
}

/**
 * Optional helper used for SINGLE create only (safe because parent already exists).
 * In bulk we rebuild after insert anyway.
 */
async function buildHierarchyMeta(ownerId, seniorId) {
  const parent = await Hierarchy.findOne({ owner: ownerId, junior: seniorId })
    .select('hierarchyLevel path rootManager')
    .lean();

  if (!parent) {
    return {
      hierarchyLevel: 1,
      path: String(seniorId),
      rootManager: seniorId
    };
  }

  return {
    hierarchyLevel: parent.hierarchyLevel + 1,
    path: `${parent.path}.${seniorId}`,
    rootManager: parent.rootManager
  };
}

exports.create = async (req, res) => {
  try {
    const { seniorId, juniorId, relation } = req.body;
    const ownerId = req.user._id;

    if (!seniorId || !juniorId) {
      return res.status(400).json({
        status: 'error',
        message: 'seniorId and juniorId are required'
      });
    }

    if (String(seniorId) === String(juniorId)) {
      return res.status(400).json({
        status: 'error',
        message: 'Self-referencing hierarchy is not allowed'
      });
    }

    const [senior, junior] = await Promise.all([
      Employee.findById(seniorId).lean(),
      Employee.findById(juniorId).lean()
    ]);

    if (!senior || !junior) {
      return res.status(404).json({
        status: 'error',
        message: 'Employee not found'
      });
    }

    if (['offboarded', 'terminated'].includes(senior.status) || ['offboarded', 'terminated'].includes(junior.status)) {
      return res.status(400).json({
        status: 'error',
        message: 'Cannot add offboarded or terminated employees to hierarchy'
      });
    }

    if (await Hierarchy.exists({ owner: ownerId, senior: seniorId, junior: juniorId })) {
      return res.status(400).json({
        status: 'error',
        message: 'Relationship already exists'
      });
    }

    if (await checkForCircularReference(ownerId, seniorId, juniorId)) {
      return res.status(400).json({
        status: 'error',
        message: 'Circular hierarchy detected'
      });
    }

    const meta = await buildHierarchyMeta(ownerId, seniorId);

    const link = await Hierarchy.create({
      owner: ownerId,
      senior: seniorId,
      junior: juniorId,
      relation: relation || 'Manager',
      ...meta
    });

    // Ensure metadata is consistent in case this create changes chains
    await rebuildHierarchy(ownerId);

    res.status(201).json({ status: 'success', data: link });
  } catch (err) {
    console.error('Create hierarchy error:', err);
    res.status(500).json({
      status: 'error',
      message: err.message || 'Internal server error'
    });
  }
};

exports.bulkCreate = async (req, res) => {
  try {
    const ownerId = req.user._id;
    const { links } = req.body;

    if (!Array.isArray(links) || !links.length) {
      return res.status(400).json({
        status: 'error',
        message: 'Links must be a non-empty array'
      });
    }

    const invalid = [];
    const toInsert = [];

    // Validate + prepare docs (NO meta calc here; we rebuild after insert)
    let upsertCount = 0;

    for (const { seniorId, juniorId, relation } of links) {
      if (!seniorId || !juniorId || String(seniorId) === String(juniorId)) {
        invalid.push({ seniorId, juniorId, reason: 'Invalid IDs' });
        continue;
      }

      // employees exist?
      const [senior, junior] = await Promise.all([
        Employee.findById(seniorId).select('_id status').lean(),
        Employee.findById(juniorId).select('_id status').lean()
      ]);
      if (!senior || !junior) {
        invalid.push({ seniorId, juniorId, reason: 'Employee not found' });
        continue;
      }

      if (['offboarded', 'terminated'].includes(senior.status) || ['offboarded', 'terminated'].includes(junior.status)) {
        invalid.push({ seniorId, juniorId, reason: 'Employee is offboarded/terminated' });
        continue;
      }

      // cycle?
      if (await checkForCircularReference(ownerId, seniorId, juniorId)) {
        invalid.push({ seniorId, juniorId, reason: 'Circular' });
        continue;
      }

      // Upsert: junior can only have ONE senior.
      await Hierarchy.findOneAndUpdate(
        { owner: ownerId, junior: juniorId },
        {
          senior: seniorId,
          relation: relation || 'Manager',
          hierarchyLevel: 1,
          path: String(seniorId),
          rootManager: seniorId
        },
        { upsert: true, new: true }
      );
      upsertCount++;
    }

    if (upsertCount === 0 && invalid.length > 0) {
      return res.status(400).json({
        status: 'error',
        message: 'No valid links were processed',
        invalid
      });
    }

    // ✅ Enterprise: rebuild metadata after bulk insert
    await rebuildHierarchy(ownerId);

    res.status(201).json({
      status: 'success',
      count: upsertCount,
      invalid,
      data: []
    });
  } catch (err) {
    console.error('Bulk hierarchy error:', err);
    res.status(500).json({
      status: 'error',
      message: err.message || 'Bulk hierarchy save failed'
    });
  }
};

/**
 * IMPORTANT:
 * You had two exports.getHierarchy functions. This keeps BOTH behaviors:
 * - If your Hierarchy model has getFullHierarchy, it will still work.
 * - Otherwise, it returns the tree structure your React UI expects.
 *
 * Your router should call THIS one (tree), since your UI expects nodes with children[].
 */
exports.getHierarchy = async function (req, res) {
  try {
    const ownerId = req.user._id;

    // Load all links with populated names and status
    const links = await Hierarchy.find({ owner: ownerId })
      .populate('senior', 'name status')
      .populate('junior', 'name status')
      .lean();

    // Filter out links where either senior or junior is offboarded or terminated
    const filteredLinks = links.filter(l => {
      const seniorActive = l.senior && !['offboarded', 'terminated'].includes(l.senior.status);
      const juniorActive = l.junior && !['offboarded', 'terminated'].includes(l.junior.status);
      return seniorActive && juniorActive;
    });

    // Build nodes map
    const map = {};
    filteredLinks.forEach(l => {
      const sid = l.senior._id.toString();
      const jid = l.junior._id.toString();

      if (!map[sid]) {
        map[sid] = { id: sid, name: l.senior.name, children: [] };
      }
      if (!map[jid]) {
        map[jid] = { id: jid, name: l.junior.name, children: [] };
      }

      map[sid].children.push(map[jid]);
    });

    // Find roots (those never appearing as a junior in the filtered links)
    const juniorIds = new Set(filteredLinks.map(l => l.junior._id.toString()));
    const tree = Object.values(map).filter(node => !juniorIds.has(node.id));

    res.json({ status: 'success', data: tree });
  } catch (err) {
    console.error('Error fetching hierarchy tree:', err);
    res.status(500).json({ status: 'error', message: 'Failed to fetch hierarchy' });
  }
};

/**
 * GET /org-hierarchy/seniors?department=<name>
 *
 * Returns the employees that are ALREADY seniors in the org hierarchy, i.e. the
 * ones that have at least one junior under them. Used by the auto-onboarding
 * (offer letter) form: after a department is picked we only offer the seniors of
 * that department as the new hire's reporting manager.
 *
 * `department` is matched against Employee.department (a plain name string, that
 * is how the offer-letter flow stores it), case-insensitively. Omit it to get
 * every senior of the company.
 */
exports.getSeniors = async (req, res) => {
  try {
    const ownerId = req.user._id;
    const department = (req.query.department || '').trim();

    // Distinct senior ids + how many juniors each one has.
    const grouped = await Hierarchy.aggregate([
      { $match: { owner: new mongoose.Types.ObjectId(ownerId) } },
      {
        $group: {
          _id: '$senior',
          juniorCount: { $sum: 1 },
          hierarchyLevel: { $min: '$hierarchyLevel' }
        }
      }
    ]);

    if (!grouped.length) {
      return res.json({ status: 'success', data: [] });
    }

    const countById = new Map(
      grouped.map((g) => [String(g._id), g])
    );

    const query = {
      _id: { $in: grouped.map((g) => g._id) },
      owner: ownerId,
      status: { $nin: ['offboarded', 'terminated'] }
    };

    if (department) {
      // Escape regex metacharacters — department names are free text.
      const escaped = department.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      query.department = new RegExp(`^${escaped}$`, 'i');
    }

    const seniors = await Employee.find(query)
      .select('name department subDepartment designation photographUrl status')
      .lean();

    const data = seniors
      .map((e) => {
        const meta = countById.get(String(e._id)) || {};
        return {
          _id: e._id,
          name: e.name,
          department: e.department,
          subDepartment: e.subDepartment,
          designation: e.designation,
          photographUrl: e.photographUrl,
          juniorCount: meta.juniorCount || 0,
          hierarchyLevel: meta.hierarchyLevel || 1
        };
      })
      .sort(
        (a, b) =>
          a.hierarchyLevel - b.hierarchyLevel ||
          String(a.name).localeCompare(String(b.name))
      );

    res.json({ status: 'success', data });
  } catch (err) {
    console.error('Fetch hierarchy seniors error:', err);
    res.status(500).json({
      status: 'error',
      message: 'Failed to fetch seniors'
    });
  }
};

/**
 * Programmatic helper (no req/res) so other flows — auto onboarding, in
 * particular — can place a freshly created employee under a senior using the
 * exact same validation + metadata rebuild as the hierarchy UI.
 *
 * Returns the created link, or throws with a readable message.
 */
exports.linkJuniorToSenior = async function linkJuniorToSenior(
  ownerId,
  seniorId,
  juniorId,
  relation = 'Manager'
) {
  if (!seniorId || !juniorId) throw new Error('seniorId and juniorId are required');
  if (String(seniorId) === String(juniorId)) {
    throw new Error('Self-referencing hierarchy is not allowed');
  }

  const senior = await Employee.findOne({ _id: seniorId, owner: ownerId })
    .select('_id status')
    .lean();

  if (!senior) throw new Error('Senior not found for this company');
  if (['offboarded', 'terminated'].includes(senior.status)) {
    throw new Error('Cannot report to an offboarded or terminated employee');
  }

  if (await checkForCircularReference(ownerId, seniorId, juniorId)) {
    throw new Error('Circular hierarchy detected');
  }

  // A junior can only have ONE senior — mirrors bulkCreate's upsert.
  const link = await Hierarchy.findOneAndUpdate(
    { owner: ownerId, junior: juniorId },
    {
      senior: seniorId,
      relation: relation || 'Manager',
      hierarchyLevel: 1,
      path: String(seniorId),
      rootManager: seniorId
    },
    { upsert: true, new: true }
  );

  await rebuildHierarchy(ownerId);

  return link;
};

exports.getDirectReports = async (req, res) => {
  try {
    const { employeeId } = req.params;
    const reports = await Hierarchy.getDirectReports(req.user._id, employeeId);
    res.json({ status: 'success', data: reports });
  } catch (err) {
    console.error('Direct reports error:', err);
    res.status(500).json({
      status: 'error',
      message: 'Failed to fetch direct reports'
    });
  }
};

exports.getManagementChain = async (req, res) => {
  try {
    const { employeeId } = req.params;
    const chain = await Hierarchy.getManagementChain(req.user._id, employeeId);
    res.json({ status: 'success', data: chain });
  } catch (err) {
    console.error('Management chain error:', err);
    res.status(500).json({
      status: 'error',
      message: 'Failed to fetch management chain'
    });
  }
};

exports.deleteHierarchy = async (req, res) => {
  try {
    const { id } = req.params;
    const senior = req.query.senior;
    if (!id || !senior) {
      return res.status(400).json({
        status: 'error',
        message: 'junior and senior id required'
      });
    }

    const deleted = await Hierarchy.findOneAndDelete({
      owner: req.user._id,
      senior,
      junior: id
    });

    if (!deleted) {
      return res.status(404).json({
        status: 'error',
        message: 'Relationship not found'
      });
    }

    // 🔥 SYNC: Remove senior from junior's clients supervisedBy
    const ClientInfo = require('../models/ClientInfo');
    const juniorClients = await ClientInfo.find({
      owner: req.user._id,
      assignedTo: id
    });

    const seniorIdStr = String(senior);
    for (const client of juniorClients) {
      if (client.supervisedBy?.some(sid => String(sid._id || sid) === seniorIdStr)) {
        client.supervisedBy = client.supervisedBy.filter(sid => String(sid._id || sid) !== seniorIdStr);
        client.supervision = client.supervisedBy.length > 0 ? 'needs_approval' : 'direct';
        client.markModified('supervisedBy');
        await client.save();
      }
    }

    // ✅ rebuild after delete to keep metadata consistent
    await rebuildHierarchy(req.user._id);

    res.json({
      status: 'success',
      message: 'Relationship deleted and supervision updated',
      data: deleted
    });
  } catch (err) {
    console.error('Delete hierarchy error:', err);
    res.status(500).json({
      status: 'error',
      message: 'Server error'
    });
  }
};

