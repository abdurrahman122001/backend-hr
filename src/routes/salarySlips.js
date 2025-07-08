// backend/src/routes/salarySlips.js
const express     = require('express');
const PDFDocument = require('pdfkit');
const router      = express.Router();
const requireAuth = require('../middleware/auth');
const SalarySlip  = require('../models/SalarySlip');
const Employee    = require('../models/Employees');
const { encrypt, decrypt } = require("../utils/encryption");

// List of all allowance fields [Label, modelKey]
const allowances = [
  ['Basic Pay', 'basic'],
  ['Dearness Allowance', 'dearnessAllowance'],
  ['House Rent Allowance', 'houseRentAllowance'],
  ['Conveyance Allowance', 'conveyanceAllowance'],
  ['Medical Allowance', 'medicalAllowance'],
  ['Utility Allowance', 'utilityAllowance'],
  ['Overtime Compensation', 'overtimeComp'],
  ['Dislocation Allowance', 'dislocationAllowance'],
  ['Leave Encashment', 'leaveEncashment'],
  ['Bonus', 'bonus'],
  ['Arrears', 'arrears'],
  ['Auto Allowance', 'autoAllowance'],
  ['Incentive', 'incentive'],
  ['Fuel Allowance', 'fuelAllowance'],
  ['Other Allowances', 'othersAllowances'],
];

// List of all deduction fields [Label, modelKey]
const deductions = [
  ['Leave Deduction', 'leaveDeductions'],
  ['Late Deduction', 'lateDeductions'],
  ['EOBI Deduction', 'eobiDeduction'],
  ['SESSI Deduction', 'sessiDeduction'],
  ['Provident Fund Deduction', 'providentFundDeduction'],
  ['Gratuity Fund Deduction', 'gratuityFundDeduction'],
  ['Vehicle Loan Deduction', 'vehicleLoanDeduction'],
  ['Other Loan Deduction', 'otherLoanDeductions'],
  ['Advance Salary Deduction', 'advanceSalaryDeduction'],
  ['Medical Insurance', 'medicalInsurance'],
  ['Life Insurance', 'lifeInsurance'],
  ['Penalties', 'penalties'],
  ['Other Deduction', 'otherDeductions'],
  ['Tax Deduction', 'taxDeduction'],
];

// Utility: Calculate net salary
function calcNet(slip) {
  const totalAllow = allowances.reduce((sum, [, key]) => sum + (Number(slip[key]) || 0), 0);
  const totalDed  = deductions.reduce((sum, [, key]) => sum + (Number(slip[key]) || 0), 0);
  return totalAllow - totalDed;
}

