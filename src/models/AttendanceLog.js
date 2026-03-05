// src/models/AttendanceLog.js
const { Schema, model } = require('mongoose');

const AttendanceLogSchema = new Schema({
  owner: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  employee: { type: Schema.Types.ObjectId, ref: 'Employee', required: true },
  date: { type: String, required: true }, // YYYY-MM-DD
  
  // First shift info
  firstShiftId: { type: Schema.Types.ObjectId, ref: 'Shift' },
  firstShiftName: { type: String },
  firstShiftStart: { type: String }, // HH:mm
  firstShiftEnd: { type: String }, // HH:mm
  firstCheckIn: { type: String }, // HH:mm
  firstCheckOut: { type: String }, // HH:mm (the logout time that was removed)
  firstLogoutTime: { type: Date }, // UTC timestamp
  
  // Between-shift login info
  secondShiftId: { type: Schema.Types.ObjectId, ref: 'Shift' },
  secondShiftName: { type: String },
  secondShiftStart: { type: String }, // HH:mm
  secondCheckIn: { type: String }, // HH:mm (new login)
  secondLoginTime: { type: Date }, // UTC timestamp
  
  // Duration between logout and new login
  betweenShiftDuration: { type: Number }, // minutes
  
  // Status/notes
  status: { type: String, enum: ['logged', 'processed', 'reviewed'], default: 'logged' },
  notes: { type: String },
  
  // Admin review
  reviewedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  reviewedAt: { type: Date },
  
}, { timestamps: true });

AttendanceLogSchema.index({ employee: 1, date: 1, owner: 1 });
AttendanceLogSchema.index({ owner: 1, date: -1 });

module.exports = model('AttendanceLog', AttendanceLogSchema);
