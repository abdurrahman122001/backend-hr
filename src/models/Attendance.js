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


}, { timestamps: true });


AttendanceSchema.index({ employee: 1, date: 1, owner: 1, }, { unique: true });

module.exports = model('Attendance', AttendanceSchema);
