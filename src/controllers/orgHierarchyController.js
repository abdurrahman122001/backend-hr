const mongoose = require('mongoose');
const Hierarchy = require('../models/OrgHierarchy');
const Employee = require('../models/Employees');
const Department = require('../models/Departments');

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

const NO_DEPARTMENT = '__none__';

function normalizeDept(value) {
  return String(value || '').trim();
}

function deptKey(value) {
  const name = normalizeDept(value);
  return name ? name.toLowerCase() : NO_DEPARTMENT;
}

/**
 * Sync admin access from the hierarchy.
 *
 * A root used to mean "company admin", full stop. That was safe while the whole
 * company was one tree with one root. Department-wise hierarchies deliberately
 * produce MANY roots — one head per department — and granting every department
 * head company-admin would be a serious privilege escalation.
 *
 * So a root only earns admin when it genuinely sits above the whole company:
 *   • it is the only root, or
 *   • its subtree spans more than one department (a real company-level person).
 * A root whose subtree is a single department is just a department head.
 *
 * Department heads are also never DEMOTED here: we clear isAdmin for ordinary
 * employees, but leave a head's flag exactly as an administrator set it.
 *
 * @param {string[]} rootIds        roots of the whole graph
 * @param {Map<string,Set<string>>} deptSpanByRoot  root id -> departments in its subtree
 */
