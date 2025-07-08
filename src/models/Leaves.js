// src/models/Leaves.js
const { Schema, model, Types } = require('mongoose');

const LeavesSchema = new Schema({
  employee:      { type: Types.ObjectId, ref: 'Employee', required: true },
  date:          { type: Date, required: true },    // start date in YYYY-MM-DD
  endDate:       { type: Date,   required: true },
  daysRequested: { type: Number, required: true },
  noticeDays:    { type: Number, required: true },    // computed at request time
  requestText:   { type: String, required: true },    // full email body
  leaveType:     { type: String, enum: ['Paid','Unpaid'], default: null },
  status:        { type: String, enum: ['Pending','Approved','Rejected'], default: 'Pending' },
  requestedAt:   { type: Date,   default: () => new Date() },
  approvedAt:    { type: Date }
}, { timestamps: true });

// prevent duplicate requests for same date range
LeavesSchema.index({ employee:1, date:1, endDate:1 }, { unique: true });

module.exports = model('Leaves', LeavesSchema);
