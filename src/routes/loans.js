const express = require('express');
const router = express.Router();
const { Types } = require('mongoose');

const Employee = require('../models/Employees');
const LoanDetail = require('../models/LoanDetail');

// Helper for months (for older data without dueDate)
const monthsList = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"
];

// 1. Get all employees (utility)
router.get('/employees', async (req, res) => {
  try {
    const employees = await Employee.find().select('_id name');
    res.json({ employees });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch employees" });
  }
});

// 2. Get ALL loan details for ONE employee (array)
router.get('/', async (req, res) => {
  try {
    const { employee } = req.query;
    if (!employee)
      return res.status(400).json({ message: "Employee ID is required" });
    if (!Types.ObjectId.isValid(employee))
      return res.status(400).json({ message: "Invalid employee ID" });

    const loans = await LoanDetail.find({ employee }).lean();

    res.json({ loans });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// 3. Save or update loan detail for one employee (add or replace by start month & year)
router.post('/loan/:employeeId', async (req, res) => {
  try {
    const { employeeId } = req.params;
    if (!Types.ObjectId.isValid(employeeId))
      return res.status(400).json({ message: "Invalid employee ID" });

    const {
      type,
      loanAmount,
      loanTerm,
      markupType,
      markupValue,
      scheduleStartMonth,
      scheduleStartYear,
      monthlyInstallment,
      totalMarkup,
      totalToBePaid,
      paymentSchedule
    } = req.body;

    // Only update loan for same employee, same start month and year
    let loan = await LoanDetail.findOne({ 
      employee: employeeId, 
      scheduleStartMonth, 
      scheduleStartYear 
    });

    if (loan) {
      loan.type = type;
      loan.loanAmount = loanAmount;
      loan.loanTerm = loanTerm;
      loan.markupType = markupType;
      loan.markupValue = markupValue;
      loan.scheduleStartMonth = scheduleStartMonth;
      loan.scheduleStartYear = scheduleStartYear;
      loan.monthlyInstallment = monthlyInstallment;
      loan.totalMarkup = totalMarkup;
      loan.totalToBePaid = totalToBePaid;
      loan.paymentSchedule = paymentSchedule;
      await loan.save();
    } else {
      loan = await LoanDetail.create({
        employee: employeeId,
        type,
        loanAmount,
        loanTerm,
        markupType,
        markupValue,
        scheduleStartMonth,
        scheduleStartYear,
        monthlyInstallment,
        totalMarkup,
        totalToBePaid,
        paymentSchedule
      });
    }
    res.json(loan);
  } catch (err) {
    res.status(500).json({ error: "Failed to save loan", details: err.message });
  }
});

// 4. Get single loan detail (by loan id)
router.get('/loan-detail/:loanId', async (req, res) => {
  try {
    const { loanId } = req.params;
    if (!Types.ObjectId.isValid(loanId))
      return res.status(400).json({ message: "Invalid loan ID" });
    const loan = await LoanDetail.findById(loanId).populate('employee', 'name');
    res.json(loan);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch loan", details: err.message });
  }
});

module.exports = router;
