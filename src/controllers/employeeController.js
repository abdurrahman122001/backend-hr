// backend/src/controllers/employeeController.js

const Employee = require('../models/Employees');
const dayjs = require('dayjs');

// Helper: Get the "owner" id for data isolation
function getEffectiveOwnerId(user) {
  // If user is an admin created by another admin, return createdBy
  if (user.role === "admin" && user.createdBy) {
    return user.createdBy;
  }
  // Else use their own _id
  return user._id;
}

// Helper: Compute next birthday as a dayjs object
function getNextBirthday(dob) {
  if (!dob) return null;
  let birth = dayjs(dob);
  if (!birth.isValid()) return null;
  const now = dayjs();
  let next = birth.year(now.year());
  if (next.isBefore(now, "day")) next = next.add(1, "year");
  return next;
}

// GET /api/employees
exports.getAllEmployees = async (req, res) => {
  try {
    const ownerId = getEffectiveOwnerId(req.user);
    const list = await Employee
      .find({ owner: { $in: [ownerId] } })
      .sort({ name: 1 })
      .populate('shifts', 'name')
      .lean();
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// GET /api/employees/list
exports.list = async (req, res) => {
  try {
    const ownerId = getEffectiveOwnerId(req.user);
    const emps = await Employee
      .find({ owner: { $in: [ownerId] } })
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
    const ownerId = getEffectiveOwnerId(req.user);
    const body = req.body;
    const emp = await Employee.create({
      owner: [ownerId],
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
      dateOfBirth:     body.dateOfBirth,
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
    const ownerId = getEffectiveOwnerId(req.user);
    const emp = await Employee.findOneAndUpdate(
      { _id: req.params.id, owner: { $in: [ownerId] } },
      req.body,
      { new: true, runValidators: true }
    ).populate('shifts', 'name');

    if (!emp) {
      return res.status(404).json({ error: 'Employee not found or unauthorized' });
    }
    res.json(emp);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

// GET /api/employees/birthdays
exports.getUpcomingBirthdays = async (req, res) => {
  try {
    const ownerId = getEffectiveOwnerId(req.user);
    const employees = await Employee.find({
      owner: { $in: [ownerId] },
      dateOfBirth: { $exists: true, $ne: null, $ne: "" }
    }).select('name dateOfBirth photographUrl email');

    const now = dayjs();
    const upcoming = employees
      .map(emp => {
        const nextBirthday = getNextBirthday(emp.dateOfBirth);
        return nextBirthday
          ? { ...emp.toObject(), nextBirthday }
          : null;
      })
      .filter(Boolean)
      .filter(e => {
        const days = e.nextBirthday.diff(now, 'day');
        return days >= 0 && days <= 30;
      })
      .sort((a, b) => a.nextBirthday.diff(b.nextBirthday));

    res.json(upcoming);
  } catch (err) {
    console.error("Error in getUpcomingBirthdays:", err);
    res.status(500).json({ error: "Could not fetch birthdays: " + err.message });
  }
};
