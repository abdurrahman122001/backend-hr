// src/controllers/departmentsController.js

const Department = require('../models/Departments');

// GET all departments for an owner
exports.getDepartments = async (req, res) => {
  try {
    // use req.user._id if you have authentication middleware
    const ownerId = req.user?._id || req.query.owner; // fallback for testing
    if (!ownerId) return res.status(400).json({ error: "Owner required" });
    const departments = await Department.find({ owner: ownerId }).sort({ createdAt: -1 });
    res.json(departments);
  } catch (err) {
    res.status(500).json({ error: 'Failed to get departments.' });
  }
};

// CREATE a new department
exports.createDepartment = async (req, res) => {
  try {
    // use req.user._id if available
    const owner = req.user?._id || req.body.owner;
    const { name } = req.body;
    if (!name || !owner) {
      return res.status(400).json({ error: 'Name and owner are required.' });
    }
    // Will throw on duplicate due to unique index
    const department = new Department({ name, owner });
    await department.save();
    res.status(201).json(department);
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ error: 'Department with this name already exists for this owner.' });
    }
    res.status(500).json({ error: 'Failed to create department.' });
  }
};

// UPDATE a department
exports.updateDepartment = async (req, res) => {
  try {
    const { id } = req.params;
    const { name } = req.body;
    // Get department and owner
    const department = await Department.findById(id);
    if (!department) return res.status(404).json({ error: 'Department not found.' });
    department.name = name;
    try {
      await department.save();
      res.json(department);
    } catch (err) {
      if (err.code === 11000) {
        return res.status(409).json({ error: 'Department with this name already exists for this owner.' });
      }
      throw err;
    }
  } catch (err) {
    res.status(500).json({ error: 'Failed to update department.' });
  }
};

// DELETE a department
exports.deleteDepartment = async (req, res) => {
  try {
    const { id } = req.params;
    const department = await Department.findByIdAndDelete(id);
    if (!department) {
      return res.status(404).json({ error: 'Department not found.' });
    }
    res.json({ message: 'Department deleted.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete department.' });
  }
};
