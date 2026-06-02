// src/controllers/settingsController.js

const Settings = require('../models/Settings');

exports.getSettings = async (req, res) => {
  const ownerId = req.user.owner || req.user.createdBy || req.user._id;
  const s = await Settings.findOne({ owner: ownerId }).lean();
  res.json({
    timezone: s?.timezone || 'UTC',
    useSystemTimezone: s?.useSystemTimezone ?? true,
    allowEmployeesMultipleShifts: s?.allowEmployeesMultipleShifts ?? false,
    timeFormat: s?.timeFormat || '24',
    autoGenerateSalaryCertificate: s?.autoGenerateSalaryCertificate ?? false,
  });
};

exports.updateSettings = async (req, res) => {
  const { timezone, useSystemTimezone, allowEmployeesMultipleShifts, timeFormat, autoGenerateSalaryCertificate } = req.body;
  const s = await Settings.findOneAndUpdate(
    { owner: req.user._id },
    { timezone, useSystemTimezone, allowEmployeesMultipleShifts, timeFormat, autoGenerateSalaryCertificate },
    { upsert: true, new: true }
  ).lean();
  res.json({
    timezone: s.timezone,
    useSystemTimezone: s.useSystemTimezone,
    allowEmployeesMultipleShifts: s.allowEmployeesMultipleShifts,
    timeFormat: s.timeFormat,
    autoGenerateSalaryCertificate: s.autoGenerateSalaryCertificate,
  });
};