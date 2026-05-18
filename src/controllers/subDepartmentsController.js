const SubDepartment = require('../models/SubDepartments');

// GET all sub-departments for an owner or department
exports.getSubDepartments = async (req, res) => {
  try {
    const ownerId = req.user?._id || req.query.owner;
    if (!ownerId) return res.status(400).json({ error: "Owner required" });
    
    const filter = { owner: ownerId };
    if (req.query.department) {
      filter.department = req.query.department;
    }
    
    const subDepartments = await SubDepartment.find(filter)
      .populate('department', 'name')
      .sort({ order: 1 });
      
    res.json(subDepartments);
  } catch (err) {
    res.status(500).json({ error: 'Failed to get sub-departments.' });
  }
};

// CREATE a new sub-department
exports.createSubDepartment = async (req, res) => {
  try {
    const owner = req.user?._id || req.body.owner;
    const { name, department, designations } = req.body;
    if (!name || !owner || !department) {
      return res.status(400).json({ error: 'Name, owner, and parent department are required.' });
    }
    if (designations && (!Array.isArray(designations) || designations.some(d => typeof d !== 'string'))) {
      return res.status(400).json({ error: 'Designations must be an array of strings.' });
    }
    const subDepartment = new SubDepartment({
      name,
      owner,
      department,
      designations: designations || []
    });
    await subDepartment.save();
    const populated = await subDepartment.populate('department', 'name');
    res.status(201).json(populated);
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ error: 'Sub-department with this name already exists in this department.' });
    }
    res.status(500).json({ error: 'Failed to create sub-department.' });
  }
};

// UPDATE a sub-department
exports.updateSubDepartment = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, department, designations } = req.body;
    const subDepartment = await SubDepartment.findById(id);
    if (!subDepartment) return res.status(404).json({ error: 'Sub-department not found.' });
    
    if (name) subDepartment.name = name;
    if (department) subDepartment.department = department;
    if (designations) {
      if (!Array.isArray(designations) || designations.some(d => typeof d !== 'string')) {
        return res.status(400).json({ error: 'Designations must be an array of strings.' });
      }
      subDepartment.designations = designations;
    }
    try {
      await subDepartment.save();
      const populated = await subDepartment.populate('department', 'name');
      res.json(populated);
    } catch (err) {
      if (err.code === 11000) {
        return res.status(409).json({ error: 'Sub-department with this name already exists in this department.' });
      }
      throw err;
    }
  } catch (err) {
    res.status(500).json({ error: 'Failed to update sub-department.' });
  }
};

// DELETE a sub-department
exports.deleteSubDepartment = async (req, res) => {
  try {
    const { id } = req.params;
    const subDepartment = await SubDepartment.findByIdAndDelete(id);
    if (!subDepartment) {
      return res.status(404).json({ error: 'Sub-department not found.' });
    }
    res.json({ message: 'Sub-department deleted.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete sub-department.' });
  }
};

// BULK UPDATE sub-departments order
exports.reorderSubDepartments = async (req, res) => {
  try {
    const { subDepartments } = req.body; // [{ _id, order }]
    if (!subDepartments || !Array.isArray(subDepartments)) {
      return res.status(400).json({ error: 'Sub-departments array required.' });
    }
    const bulkOps = subDepartments.map(subDep => ({
      updateOne: {
        filter: { _id: subDep._id },
        update: { $set: { order: subDep.order } }
      }
    }));
    await SubDepartment.bulkWrite(bulkOps);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to reorder sub-departments.' });
  }
};
