// backend/src/routes/employees.js
const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');

const Employee = require('../models/Employees');
const requireAuth = require('../middleware/auth');
const { getUpcomingBirthdays } = require('../controllers/employeeController');

// ------------------------------
// Helpers
// ------------------------------
/**
 * Resolve the effective tenant/owner id for the current user.
 * Priority: explicit user.owner -> user.createdBy -> user._id
 */
function getEffectiveOwnerId(user) {
  return user?.owner || user?.createdBy || user?._id;
}

/**
 * Backward-compatible scope:
 * Match employees when EITHER
 *  - owner array contains ownerId OR userId
 *  - OR createdBy equals ownerId OR userId
 */
function buildEmployeeScope(user) {
  const ownerId = getEffectiveOwnerId(user);
  const userId = user?._id;
  return {
    $or: [
      { owner: { $in: [ownerId, userId] } },
      { createdBy: { $in: [ownerId, userId] } },
    ],
  };
}

// ------------------------------
// GET /api/employees
// Fetch employees by owner OR createdBy (both supported)
// ------------------------------
router.get('/', requireAuth, async (req, res) => {
  try {
    const scope = buildEmployeeScope(req.user);

    let query = { ...scope };

    // If req._id is provided, filter by that as well
    if (req._id) {
      query._id = req._id;
    }

    const list = await Employee.find(query).sort({ name: 1 }).lean();
    res.json({ status: 'success', data: list });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});


// ------------------------------
// GET /api/employees/birthdays
// (delegates to controller)
// ------------------------------
router.get('/birthdays', requireAuth, getUpcomingBirthdays);

// ------------------------------
// GET /api/employees/names
// Minimal payload (id + name) with the same scope
// ------------------------------
router.get('/names', requireAuth, async (req, res) => {
  try {
    const scope = buildEmployeeScope(req.user);
    const docs = await Employee.find(scope).sort({ name: 1 }).select('_id name').lean();
    res.json({ status: 'success', data: docs });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ------------------------------
// POST /api/employees
// Create employee and record BOTH owner and createdBy
// (owner = effective tenant id, createdBy = current user id)
// ------------------------------
router.post('/', requireAuth, async (req, res) => {
  const {
    name,
    position,
    department,
    email,
    rt,
    salaryOffered,
    leaveEntitlement,
    photographUrl,
    // optional extras (kept for compatibility—send any that you use)
    phone,
    qualification,
    presentAddress,
    maritalStatus,
    nomineeName,
    emergencyContact,
    joiningDate,
    cnic,
    dateOfBirth,
    bankAccount,
    companyEmail,
    shifts, // optional: array of ObjectIds
  } = req.body;

  if (!name || !position || !department || !email) {
    return res.status(400).json({ status: 'error', message: 'Missing required fields' });
  }

  try {
    const ownerId = getEffectiveOwnerId(req.user);

    const emp = await Employee.create({
      owner: [ownerId],          // tenant/HR id (array as per your schema)
      createdBy: req.user._id,   // who created this employee
      name,
      position,
      department,
      email,
      companyEmail,
      phone,
      qualification,
      presentAddress,
      maritalStatus,
      nomineeName,
      emergencyContact,
      joiningDate,
      cnic,
      dateOfBirth,
      bankAccount,
      rt,
      salaryOffered,
      leaveEntitlement,
      photographUrl,
      shifts,
    });

    res.status(201).json({ status: 'success', data: emp });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ------------------------------
// GET /api/employees/list
// Same scope; includes shift names
// ------------------------------
router.get('/list', requireAuth, async (req, res) => {
  try {
    const scope = buildEmployeeScope(req.user);
    const emps = await Employee
      .find(scope)
      .select('-owner')
      .populate('shifts', 'name')
      .sort({ name: 1 })
      .lean();

    res.json({ status: 'success', data: emps });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ------------------------------
// GET /api/employees/:id
// Scoped by owner OR createdBy
// ------------------------------
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ status: 'error', message: 'Invalid employee id' });
    }

    const scope = buildEmployeeScope(req.user);
    const emp = await Employee.findOne({ _id: id, ...scope }).lean();

    if (!emp) return res.status(404).json({ error: 'Employee not found' });
    res.json({ status: 'success', employee: emp });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ------------------------------
// PATCH /api/employees/:id
// Scoped update by owner OR createdBy
// ------------------------------
router.patch('/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ status: 'error', message: 'Invalid employee id' });
    }

    const scope = buildEmployeeScope(req.user);
    const emp = await Employee.findOneAndUpdate(
      { _id: id, ...scope },
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
});

module.exports = router;
