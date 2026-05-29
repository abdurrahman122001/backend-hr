const { Schema, model } = require('mongoose');

const AttendanceChallengeSchema = new Schema({
  owner: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  employee: { type: Schema.Types.ObjectId, ref: 'Employee', required: true },
  attendance: { type: Schema.Types.ObjectId, ref: 'Attendance', required: true },
  date: { type: String, required: true },
  
  requestedStatus: { type: String },
  requestedCheckIn: { type: String },
  requestedCheckOut: { type: String },
  
  challengeStatus: {
    type: String,
    enum: ['Pending', 'Approved', 'Rejected', 'Withdrawn'],
    default: 'Pending'
  },
  challengeReason: { type: String },
  challengeAt: { type: Date, default: Date.now },
  challengeAdminNotes: { type: String },
  challengeAttachment: { type: String },
}, { timestamps: true });

// Ensure unique constraint so an employee has at most one challenge per date
AttendanceChallengeSchema.index({ employee: 1, date: 1 }, { unique: true });

module.exports = model('AttendanceChallenge', AttendanceChallengeSchema);
