// backend/src/routes/employees.js
const express  = require('express');
const router   = express.Router();

const Employee = require('../models/Employees');
const { getAllEmployees, createEmployee, updateEmployee, list , getUpcomingBirthdays } = require('../controllers/employeeController');

// --- Helper for correct owner matching (move to utils if needed) ---
function getEffectiveOwnerId(user) {
  if (user.role === "admin" && user.createdBy) {
    return user.createdBy;
  }
  return user._id;
}

// Middleware to check authentication and set req.user (should already be in app, if not add here)
const requireAuth = require('../middleware/auth');

// Use requireAuth for all routes
router.use(requireAuth);

// GET /api/employees
router.get('/', async (req, res) => {
  try {
    const ownerId = getEffectiveOwnerId(req.user);
    const list = await Employee.find({ owner: { $in: [ownerId] } }).sort({ name: 1 }).lean();
    res.json({ status: 'success', data: list });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

router.get('/birthdays', getUpcomingBirthdays);

// GET /api/employees/names
router.get('/names', async (req, res) => {
  try {
    const ownerId = getEffectiveOwnerId(req.user);
    const docs = await Employee
      .find({ owner: { $in: [ownerId] } })
      .sort({ name: 1 })
      .select('_id name')
      .lean();
    res.json({ status: 'success', data: docs });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// POST /api/employees
router.post('/', async (req, res) => {
  const { name, position, department, email, rt, salaryOffered, leaveEntitlement } = req.body;
  if (!name || !position || !department || !email) {
    return res.status(400).json({ status: 'error', message: 'Missing required fields' });
  }
  try {
    const ownerId = getEffectiveOwnerId(req.user);
    const emp = await Employee.create({
      owner: [ownerId],
      name,
      position,
      department,
      email,
      rt,
      salaryOffered,
      leaveEntitlement
    });
    res.json({ status: 'success', data: emp });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// GET /api/employees/list
router.get('/list', async (req, res) => {
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
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// GET /api/employees/:id
router.get('/:id', async (req, res) => {
  try {
    const ownerId = getEffectiveOwnerId(req.user);
    const emp = await Employee.findOne({
      _id: req.params.id,
      owner: { $in: [ownerId] }, // match array owner
    }).lean();
    if (!emp) return res.status(404).json({ error: 'Employee not found' });
    res.json({ status: 'success', employee: emp });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/employees/:id
router.patch('/:id', async (req, res) => {
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
});
// GET /api/employees/birthdays
module.exports = router;
