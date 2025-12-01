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
  }
}, {
  timestamps: true
});

module.exports = mongoose.model('TaxConfig', taxConfigSchema);