// ---------- GET salary slips (all or filtered by employee) ----------
router.get('/', requireAuth, async (req, res) => {
  try {
    const { employee } = req.query; // ?employee=xxx
    let query = {};
    if (employee) query.employee = employee;
    const slips = await SalarySlip
      .find(query)
      .populate('employee')
      .sort({ createdAt: -1 });

    // Add netSalary to each slip (virtual, not saved in DB)
    const slipsWithNet = slips.map(slip => {
      const slipObj = slip.toObject();
      slipObj.netSalary = calcNet(slipObj);
      return slipObj;
    });

    res.json({ slips: slipsWithNet });
  } catch (err) {
    console.error(err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});


router.patch('/:id', requireAuth, async (req, res) => {
  try {
    const allowedFields = [
      ...allowances.map(([_, key]) => key),
      ...deductions.map(([_, key]) => key),
      // add more updatable fields if needed
    ];

    // --- 1. Get encryption key (from frontend or user context) ---
    const encryptionKey = req.body.encryptionKey || process.env.ENCRYPTION_KEY;
    if (!encryptionKey) {
      return res.status(400).json({ status: 'error', message: 'No encryption key provided.' });
    }

    const updates = {};
    for (let key of Object.keys(req.body)) {
      if (allowedFields.includes(key)) {
        let value = req.body[key];
        // --- 2. Encrypt if not in 'iv:encrypted' format ---
        if (typeof value === "string" && value.includes(":")) {
          // Assume already encrypted
          updates[key] = value;
        } else {
          updates[key] = encrypt(value, encryptionKey);
        }
      }
    }
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ status: 'error', message: 'No valid fields to update.' });
    }

    const slip = await SalarySlip.findByIdAndUpdate(
      req.params.id,
      { $set: updates },
      { new: true }
    ).populate('employee');

    if (!slip) {
      return res.status(404).json({ status: 'error', message: 'Salary slip not found.' });
    }

    // Add netSalary to response (optional: decrypt first, recalc net)
    const slipObj = slip.toObject();
    slipObj.netSalary = calcNet(slipObj);

    res.json({ status: 'success', slip: slipObj });
  } catch (err) {
    console.error(err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ---------- GET: Download Salary Slip PDF ----------
router.get('/:id/download', requireAuth, async (req, res) => {
  try {
    const slip = await SalarySlip
      .findById(req.params.id)
      .populate('employee');

    if (!slip) {
      return res.status(404).json({ status: 'error', message: 'Not found' });
    }

    // Setup PDF
    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    res.setHeader('Content-Type', 'application/pdf');
    const month = slip.createdAt.toISOString().slice(0, 7);
    const filename = `SalarySlip-${slip.employee.name.replace(/ /g, '')}-${month}.pdf`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    doc.pipe(res);

    // — HEADER —
    doc
      .font('Helvetica-Bold')
      .fontSize(18)
      .text('Mavens Advisor (PVT) Limited', { align: 'center' })
      .moveDown(0.2)
      .font('Helvetica')
      .fontSize(10)
      .text('Head Office • Karachi, Pakistan', { align: 'center' })
      .moveDown(1.5);

    // — EMPLOYEE DETAILS —
    doc
      .font('Helvetica-Bold')
      .fontSize(12)
      .text('Employee Details', 40, doc.y)
      .moveDown(0.5);

    const y0 = doc.y;
    doc.font('Helvetica').fontSize(10)
      .text(`Name: ${slip.employee.name}`, 40, y0)
      .text(`Department: ${slip.employee.department}`, 320, y0)
      .text(`Designation: ${slip.employee.designation}`, 40, y0 + 15)
      .text(`Joining Date: ${slip.employee.joiningDate ? slip.employee.joiningDate.toISOString().slice(0, 10) : ''}`, 320, y0 + 15)
      .moveDown(2);

    // — SALARY & ALLOWANCES vs DEDUCTIONS —
    const col1X = 40;
    const col2X = 320;
    const startY = doc.y;

    // Table headers
    doc
      .font('Helvetica-Bold')
      .fontSize(11)
      .text('Salary & Allowances', col1X, startY)
      .text('Deductions', col2X, startY);

    // Rows
    const rowHeight = 18;
    const rows = Math.max(allowances.length, deductions.length);

    // Totals
    let totalAllow = 0;
    let totalDeduct = 0;

    for (let i = 0; i < rows; i++) {
      const y = startY + 20 + i * rowHeight;
      doc.font('Helvetica').fontSize(10);

      // Allowances column
      if (allowances[i]) {
        const [label, key] = allowances[i];
        const val = slip[key] || 0;
        totalAllow += val;
        doc.text(label, col1X, y);
        doc.text(val.toFixed(2), col1X + 150, y, { width: 60, align: 'right' });
      }
      // Deductions column
      if (deductions[i]) {
        const [label, key] = deductions[i];
        const val = slip[key] || 0;
        totalDeduct += val;
        doc.text(label, col2X, y);
        doc.text(val.toFixed(2), col2X + 150, y, { width: 60, align: 'right' });
      }
    }

    // — NET PAYABLE —
    const net = totalAllow - totalDeduct;
    doc.moveDown(2);
    doc
      .font('Helvetica-Bold')
      .fontSize(14)
      .text(`Net Payable: ${net.toFixed(2)}`, { align: 'right' });

    doc.end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

module.exports = router;
