const express = require('express');
const router = express.Router();
const { Types } = require('mongoose');

const Employee = require('../models/Employees');
const LoanDetail = require('../models/LoanDetail');
const SalarySlip = require('../models/SalarySlip');
const { encrypt } = require('../utils/encryption'); // <-- Import your real async encrypt!

const monthsList = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"
];

// Helper: Get month start/end as Date objects (works with monthIndex: 0-11)
function getMonthDateRange(year, monthIndex) {
  if (typeof monthIndex !== 'number' || monthIndex < 0 || monthIndex > 11) throw new Error("Invalid month index");
  const start = new Date(year, monthIndex, 1, 0, 0, 0, 0);
  const end = new Date(year, monthIndex + 1, 0, 23, 59, 59, 999);
  return { start, end };
}

// 1. Get all employees
router.get('/employees', async (req, res) => {
  try {
    const employees = await Employee.find().select('_id name');
    res.json({ employees });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch employees" });
  }
});

// 2. Get all loan details for one employee
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
      scheduleStartMonth, // index 0-11
      scheduleStartYear,
      monthlyInstallment,
      totalMarkup,
      totalToBePaid,
      paymentSchedule
    } = req.body;

    // Save or update loan for the same employee, month, year
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

    // --- Update SalarySlip for this employee/month ---
    const { start, end } = getMonthDateRange(scheduleStartYear, scheduleStartMonth);
    const salarySlip = await SalarySlip.findOne({
      employee: employeeId,
      updatedAt: { $gte: start, $lte: end }
    });

    // Calculate total of all monthlyInstallments for this employee/month
    const allLoans = await LoanDetail.find({
      employee: employeeId,
      scheduleStartMonth,
      scheduleStartYear
    });
    const totalOtherLoans = allLoans.reduce((sum, l) => sum + (l.monthlyInstallment || 0), 0);

    if (salarySlip) {
      if (!salarySlip.loanDeductions) salarySlip.loanDeductions = {};
      salarySlip.loanDeductions.otherLoans = await encrypt(totalOtherLoans.toString());
      salarySlip.loanDeductions.vehicleLoan = "0";
      salarySlip.gratuityFundDeduction = ""; // Top-level field in SalarySlip schema
      await salarySlip.save();
    }

    res.json(loan);
  } catch (err) {
    console.error(err);
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