const PayrollHierarchy = require('../models/PayrollHierarchy');
const Employee = require('../models/Employees');

const inactiveStatuses = ['offboarded', 'terminated'];

function isActiveStatus(status) {
  return !inactiveStatuses.includes(String(status || '').toLowerCase());
}

async function activeEmployee(ownerId, employeeId) {
  const employee = await Employee.findOne({
    _id: employeeId,
    owner: ownerId
  }).select('_id name status isAdmin').lean();
  return employee && isActiveStatus(employee.status) ? employee : null;
}

/**
 * Payroll starts as an independent graph. Only explicitly designated employee
 * admins are seeded at its top; no OrgHierarchy/EmployeeHierarchy links leak
 * into this collection.
 */
async function ensureAdminRoots(ownerId) {
  const admins = (await Employee.find({
    owner: ownerId,
    isAdmin: true
  }).select('_id status').sort({ createdAt: 1 }).lean())
    .filter((employee) => isActiveStatus(employee.status));

  for (const admin of admins) {
    const existing = await PayrollHierarchy.findOne({
      owner: ownerId,
      employee: admin._id
    }).select('_id').lean();

    if (!existing) {
      await PayrollHierarchy.create({
        owner: ownerId,
        employee: admin._id,
        senior: null,
        relation: 'Payroll Approver',
        hierarchyLevel: 0,
        path: String(admin._id),
        rootManager: admin._id
      });
    }
  }

  return admins;
}

async function rebuildHierarchy(ownerId) {
  const nodes = await PayrollHierarchy.find({ owner: ownerId })
    .select('employee senior')
    .lean();
  if (!nodes.length) return;

  const byEmployee = new Map(nodes.map((node) => [String(node.employee), node]));
  const children = new Map();
  for (const node of nodes) {
    if (!node.senior) continue;
    const parentId = String(node.senior);
    if (!children.has(parentId)) children.set(parentId, []);
    children.get(parentId).push(String(node.employee));
  }

  const roots = nodes.filter(
    (node) => !node.senior || !byEmployee.has(String(node.senior))
  );
  const visited = new Set();

  async function walk(employeeId, level, path, rootId) {
    if (visited.has(employeeId)) return;
    visited.add(employeeId);

    await PayrollHierarchy.updateOne(
      { owner: ownerId, employee: employeeId },
      {
        $set: {
          hierarchyLevel: level,
          path: path.join('.'),
          rootManager: rootId,
          ...(level === 0 ? { senior: null } : {})
        }
      }
    );

    for (const childId of children.get(employeeId) || []) {
      await walk(childId, level + 1, [...path, childId], rootId);
    }
  }

  for (const root of roots) {
    const rootId = String(root.employee);
    await walk(rootId, 0, [rootId], rootId);
  }
}

async function createsCycle(ownerId, seniorId, juniorId) {
  let current = String(seniorId);
  const seen = new Set();
  while (current && !seen.has(current)) {
    if (current === String(juniorId)) return true;
    seen.add(current);
    const node = await PayrollHierarchy.findOne({
      owner: ownerId,
      employee: current
    }).select('senior').lean();
    current = node?.senior ? String(node.senior) : '';
  }
  return false;
}

async function linkJunior(ownerId, seniorId, juniorId, relation) {
  if (!seniorId || !juniorId) throw new Error('seniorId and juniorId are required');
  if (String(seniorId) === String(juniorId)) {
    throw new Error('Self-referencing payroll hierarchy is not allowed');
  }

  await ensureAdminRoots(ownerId);
  const [senior, junior, existingSeniorNode] = await Promise.all([
    activeEmployee(ownerId, seniorId),
    activeEmployee(ownerId, juniorId),
    PayrollHierarchy.findOne({ owner: ownerId, employee: seniorId }).lean()
  ]);
  let seniorNode = existingSeniorNode;

  if (!senior || !junior) throw new Error('Employee not found for this company');
  if (!seniorNode) {
    const root = await PayrollHierarchy.findOne({ owner: ownerId, senior: null })
      .sort({ createdAt: 1 })
      .lean();
    if (!root) throw new Error('An isAdmin payroll root is required before building the hierarchy');
    if (senior.isAdmin) throw new Error('An isAdmin employee must remain at the top of payroll hierarchy');

    await PayrollHierarchy.findOneAndUpdate(
      { owner: ownerId, employee: seniorId },
      {
        senior: root.employee,
        relation: 'Payroll Approver',
        hierarchyLevel: 1,
        path: `${root.path}.${seniorId}`,
        rootManager: root.rootManager || root.employee
      },
      { upsert: true, new: true, runValidators: true }
    );
    seniorNode = await PayrollHierarchy.findOne({ owner: ownerId, employee: seniorId }).lean();
  }
  if (junior.isAdmin) {
    throw new Error('An isAdmin employee must remain at the top of payroll hierarchy');
  }
  if (await createsCycle(ownerId, seniorId, juniorId)) {
    throw new Error('Circular payroll hierarchy detected');
  }

  const link = await PayrollHierarchy.findOneAndUpdate(
    { owner: ownerId, employee: juniorId },
    {
      senior: seniorId,
      relation: relation || 'Payroll Approver',
      hierarchyLevel: Number(seniorNode.hierarchyLevel || 0) + 1,
      path: `${seniorNode.path}.${juniorId}`,
      rootManager: seniorNode.rootManager || seniorNode.employee
    },
    { upsert: true, new: true, runValidators: true }
  );

  await rebuildHierarchy(ownerId);
  return link;
}

