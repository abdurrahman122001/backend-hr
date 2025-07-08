const Hierarchy = require('../models/EmployeeHierarchy');
const Employee = require('../models/Employees');

/**
 * Helper: look for any path from `seniorId` down to `juniorId`.
 */
async function checkForCircularReference(ownerId, seniorId, juniorId) {
  const result = await Hierarchy.aggregate([
    { $match: { owner: ownerId } },
    {
      $graphLookup: {
        from: 'employeehierarchies',
        startWith: seniorId,
        connectFromField: 'senior',
        connectToField: 'junior',
        as: 'managementChain',
        depthField: 'depth'
      }
    },
    { $unwind: '$managementChain' },
    { $match: { 'managementChain.junior': juniorId } }
  ]);
  return result.length > 0;
}

exports.create = async (req, res) => {
  try {
    const { seniorId, juniorId, relation } = req.body;
    const ownerId = req.user._id;

    // 1) required
    if (!seniorId || !juniorId) {
      return res.status(400).json({ status: 'error',
        message: 'Both seniorId and juniorId are required' });
    }

    // 2) both employees exist?
    const [senior, junior] = await Promise.all([
      Employee.findById(seniorId),
      Employee.findById(juniorId)
    ]);
    if (!senior || !junior) {
      return res.status(404).json({ status: 'error',
        message: 'One or both employees not found' });
    }

    // 3) no self-link
    if (seniorId === juniorId) {
      return res.status(400).json({ status: 'error',
        message: 'Cannot create relationship with self' });
    }

    // 4) no duplicate
    if (await Hierarchy.exists({ owner: ownerId, senior: seniorId, junior: juniorId })) {
      return res.status(400).json({ status: 'error',
        message: 'Relationship already exists' });
    }

    // 5) no cycle
    if (await checkForCircularReference(ownerId, seniorId, juniorId)) {
      return res.status(400).json({ status: 'error',
        message: 'This relationship would create a circular reference' });
    }

    // 6) create
    const link = await Hierarchy.create({
      owner:      ownerId,
      senior:     seniorId,
      junior:     juniorId,
      relation:   relation || 'Manager'
    });

    res.status(201).json({
      status: 'success',
      data: {
        _id:         link._id,
        senior:      link.senior,
        junior:      link.junior,
        relation:    link.relation,
        hierarchyLevel: link.hierarchyLevel,
        path:        link.path,
        rootManager: link.rootManager
      }
    });

  } catch (err) {
    console.error('Error creating hierarchy:', err);
    res.status(500).json({ status: 'error',
      message: err.message || 'Internal server error' });
  }
};

exports.bulkCreate = async (req, res) => {
  try {
    const { links } = req.body;
    const ownerId = req.user._id;
    if (!Array.isArray(links)) {
      return res.status(400).json({ status: 'error',
        message: 'Links must be an array' });
    }

    const invalid = [];
    // validate each
    for (const { seniorId, juniorId } of links) {
      if (!seniorId || !juniorId) {
        invalid.push({ seniorId, juniorId, reason: 'Missing IDs' });
        continue;
      }
      const [senior, junior] = await Promise.all([
        Employee.findById(seniorId),
        Employee.findById(juniorId)
      ]);
      if (!senior || !junior) {
        invalid.push({ seniorId, juniorId, reason: 'Not found' });
        continue;
      }
      if (seniorId === juniorId) {
        invalid.push({ seniorId, juniorId, reason: 'Self link' });
        continue;
      }
      if (await Hierarchy.exists({ owner: ownerId, senior: seniorId, junior: juniorId })) {
        invalid.push({ seniorId, juniorId, reason: 'Duplicate' });
        continue;
      }
      if (await checkForCircularReference(ownerId, seniorId, juniorId)) {
        invalid.push({ seniorId, juniorId, reason: 'Circular' });
        continue;
      }
    }

    if (invalid.length) {
      return res.status(400).json({
        status: 'error',
        message: 'Some links invalid',
        details: invalid
      });
    }

    // insert all
    const created = await Promise.all(
      links.map(l =>
        Hierarchy.create({
          owner: ownerId,
          senior: l.seniorId,
          junior: l.juniorId,
          relation: l.relation || 'Manager'
        })
      )
    );

    res.status(201).json({
      status: 'success',
      data:   created,
      count:  created.length
    });

  } catch (err) {
    console.error('Bulk create error:', err);
    res.status(500).json({ status: 'error',
      message: 'Failed to bulk create' });
  }
};

exports.getHierarchy = async (req, res) => {
  try {
    const hierarchy = await Hierarchy.getFullHierarchy(req.user._id);
    res.json({ status: 'success', data: hierarchy });
  } catch (err) {
    console.error('Fetch hierarchy error:', err);
    res.status(500).json({ status: 'error',
      message: 'Failed to fetch hierarchy' });
  }
};

exports.getDirectReports = async (req, res) => {
  try {
    const { employeeId } = req.params;
    const reports = await Hierarchy.getDirectReports(req.user._id, employeeId);
    res.json({ status: 'success', data: reports });
  } catch (err) {
    console.error('Direct reports error:', err);
    res.status(500).json({ status: 'error',
      message: 'Failed to fetch direct reports' });
  }
};

exports.getManagementChain = async (req, res) => {
  try {
    const { employeeId } = req.params;
    const chain = await Hierarchy.getManagementChain(req.user._id, employeeId);
    res.json({ status: 'success', data: chain });
  } catch (err) {
    console.error('Management chain error:', err);
    res.status(500).json({ status: 'error',
      message: 'Failed to fetch management chain' });
  }
};

exports.getHierarchy = async function(req, res) {
  try {
    const ownerId = req.user._id;
    // Load all links with populated names
    const links = await Hierarchy.find({ owner: ownerId })
      .populate('senior', 'name')
      .populate('junior', 'name')
      .lean();

    // Build nodes map
    const map = {};
    links.forEach(l => {
      const sid = l.senior._id.toString();
      const jid = l.junior._id.toString();

      if (!map[sid]) {
        map[sid] = { id: sid, name: l.senior.name, children: [] };
      }
      if (!map[jid]) {
        map[jid] = { id: jid, name: l.junior.name, children: [] };
      }
      // Attach junior under senior
      map[sid].children.push(map[jid]);
    });

    // Find roots (those never appearing as a junior)
    const juniorIds = new Set(links.map(l => l.junior._id.toString()));
    const tree = Object.values(map).filter(node => !juniorIds.has(node.id));

    res.json({ status: 'success', data: tree });
  } catch (err) {
    console.error('Error fetching hierarchy tree:', err);
    res.status(500).json({ status: 'error', message: 'Failed to fetch hierarchy' });
  }
};
exports.deleteHierarchy = async (req, res) => {
  try {
    const { id } = req.params;         // juniorId (as per frontend)
    const senior = req.query.senior;   // seniorId (from query param)
    if (!id || !senior) {
      return res.status(400).json({ status: 'error', message: 'junior and senior id required' });
    }

    // owner is available on req.user._id (requireAuth)
    const deleted = await Hierarchy.findOneAndDelete({
      senior,
      junior: id,
      owner: req.user._id,
    });

    if (!deleted) {
      return res.status(404).json({ status: 'error', message: 'Relationship not found' });
    }
    res.json({ status: 'success', message: 'Relationship deleted', data: deleted });
  } catch (err) {
    console.error('Delete hierarchy error:', err);
    res.status(500).json({ status: 'error', message: 'Server error' });
  }
};