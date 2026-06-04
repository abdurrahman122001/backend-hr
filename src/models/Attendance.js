// src/models/Attendance.js
const { Schema, model } = require('mongoose');

const AttendanceSchema = new Schema({
  owner: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  employee: { type: Schema.Types.ObjectId, ref: 'Employee', required: true },
  date: { type: String, required: true },
  status: { type: String, enum: ['Present', 'Late', 'Absent', 'Half Day', 'Leave'], required: true },
  // Snapshot of status before logout recalculation — used by reactivation to restore original status on refresh
  originalStatus: { type: String, enum: ['Present', 'Late', 'Absent', 'Half Day', 'Leave'], default: null },
  checkIn: { type: String },
  checkOut: { type: String },
  notes: { type: String },
  markedByHR: { type: Boolean, default: true },
  leaveType: { type: String, enum: ['Paid', 'Unpaid'], default: null },
  proportionate: { type: Boolean, default: false },
  proportionateValue: { type: Number },
  effectivePaidDays: { type: Number },
  isHoliday: { type: Boolean, default: false },
  markedOnNonWorkingDay: { type: Boolean, default: false },
  bonusApplied: { type: Boolean, default: false },
  bonusType: { type: String, enum: ["EarlyBird", "NonWorkingDay", null], default: null },
  bonusHoursGiven: { type: Number, default: 0 },

  // Employee acknowledgment fields for unpaid absences
  acknowledgedByEmployee: { type: Boolean, default: false },
  acknowledgedAt: { type: Date },
  acknowledgmentReason: { type: String },
  acknowledgmentType: { type: String, enum: ['unpaid', 'paid', null], default: null },

  // Employee challenge fields
  requestedStatus: { type: String },
  requestedCheckIn: { type: String },
  requestedCheckOut: { type: String },
  challengeStatus: { type: String, enum: ['None', 'Pending', 'Approved', 'Rejected', 'Withdrawn'], default: 'None' },
  challengeReason: { type: String },
  challengeAt: { type: Date },
  challengeAdminNotes: { type: String },
  challengeAttachment: { type: String },

  // Session timing — used by logout to calculate hours and determine half-day upgrade
  loginTime: { type: Date },
  logoutTime: { type: Date },
  totalHours: { type: Number, default: 0 },

  // True when employee checked in at or after 6 PM — logout at 9 PM+ upgrades to Present
  isLoginAfter6PM: { type: Boolean, default: false },
  halfDayFromAutoLogout: { type: Boolean, default: false },

  // Shift snapshot at time of check-in
  shiftId: { type: Schema.Types.ObjectId, ref: 'Shift', default: null },
  shiftName: { type: String },
  shiftStartTime: { type: String },
  shiftEndTime: { type: String },
  timezone: { type: String },

  deviceFingerprint: { type: String },
  active: { type: Boolean, default: false },

}, { timestamps: true });


AttendanceSchema.index({ employee: 1, date: 1, owner: 1, }, { unique: true });

module.exports = model('Attendance', AttendanceSchema);
