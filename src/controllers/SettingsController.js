// src/controllers/settingsController.js

const Settings = require('../models/Settings');

exports.getSettings = async (req, res) => {
  const s = await Settings.findOne({ owner: req.user._id }).lean();
  res.json({
    timezone: s?.timezone || 'UTC',
    useSystemTimezone: s?.useSystemTimezone ?? true,
    allowEmployeesMultipleShifts: s?.allowEmployeesMultipleShifts ?? false,
    timeFormat: s?.timeFormat || '24',  // <--
  });
};

exports.updateSettings = async (req, res) => {
  const { timezone, useSystemTimezone, allowEmployeesMultipleShifts, timeFormat } = req.body;
  const s = await Settings.findOneAndUpdate(
    { owner: req.user._id },
    { timezone, useSystemTimezone, allowEmployeesMultipleShifts, timeFormat }, // <--
    { upsert: true, new: true }
  ).lean();
  res.json({
    timezone: s.timezone,
    useSystemTimezone: s.useSystemTimezone,
    allowEmployeesMultipleShifts: s.allowEmployeesMultipleShifts,
    timeFormat: s.timeFormat,  // <--
  });
};