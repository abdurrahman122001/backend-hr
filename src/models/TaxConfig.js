const mongoose = require('mongoose');

const taxSlabSchema = new mongoose.Schema({
  from:     { type: Number, required: true },
  to:       { type: Number, default: null }, // null = Infinity (top slab)
  fixed:    { type: Number, default: 0 },
  rateOver: { type: Number, default: 0 },   // percentage e.g. 5 = 5%
  label:    { type: String, default: '' },  // optional human-readable label
});

const taxConfigSchema = new mongoose.Schema({
  fiscalYear: {
    type: String,
    required: true,
    unique: true,
  },
  // Fiscal year boundaries (used for display & calculation)
  fiscalYearStart: {
    month: { type: String, default: 'July' },
    day:   { type: Number, default: 1 },
  },
  fiscalYearEnd: {
    month: { type: String, default: 'June' },
    day:   { type: Number, default: 30 },
  },

  slabs: [taxSlabSchema],
  enableMedicalExemption: { type: Boolean, default: true },

  // Which employees this config applies to: 'all' | 'selected'
  applyTo:     { type: String, enum: ['all', 'selected'], default: 'all' },
  // If applyTo === 'selected', list of employee IDs
  employeeIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Employee' }],

  // Auto-tax settings (preserved from previous schema)
  autoApplyEnabled:       { type: Boolean, default: false },
  autoApplyFromMonth:     { month: String, year: String },
  autoApplyEnabledAt:     { type: Date },
  autoEnabledOwners:      [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  processedAutoTaxMonths: [{ month: String, year: String }],
}, { timestamps: true });

module.exports = mongoose.model('TaxConfig', taxConfigSchema);