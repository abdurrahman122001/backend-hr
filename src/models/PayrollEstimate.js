const mongoose = require('mongoose');

const payrollEstimateSchema = new mongoose.Schema({
  employee: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Employees',
    required: true
  },
  owner: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  month: {
    type: String,
    required: true
  },
  year: {
    type: String,
    required: true
  },
  // Field-value overrides (encrypted strings)
  overrides: {
    type: Map,
    of: String,
    default: {}
  },
  // To track which fields were manually edited
  manuallyEditedFields: {
    type: Map,
    of: Boolean,
    default: {}
  },
  workingDays: {
    type: Number
  }
}, {
  timestamps: true
});

// Index for quick lookup
payrollEstimateSchema.index({ employee: 1, month: 1, year: 1, owner: 1 }, { unique: true });

module.exports = mongoose.model('PayrollEstimate', payrollEstimateSchema);
