const Designation = require("../models/Designations");

// GET all designations for owner
exports.getDesignations = async (req, res) => {
  try {
    const designations = await Designation.find();
    res.json(designations);
  } catch (err) {
    res.status(500).json({ error: "Failed to get designations." });
  }
};

exports.createDesignation = async (req, res) => {
  try {
    const { name, department, owner } = req.body;

    // department must be an ObjectId (string is okay, Mongoose will cast)
    const desig = await Designation.create({
      name,
      department,   // <---- MAKE SURE you use this!
      owner,
    });

    res.status(201).json(desig);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

// UPDATE a designation
exports.updateDesignation = async (req, res) => {
  try {
    const { id } = req.params;
    const { name } = req.body;
    const designation = await Designation.findByIdAndUpdate(id, { name }, { new: true });
    if (!designation) {
      return res.status(404).json({ error: "Designation not found." });
    }
    res.json(designation);
  } catch (err) {
    res.status(500).json({ error: "Failed to update designation." });
  }
};

// DELETE a designation
exports.deleteDesignation = async (req, res) => {
  try {
    const { id } = req.params;
    const designation = await Designation.findByIdAndDelete(id);
    if (!designation) {
      return res.status(404).json({ error: "Designation not found." });
    }
    res.json({ message: "Designation deleted." });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete designation." });
  }
};

exports.assignDesignationsToDepartment = async (req, res) => {
  try {
    const { departmentId, designationIds } = req.body;
    if (!departmentId || !Array.isArray(designationIds)) {
      return res.status(400).json({ error: "departmentId & designationIds are required." });
    }
    // 1. Remove department from any designation not in this batch but previously assigned to this department
    await Designation.updateMany(
      { department: departmentId, _id: { $nin: designationIds } },
      { department: null }
    );
    // 2. Assign department to selected designations
    await Designation.updateMany(
      { _id: { $in: designationIds } },
      { department: departmentId }
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Bulk designation assignment failed." });
  }
};