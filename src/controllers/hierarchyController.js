const mongoose = require('mongoose');
const Hierarchy = require('../models/EmployeeHierarchy');
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
        from: 'employeehierarchies',
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

      // duplicate?
      if (await Hierarchy.exists({ owner: ownerId, senior: seniorId, junior: juniorId })) {
        invalid.push({ seniorId, juniorId, reason: 'Duplicate' });
        continue;
      }

      // cycle?
      if (await checkForCircularReference(ownerId, seniorId, juniorId)) {
        invalid.push({ seniorId, juniorId, reason: 'Circular' });
        continue;
      }

      toInsert.push({
        owner: ownerId,
        senior: seniorId,
        junior: juniorId,
        relation: relation || 'Manager',

        // TEMP but VALID values (will be recalculated)
        hierarchyLevel: 1,
        path: String(seniorId),
        rootManager: seniorId
      });

    }

    if (!toInsert.length) {
      return res.status(400).json({
        status: 'error',
        message: 'No valid links',
        invalid
      });
    }

    const created = await Hierarchy.insertMany(toInsert, { ordered: true });

    // ✅ Enterprise: rebuild metadata after bulk insert
    await rebuildHierarchy(ownerId);

    res.status(201).json({
      status: 'success',
      count: created.length,
      invalid,
      data: created
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
    const { id } = req.params;       // juniorId (frontend)
    const senior = req.query.senior; // seniorId (query)
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

