const { Schema, model } = require('mongoose');

const AttendanceFlagSchema = new Schema({
  // Tenant key. Flags were previously listed with an unfiltered find({}), which
  // returned every company's rows.
  owner: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  flag: { type: String, enum: ['Late', 'Half Day'], default: null },
  shift: { type: Schema.Types.ObjectId, ref: 'Shift', default: null },
  fromTime: { type: String, default: '' },
  toTime: { type: String, default: '' },
  hours: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// Matches the list query: this company's flags, newest first.
AttendanceFlagSchema.index({ owner: 1, createdAt: -1 });

module.exports = model('AttendanceFlag', AttendanceFlagSchema);
