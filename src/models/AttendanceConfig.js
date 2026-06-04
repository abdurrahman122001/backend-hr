const { Schema, model } = require('mongoose');

const AttendanceConfigSchema = new Schema({
  owner: {
    type:     Schema.Types.ObjectId,
    ref:      'User',
    required: true,
    unique:   true
  },
  markAbsentManually: { type: Boolean, default: false },
  allowDeleteRecords: { type: Boolean, default: false },
  allowEditRecords:   { type: Boolean, default: false },
  attendanceMode: {
    type: String,
    enum: ['auth_login', 'manual'],
    default: 'auth_login'
  },

  // EDIT SCOPE
  editRecordsScope: {
    type: String,
    enum: ['current', 'anytime', 'previous'],
    default: 'current'
  },
  editPreviousDaysLimit:  { type: Number, default: 7 },

  // DELETE SCOPE (NEW)
  deleteRecordsScope: {
    type: String,
    enum: ['current', 'anytime', 'previous'],
    default: 'current'
  },
  deletePreviousDaysLimit: { type: Number, default: 7 },
}, {
  timestamps: true
});

module.exports = model('AttendanceConfig', AttendanceConfigSchema);
