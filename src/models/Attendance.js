// src/models/Attendance.js
const { Schema, model } = require('mongoose');

const AttendanceSchema = new Schema({
  owner: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  employee: { type: Schema.Types.ObjectId, ref: 'Employee', required: true },
  date: { type: String, required: true },
  status: { type: String, enum: ['Present', 'Late', 'Absent', 'Half Day', 'Leave'], required: true },
  checkIn: { type: String },
  checkOut: { type: String },
  notes: { type: String },
  markedByHR: { type: Boolean, default: true },
  leaveType: { type: String, enum: ['Paid', 'Unpaid'], default: 'Unpaid' },
  proportionate: { type: Boolean, default: false },
  proportionateValue: { type: Number },
  effectivePaidDays: { type: Number },
  isHoliday: { type: Boolean, default: false },
  markedOnNonWorkingDay: { type: Boolean, default: false },
  bonusApplied: { type: Boolean, default: false },
  bonusType: { type: String, enum: ["EarlyBird", "NonWorkingDay", null], default: null },
  bonusHoursGiven: { type: Number, default: 0 },


}, { timestamps: true });


AttendanceSchema.index({ employee: 1, date: 1, owner: 1, }, { unique: true });

module.exports = model('Attendance', AttendanceSchema);
