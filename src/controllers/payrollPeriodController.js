// src/controllers/payrollPeriodController.js

const PayrollPeriod = require('../models/PayrollPeriod');

// Create a new payroll period
exports.createPayrollPeriod = async (req, res) => {
  const {name, payrollPeriodType, payrollPeriodStartDay, payrollPeriodLength, shifts } = req.body;

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
  name: name || null,     // ADD THIS
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

  // Only delete payroll period that belongs to the logged-in user
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
  // Fetch the most recent (or any, since you set all payroll periods)
  const period = await PayrollPeriod.findOne({ owner: ownerId }).sort({ createdAt: -1 }).lean();
  res.json({ nonWorkingDays: period?.nonWorkingDays || [] });
};