const mongoose = require('mongoose');

const taxStatusSchema = new mongoose.Schema({
  owner: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  fiscalYear: {
    type: String,
    required: true
  },
  enabled: {
    type: Boolean,
    default: false
  },
  enabledAt: {
    type: Date,
    default: Date.now
  },
  mode: {
    type: String,
    enum: ['enable', 'disable'],
    default: 'enable'
  },
  scope: {
    type: String,
    enum: ['all', 'employees', 'slips'],
    default: 'all'
  },
  employeeIds: [{
    type: String // Keep as String to avoid ObjectId conversion issues
  }],
  // NEW: Track if future slips should be auto-created
  autoCreateFutureSlips: {
    type: Boolean,
    default: false
  }
}, {
  timestamps: true
});

// Compound index to ensure one tax status per owner per fiscal year
taxStatusSchema.index({ owner: 1, fiscalYear: 1 }, { unique: true });

module.exports = mongoose.model('TaxStatus', taxStatusSchema);