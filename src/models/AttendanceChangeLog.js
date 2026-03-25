// backend/src/models/AttendanceChangeLog.js
const { Schema, model } = require('mongoose');

const AttendanceChangeLogSchema = new Schema({
  owner: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  
  // Who made the change (Admin or Proxy Employee)
  performedBy: { type: Schema.Types.ObjectId, refPath: 'performerType' },
  performerType: { type: String, enum: ['User', 'Employee'], required: true },
  performerName: { type: String },

  // Patient (Employee whose attendance was changed)
  employee: { type: Schema.Types.ObjectId, ref: 'Employee', required: true },
  employeeName: { type: String },
  
  attendanceDate: { type: String, required: true }, // YYYY-MM-DD
  
  oldStatus: { type: String },
  newStatus: { type: String },
  
  oldLeaveType: { type: String },
  newLeaveType: { type: String },
  
  outcome: { type: String }, // 'Salary Deduction', 'Leave Deduction', 'None'
  details: { type: String }, // Optional: "By Admin", "Via Delegation", etc.
  
}, { timestamps: true });

AttendanceChangeLogSchema.index({ owner: 1, createdAt: -1 });
AttendanceChangeLogSchema.index({ employee: 1, attendanceDate: 1 });

module.exports = model('AttendanceChangeLog', AttendanceChangeLogSchema);
