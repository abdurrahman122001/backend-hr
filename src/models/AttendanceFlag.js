const { Schema, model } = require('mongoose');

const AttendanceFlagSchema = new Schema({
  flag: { type: String, enum: ['Late', 'Half Day'], default: null },
  shift: { type: Schema.Types.ObjectId, ref: 'Shift', default: null },
  fromTime: { type: String, default: '' },
  toTime: { type: String, default: '' },
  hours: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

module.exports = model('AttendanceFlag', AttendanceFlagSchema);