exports.getHierarchy = async (req, res) => {
  try {
    const ownerId = req.user.owner || req.user._id;
    await ensureAdminRoots(ownerId);
    await rebuildHierarchy(ownerId);

    const records = await PayrollHierarchy.find({ owner: ownerId })
      .populate('employee', 'name status designation department photographUrl isAdmin')
      .sort({ hierarchyLevel: 1, createdAt: 1 })
      .lean();

    const active = records.filter(
      (record) => record.employee && isActiveStatus(record.employee.status)
    );
    const map = new Map();
    for (const record of active) {
      map.set(String(record.employee._id), {
        id: String(record.employee._id),
        name: record.employee.name,
        designation: record.employee.designation,
        department: record.employee.department,
        photographUrl: record.employee.photographUrl,
        isAdmin: !!record.employee.isAdmin,
        children: []
      });
    }

    const roots = [];
    for (const record of active) {
      const employeeId = String(record.employee._id);
      const node = map.get(employeeId);
      const parent = record.senior ? map.get(String(record.senior)) : null;
      if (parent) parent.children.push(node);
      else roots.push(node);
    }

    res.json({ status: 'success', data: roots });
  } catch (error) {
    console.error('Get payroll hierarchy error:', error);
    res.status(500).json({ status: 'error', message: error.message || 'Failed to load payroll hierarchy' });
  }
};

exports.create = async (req, res) => {
  try {
    const ownerId = req.user.owner || req.user._id;
    const { seniorId, juniorId, relation } = req.body;
    const link = await linkJunior(ownerId, seniorId, juniorId, relation);
    res.status(201).json({ status: 'success', data: link });
  } catch (error) {
    res.status(400).json({ status: 'error', message: error.message });
  }
};

exports.bulkCreate = async (req, res) => {
  try {
    const ownerId = req.user.owner || req.user._id;
    const { links } = req.body;
    if (!Array.isArray(links) || !links.length) {
      return res.status(400).json({ status: 'error', message: 'Links must be a non-empty array' });
    }

    const saved = [];
    for (const item of links) {
      saved.push(await linkJunior(
        ownerId,
        item.seniorId,
        item.juniorId,
        item.relation
      ));
    }
    res.json({ status: 'success', data: saved });
  } catch (error) {
    res.status(400).json({ status: 'error', message: error.message });
  }
};

exports.deleteHierarchy = async (req, res) => {
  try {
    const ownerId = req.user.owner || req.user._id;
    const juniorId = req.params.id;
    const node = await PayrollHierarchy.findOne({ owner: ownerId, employee: juniorId }).lean();
    if (!node) return res.status(404).json({ status: 'error', message: 'Payroll hierarchy relationship not found' });

    const employee = await activeEmployee(ownerId, juniorId);
    if (employee?.isAdmin) {
      return res.status(400).json({ status: 'error', message: 'The payroll hierarchy admin root cannot be removed' });
    }

    const descendants = await PayrollHierarchy.find({
      owner: ownerId,
      path: { $regex: `(^|\\.)${String(juniorId)}(\\.|$)` }
    }).select('_id').lean();
    await PayrollHierarchy.deleteMany({
      _id: { $in: [node._id, ...descendants.map((item) => item._id)] }
    });
    await rebuildHierarchy(ownerId);

    res.json({ status: 'success', message: 'Payroll hierarchy branch removed' });
  } catch (error) {
    console.error('Delete payroll hierarchy error:', error);
    res.status(500).json({ status: 'error', message: error.message || 'Failed to remove payroll hierarchy relationship' });
  }
};

exports.getManagementChain = async (req, res) => {
  try {
    const ownerId = req.user.owner || req.user._id;
    await ensureAdminRoots(ownerId);
    const chain = [];
    let current = await PayrollHierarchy.findOne({
      owner: ownerId,
      employee: req.params.employeeId
    }).lean();

    while (current?.senior) {
      const senior = await Employee.findById(current.senior)
        .select('_id name designation department photographUrl isAdmin')
        .lean();
      if (!senior) break;
      chain.push(senior);
      current = await PayrollHierarchy.findOne({ owner: ownerId, employee: senior._id }).lean();
    }
    res.json({ status: 'success', data: chain });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
};

exports.linkJunior = linkJunior;
