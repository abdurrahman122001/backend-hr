// src/models/Settings.js

const { Schema, model } = require('mongoose');

const SettingsSchema = new Schema({
  owner: {
    type:     Schema.Types.ObjectId,
    ref:      'User',
    required: true,
    unique:   true,
  },
  timezone: {
    type:    String,
    default: 'UTC',
  },
  useSystemTimezone: {
    type:    Boolean,
    default: true,
  },
  allowEmployeesMultipleShifts: { type: Boolean, default: false },
  timeFormat: { type: String, enum: ['12', '24'], default: '24' },
}, {
  timestamps: true,
});

module.exports = model('Settings', SettingsSchema);
