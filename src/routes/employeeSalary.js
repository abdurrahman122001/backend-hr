// routes/employeeSalary.js
const express = require('express');
const router = express.Router();
const controller = require('../controllers/employeeSalaryController');

// Fetch employee + latest salary slip
router.get('/:id', controller.getEmployeeAndSalarySlip);

// Update employee + latest salary slip
router.put('/:id', controller.updateEmployeeAndSalarySlip);

module.exports = router;
