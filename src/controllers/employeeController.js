const Employee = require('../models/Employees');

// GET /api/employees
exports.getAllEmployees = async (req, res) => {
  try {
    const list = await Employee
      .find({ owner: req.user._id })      // ← only this user’s employees
      .sort({ name: 1 })
      .populate('shifts', 'name')
      .lean();
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.list = async (req, res) => {
  try {
    const emps = await Employee
      .find({ owner: req.user._id })
      .select('-owner')
      .populate('shifts', 'name')
      .sort({ name: 1 })
      .lean();
    res.json({ status: 'success', data: emps });
  } catch (err) {
    console.error(err);
    res.status(500).json({ status: 'error', message: err.message });
  }
};


// POST /api/employees
exports.createEmployee = async (req, res) => {
  try {
    const body = req.body;
    const emp = await Employee.create({
      owner:           req.user._id,
      name:            body.name,
      phone:           body.phone,
      qualification:   body.qualification,
      presentAddress:  body.presentAddress,
      maritalStatus:   body.maritalStatus,
      nomineeName:     body.nomineeName,
      emergencyContact:body.emergencyContact,

      department:      body.department,
      position:        body.position,
      joiningDate:     body.joiningDate,
      cnic:            body.cnic,
      dateOfBirth:    body.dateOfBirth,
      bankAccount:     body.bankAccount,

      email:           body.email,
      companyEmail:    body.companyEmail,
      rt:              body.rt,
      salaryOffered:   body.salaryOffered,
      leaveEntitlement:body.leaveEntitlement,
    });
    await emp.save();
    res.status(201).json(emp);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};
// PATCH /api/employees/:id
exports.updateEmployee = async (req, res) => {
  try {
    // Only allow updates to employees owned by the current user
    const emp = await Employee.findOneAndUpdate(
      { _id: req.params.id, owner: req.user._id }, // match by id + owner
      req.body,                                    // update with incoming fields
      { new: true, runValidators: true }
    ).populate('shifts', 'name'); // optional: re-populate shifts for fresh data

    if (!emp) {
      return res.status(404).json({ error: 'Employee not found or unauthorized' });
    }

    res.json(emp);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};