async function syncTopSeniorAdmin(ownerId, rootIds, deptSpanByRoot = new Map()) {
  const onlyOneRoot = rootIds.length === 1;

  const companyRootIds = rootIds.filter((id) => {
    if (onlyOneRoot) return true;
    const span = deptSpanByRoot.get(String(id));
    return span ? span.size > 1 : false;
  });

  // Roots that head exactly one department — neither granted nor revoked.
  const departmentHeadIds = rootIds.filter(
    (id) => !companyRootIds.includes(id)
  );

  const protectedIds = [...companyRootIds, ...departmentHeadIds].map(
    (id) => new mongoose.Types.ObjectId(id)
  );

  await Employee.updateMany(
    { owner: ownerId, _id: { $nin: protectedIds } },
    { $set: { isAdmin: false } }
  );

  if (companyRootIds.length) {
    await Employee.updateMany(
      {
        owner: ownerId,
        _id: { $in: companyRootIds.map((id) => new mongoose.Types.ObjectId(id)) }
      },
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
  let links = await Hierarchy.find({ owner: ownerId })
    .select('senior junior')
    .lean();

  // Drop links whose senior or junior no longer exists. Deleting an employee
  // leaves the link behind, and a dangling edge shows up as a phantom "unknown"
  // row in the tree (and in anything derived from it, like onboarding tasks).
  const referencedIds = [...new Set(links.flatMap(l => [String(l.senior), String(l.junior)]))];
  const existing = referencedIds.length
    ? await Employee.find({ _id: { $in: referencedIds } }).select('_id department').lean()
    : [];
  const existingIds = new Set(existing.map(e => String(e._id)));

  const dangling = links.filter(
    l => !existingIds.has(String(l.senior)) || !existingIds.has(String(l.junior))
  );
  if (dangling.length) {
    await Hierarchy.deleteMany({ _id: { $in: dangling.map(l => l._id) } });
    console.log(`🧹 Pruned ${dangling.length} hierarchy link(s) referencing deleted employees`);
    links = links.filter(
      l => existingIds.has(String(l.senior)) && existingIds.has(String(l.junior))
    );
  }

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

  // Department of every employee touched by the graph — needed to stamp each
  // link with the team it belongs to and to tell a normal in-team report from a
  // deliberate cross-department line.
  const departmentOf = new Map(
    existing.map(e => [String(e._id), normalizeDept(e.department)])
  );

  // Roots = seniors that never appear as juniors
  const allSeniors = new Set(links.map(l => String(l.senior)));
  const allJuniors = new Set(links.map(l => String(l.junior)));

  const roots = [...allSeniors].filter(sid => !allJuniors.has(sid));

  // Which departments live under each root? Drives the admin rule below: a root
  // covering one department is a department head, not a company admin.
  const deptSpanByRoot = new Map();
  const spanSeen = new Set();

  function collectSpan(nodeId, rootId) {
    const guard = `${rootId}|${nodeId}`;
    if (spanSeen.has(guard)) return;
    spanSeen.add(guard);

    const span = deptSpanByRoot.get(rootId) || new Set();
    span.add(deptKey(departmentOf.get(nodeId)));
    deptSpanByRoot.set(rootId, span);

    for (const child of childrenMap.get(nodeId) || []) {
      collectSpan(child, rootId);
    }
  }
  for (const root of roots) collectSpan(root, root);

  // Top senior(s) become admins; everyone else loses admin access.
  await syncTopSeniorAdmin(ownerId, roots, deptSpanByRoot);

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

      // The link belongs to the JUNIOR's department — it is that person's slot
      // in their own team. When the senior sits elsewhere the line crosses
      // departments, which is what joins two department trees together.
      const juniorDept = departmentOf.get(juniorId) || '';
      const seniorDept = departmentOf.get(seniorId) || '';
      const scope =
        deptKey(juniorDept) === deptKey(seniorDept) ? 'department' : 'company';

      await Hierarchy.updateOne(
        { owner: ownerId, senior: seniorId, junior: juniorId },
        {
          $set: {
            hierarchyLevel: nextLevel,
            path: edgePath,
            rootManager: rootId,
            department: juniorDept,
            scope
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

    // Cross-department lines are legitimate (a department head reporting to the
    // CEO) but must be deliberate — dragging someone onto the wrong team by
    // accident silently moves them out of their department's chain. The client
    // sends allowCrossDepartment once the user has confirmed.
    const allowCrossDepartment = req.body.allowCrossDepartment === true;

    // Validate + prepare docs (NO meta calc here; we rebuild after insert)
    let upsertCount = 0;

    for (const { seniorId, juniorId, relation } of links) {
      if (!seniorId || !juniorId || String(seniorId) === String(juniorId)) {
        invalid.push({ seniorId, juniorId, reason: 'Invalid IDs' });
        continue;
      }

      // employees exist?
      const [senior, junior] = await Promise.all([
        Employee.findById(seniorId).select('_id status name department').lean(),
        Employee.findById(juniorId).select('_id status name department').lean()
      ]);
      if (!senior || !junior) {
        invalid.push({ seniorId, juniorId, reason: 'Employee not found' });
        continue;
      }

      if (['offboarded', 'terminated'].includes(senior.status) || ['offboarded', 'terminated'].includes(junior.status)) {
        invalid.push({ seniorId, juniorId, reason: 'Employee is offboarded/terminated' });
        continue;
      }

      const crossDepartment =
        deptKey(senior.department) !== deptKey(junior.department);

      if (crossDepartment && !allowCrossDepartment) {
        invalid.push({
          seniorId,
          juniorId,
          reason: 'CROSS_DEPARTMENT',
          seniorName: senior.name,
          juniorName: junior.name,
          seniorDepartment: normalizeDept(senior.department) || 'Unassigned',
          juniorDepartment: normalizeDept(junior.department) || 'Unassigned'
        });
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

    // Nothing applied and every rejection was a cross-department line — tell the
    // client precisely that, so it can ask for confirmation instead of showing
    // a generic failure.
    if (
      upsertCount === 0 &&
      invalid.length > 0 &&
      invalid.every((i) => i.reason === 'CROSS_DEPARTMENT')
    ) {
      return res.status(409).json({
        status: 'error',
        code: 'CROSS_DEPARTMENT',
        message: 'This reporting line crosses departments',
        invalid
      });
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
const EMP_NODE_FIELDS = 'name status department subDepartment designation photographUrl employeeId';

exports.getHierarchy = async function (req, res) {
  try {
    const ownerId = req.user._id;

    // Load all links with populated names and status
    const links = await Hierarchy.find({ owner: ownerId })
      .populate('senior', EMP_NODE_FIELDS)
      .populate('junior', EMP_NODE_FIELDS)
      .lean();

    // Filter out links where either senior or junior is offboarded or terminated
    const filteredLinks = links.filter(l => {
      const seniorActive = l.senior && !['offboarded', 'terminated'].includes(l.senior.status);
      const juniorActive = l.junior && !['offboarded', 'terminated'].includes(l.junior.status);
      return seniorActive && juniorActive;
    });

    const toNode = (emp) => ({
      id: String(emp._id),
      name: emp.name,
      department: normalizeDept(emp.department),
      subDepartment: emp.subDepartment || '',
      designation: emp.designation || '',
      photographUrl: emp.photographUrl || '',
      employeeId: emp.employeeId || '',
      // true when this person's own senior sits in another department
      crossDepartment: false,
      children: []
    });

    // Build nodes map
    const map = {};
    filteredLinks.forEach(l => {
      const sid = String(l.senior._id);
      const jid = String(l.junior._id);

      if (!map[sid]) map[sid] = toNode(l.senior);
      if (!map[jid]) map[jid] = toNode(l.junior);

      if (deptKey(map[sid].department) !== deptKey(map[jid].department)) {
        map[jid].crossDepartment = true;
      }

      map[sid].children.push(map[jid]);
    });

    // Find roots (those never appearing as a junior in the filtered links)
    const juniorIds = new Set(filteredLinks.map(l => String(l.junior._id)));
    const tree = Object.values(map).filter(node => !juniorIds.has(node.id));

    /* ── Department view ────────────────────────────────────────────────────
     * The same people, regrouped so each department owns its own tree. A
     * department's roots are its members whose senior is NOT in the department
     * (or who have no senior at all) — i.e. the department heads. Everyone
     * below them is reached through their existing children, minus anyone who
     * belongs to a different department (those start their own tree there).
     * ------------------------------------------------------------------- */
    const allEmployees = await Employee.find({
      owner: ownerId,
      status: { $nin: ['offboarded', 'terminated'] }
    })
      .select(EMP_NODE_FIELDS)
      .lean();

    const seniorOf = new Map(
      filteredLinks.map(l => [String(l.junior._id), String(l.senior._id)])
    );
    const placedIds = new Set([
      ...filteredLinks.map(l => String(l.junior._id)),
      ...filteredLinks.map(l => String(l.senior._id))
    ]);

    // Department records carry the tier: `order` is the department's rank in the
    // org (0 = top tier). Seeded first so a department with no employees yet
    // still appears and can be positioned.
    const departmentDocs = await Department.find({ owner: ownerId })
      .select('name order')
      .sort({ order: 1 })
      .lean();

    const departmentMeta = new Map(
      departmentDocs.map(d => [deptKey(d.name), { id: String(d._id), order: d.order ?? 0, name: d.name }])
    );

    const buckets = new Map(); // deptKey -> { department, members[], roots[], unplaced[] }
    const bucketFor = (deptName) => {
      const key = deptKey(deptName);
      if (!buckets.has(key)) {
        const meta = departmentMeta.get(key);
        buckets.set(key, {
          key,
          departmentId: meta?.id || null,
          department: meta?.name || normalizeDept(deptName) || 'Unassigned',
          hasDepartment: !!normalizeDept(deptName),
          tier: meta ? meta.order : Number.MAX_SAFE_INTEGER,
          members: [],
          unplaced: [],
          rootIds: []
        });
      }
      return buckets.get(key);
    };

    // Seed every configured department so empty ones are still orderable.
    for (const doc of departmentDocs) bucketFor(doc.name);

    for (const emp of allEmployees) {
      const bucket = bucketFor(emp.department);
      bucket.members.push(String(emp._id));
      if (!placedIds.has(String(emp._id))) {
        bucket.unplaced.push({
          id: String(emp._id),
          name: emp.name,
          designation: emp.designation || '',
          department: normalizeDept(emp.department),
          photographUrl: emp.photographUrl || ''
        });
      }
    }

    // Department roots: placed members whose senior is outside the department.
    for (const node of Object.values(map)) {
      const seniorId = seniorOf.get(node.id);
      const seniorNode = seniorId ? map[seniorId] : null;
      const isDeptRoot =
        !seniorNode || deptKey(seniorNode.department) !== deptKey(node.department);
      if (isDeptRoot) bucketFor(node.department).rootIds.push(node.id);
    }

    // Clone a subtree, stopping wherever the chain leaves the department.
    const subtreeForDepartment = (node, dKey, seen = new Set()) => {
      if (seen.has(node.id)) return null;
      seen.add(node.id);
      return {
        ...node,
        children: node.children
          .filter(child => deptKey(child.department) === dKey)
          .map(child => subtreeForDepartment(child, dKey, seen))
          .filter(Boolean)
      };
    };

    const byDepartment = [...buckets.values()]
      .map(bucket => {
        const roots = bucket.rootIds
          .map(id => subtreeForDepartment(map[id], bucket.key))
          .filter(Boolean);

        const head = roots.length
          ? {
              id: roots[0].id,
              name: roots[0].name,
              designation: roots[0].designation
            }
          : null;

        const countNodes = (nodes) =>
          nodes.reduce((sum, n) => sum + 1 + countNodes(n.children), 0);
        const depthOf = (nodes) =>
          nodes.reduce((max, n) => Math.max(max, 1 + depthOf(n.children)), 0);

        return {
          key: bucket.key,
          departmentId: bucket.departmentId,
          department: bucket.department,
          hasDepartment: bucket.hasDepartment,
          tier: bucket.tier,
          head,
          roots,
          unplaced: bucket.unplaced,
          totalMembers: bucket.members.length,
          placedMembers: countNodes(roots),
          unplacedMembers: bucket.unplaced.length,
          depth: depthOf(roots),
          // members of this department whose senior is in another department
          crossDepartmentRoots: roots.filter(r => r.crossDepartment).length
        };
      })
      .sort((a, b) => {
        // Tier order first (that is the whole point of Department.order),
        // "Unassigned" and unconfigured departments last, then by name.
        if (a.hasDepartment !== b.hasDepartment) return a.hasDepartment ? -1 : 1;
        if (a.tier !== b.tier) return a.tier - b.tier;
        return a.department.localeCompare(b.department);
      });

    res.json({
      status: 'success',
      data: tree,
      byDepartment,
      stats: {
        departments: byDepartment.filter(d => d.hasDepartment).length,
        totalEmployees: allEmployees.length,
        placed: placedIds.size,
        unplaced: allEmployees.length - placedIds.size,
        crossDepartmentLinks: filteredLinks.filter(
          l => deptKey(l.senior.department) !== deptKey(l.junior.department)
        ).length
      }
    });
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

