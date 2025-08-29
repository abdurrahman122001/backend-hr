// routes/employeeSalary.js
const express = require('express');
const router = express.Router();
const controller = require('../controllers/employeeSalaryController');

// Fetch employee + latest salary slip
router.get('/:id', controller.getEmployeeAndSalarySlip);

// Update employee + latest salary slip
router.put('/:id', controller.updateEmployeeAndSalarySlip);
router.post("/:id/send-complete-profile", controller.resendCompleteProfileLink);

module.exports = router;
