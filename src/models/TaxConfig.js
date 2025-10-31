const mongoose = require('mongoose');

const taxSlabSchema = new mongoose.Schema({
  from: { type: Number, required: true },
  to: { type: Number }, // null/undefined means infinity
  fixed: { type: Number, default: 0 },
  rateOver: { type: Number, default: 0 } // percentage
});

const taxConfigSchema = new mongoose.Schema({
  fiscalYear: {
    type: String,
    required: true,
    unique: true
  },
  slabs: [taxSlabSchema],
  enableMedicalExemption: {
    type: Boolean,
    default: true
  },
  // NEW: Auto-enable settings
  autoEnabledOwners: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }],
  // NEW: Month from which tax should be automatically applied
  autoApplyFromMonth: {
    month: String, // e.g., "July", "August"
    year: String   // e.g., "2024", "2025"
  },
  // NEW: Track when auto-apply was enabled
  autoApplyEnabled: {
    type: Boolean,
    default: false
  },
  autoApplyEnabledAt: {
    type: Date,
    default: null
  },
  // NEW: Track which months have been processed for auto-tax
  processedAutoTaxMonths: [{
    month: String,
    year: String,
    processedAt: {
      type: Date,
      default: Date.now
    }
  }]
}, {
  timestamps: true
});

module.exports = mongoose.model('TaxConfig', taxConfigSchema);