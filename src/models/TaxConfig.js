const mongoose = require('mongoose');

const taxSlabSchema = new mongoose.Schema({
  from:     { type: Number, required: true },
  to:       { type: Number, default: null }, // null = Infinity (top slab)
  fixed:    { type: Number, default: 0 },
  rateOver: { type: Number, default: 0 },   // percentage e.g. 5 = 5%
  label:    { type: String, default: '' },  // optional human-readable label
});

const taxConfigSchema = new mongoose.Schema({
  // Tenant key. A tax config belongs to exactly one company — fiscal years
  // repeat across companies, so every read and write must be scoped by owner.
  owner: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  fiscalYear: {
    type: String,
    required: true,
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
  // Superseded by `owner`: with one config per company, `autoApplyEnabled` on
  // that company's own document is the per-company flag. Retained so existing
  // data and the auto-tax status check keep working; safe to retire once the
  // backfill has settled.
  autoEnabledOwners:      [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  processedAutoTaxMonths: [{ month: String, year: String }],
}, { timestamps: true });

// A fiscal year is unique per company, not globally. NOTE: dropping `unique`
// from the field above does NOT remove the existing `fiscalYear_1` index from
// MongoDB — it must be dropped explicitly, which
// migrations/backfill-owner-scoping.js does. Until it is dropped, a second
// company still cannot create the same fiscal year.
taxConfigSchema.index({ owner: 1, fiscalYear: 1 }, { unique: true });

module.exports = mongoose.model('TaxConfig', taxConfigSchema);