const PayrollPeriod = require('../models/PayrollPeriod');
const Employee = require('../models/Employees');
const SalarySlip = require('../models/SalarySlip');
const dayjs = require('dayjs');

// Create a new payroll period
exports.createPayrollPeriod = async (req, res) => {
  const { name, payrollPeriodType, payrollPeriodStartDay, payrollPeriodLength, shifts } = req.body;

  // Duplicate check
  let exists = null;
  if (payrollPeriodType === 'custom') {
    exists = await PayrollPeriod.findOne({
      owner: req.user._id,
      payrollPeriodType,
      payrollPeriodStartDay,
      payrollPeriodLength,
    });
  } else {
    exists = await PayrollPeriod.findOne({
      owner: req.user._id,
      payrollPeriodType,
      payrollPeriodStartDay,
    });
  }
  if (exists) {
    return res.status(409).json({ error: 'Payroll period already exists for this type and start date.' });
  }

  // Create if not duplicate
  const period = await PayrollPeriod.create({
    owner: req.user._id,
    name: name || null,
    payrollPeriodType,
    payrollPeriodStartDay,
    payrollPeriodLength,
    shifts: shifts || []
  });

  res.status(201).json(period);
};

exports.getPayrollPeriod = async (req, res, next) => {
  const periods = await PayrollPeriod.find({ owner: req.user._id }).sort({ createdAt: -1 }).lean();
  res.json(periods); // Always an array!
};

exports.updatePayrollPeriod = async (req, res, next) => {
  const { id } = req.params;
  const { name, shifts, payrollPeriodType, payrollPeriodStartDay, payrollPeriodLength } = req.body;

  const updateData = {};
  if (name) updateData.name = name;
  if (shifts) updateData.shifts = shifts;
  if (payrollPeriodType) updateData.payrollPeriodType = payrollPeriodType;
  if (payrollPeriodStartDay) updateData.payrollPeriodStartDay = payrollPeriodStartDay;
  if (payrollPeriodLength !== undefined) updateData.payrollPeriodLength = payrollPeriodLength;

  const updated = await PayrollPeriod.findOneAndUpdate(
    { _id: id, owner: req.user._id },
    updateData,
    { new: true }
  ).lean();

  if (!updated) return res.status(404).json({ error: 'Payroll period not found' });
  res.json(updated);
};

exports.deletePayrollPeriod = async (req, res, next) => {
  const { id } = req.params;
  const deleted = await PayrollPeriod.findOneAndDelete({ _id: id, owner: req.user._id });
  if (!deleted) {
    return res.status(404).json({ error: 'Payroll period not found' });
  }
  res.json({ message: 'Payroll period deleted successfully.' });
};

exports.updateNonWorkingDays = async (req, res) => {
  const ownerId = req.user._id;
  const { nonWorkingDays } = req.body;
  if (!Array.isArray(nonWorkingDays)) {
    return res.status(400).json({ error: 'nonWorkingDays must be an array' });
  }

  const result = await PayrollPeriod.updateMany(
    { owner: ownerId },
    { $set: { nonWorkingDays } }
  );

  res.json({ success: true, modifiedCount: result.modifiedCount });
};

exports.getNonWorkingDays = async (req, res) => {
  const ownerId = req.user._id;
  const period = await PayrollPeriod.findOne({ owner: ownerId }).sort({ createdAt: -1 }).lean();
  res.json({ nonWorkingDays: period?.nonWorkingDays || [] });
};

// The CURRENT-STATUS endpoint: returns period, start/end, daysLeft, employees+slips if ended
exports.getCurrentPayrollPeriodStatus = async (req, res) => {
  try {
    const ownerId = req.user._id;
    const today = dayjs();
    // Find the most recent period starting before or on today
    const period = await PayrollPeriod.findOne({
      owner: ownerId,
      payrollPeriodStartDay: { $lte: today.format("YYYY-MM-DD") }
    }).sort({ payrollPeriodStartDay: -1 }).lean();

    if (!period) return res.status(404).json({ error: "No payroll period found for this month." });

    // Get period start and length
    const start = dayjs(period.payrollPeriodStartDay);
    let length = period.payrollPeriodLength;
    if (!length) {
      // Fallback to type-based logic if missing in DB
      if (period.payrollPeriodType === "monthly") {
        length = start.add(1, "month").diff(start, "day");
      } else if (period.payrollPeriodType === "weekly") length = 7;
      else if (period.payrollPeriodType === "10-days") length = 10;
      else if (period.payrollPeriodType === "bimonthly") length = 15;
      else length = 30;
    }
    const end = start.add(length - 1, "day");
    const daysLeft = end.diff(today, "day") >= 0 ? end.diff(today, "day") + 1 : 0;
    const periodEnded = today.isAfter(end, "day");

    // Get all employees for this owner
    const employees = await Employee.find({ owner: ownerId }).select("_id name designation department").lean();

    res.json({
      period,
      daysLeft,
      periodEnded,
      start: start.format("YYYY-MM-DD"),
      end: end.format("YYYY-MM-DD"),
      employees,
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to get payroll period status." });
  }
};
// Keep your existing getCurrentPayrollPeriod for "just the period"
exports.getCurrentPayrollPeriod = async (req, res) => {
  try {
    const ownerId = req.user._id;
    const today = new Date();
    const startOfMonth = today.toISOString().slice(0, 7) + "-01"; // e.g. '2025-07-01'

    // Find the most recent period that covers this month (or today)
    const period = await PayrollPeriod.findOne({
      owner: ownerId,
      payrollPeriodStartDay: { $lte: startOfMonth }, // started before or on this month
    })
      .sort({ payrollPeriodStartDay: -1 }) // most recent
      .lean();

    if (!period) {
      return res.status(404).json({ error: "No payroll period found for this month." });
    }

    res.json({ period });
  } catch (err) {
    res.status(500).json({ error: "Failed to get current payroll period." });
  }
};
