// backend/src/routes/employees.js
const express  = require('express');
const router   = express.Router();

const Employee = require('../models/Employees');
const { getAllEmployees, createEmployee, updateEmployee, list } = require('../controllers/employeeController');

router.get('/', async (req, res) => {
  try {
    const list = await Employee.find({ owner: req.user._id }).sort({ name: 1 }).lean();
    res.json({ status: 'success', data: list });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// GET /api/employees/names
router.get('/names', async (req, res) => {
  try {
    const docs = await Employee
      .find({ owner: req.user._id })
      .sort({ name: 1 })
      .select('_id name')
      .lean();
    res.json({ status: 'success', data: docs });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// POST /api/employees/create
router.post('/create', async (req, res) => {
  const { name, position, department, email, rt, salaryOffered, leaveEntitlement } = req.body;
  if (!name || !position || !department || !email) {
    return res.status(400).json({ status: 'error', message: 'Missing required fields' });
  }
  try {
    const emp = await Employee.create({
      owner:           req.user._id,
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

router.get('/', getAllEmployees);
router.post('/', createEmployee);
router.get('/list', list);

// Add this route after all other GETs (before PATCH/POST)
router.get('/:id', async (req, res) => {
  try {
    const emp = await Employee.findOne({
      _id: req.params.id,
      owner: req.user._id, // extra safety: only fetch user's own employees
    }).lean();
    if (!emp) return res.status(404).json({ error: 'Employee not found' });
    res.json({ status: 'success', employee: emp });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


router.patch('/:id', updateEmployee);
module.exports = router;
