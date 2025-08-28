const mongoose = require("mongoose");

const TaxSlabSchema = new mongoose.Schema({
  from: { type: Number, required: true },
  to: { type: Number },
  fixed: { type: Number, default: 0 },
  rateOver: { type: Number, default: 0 },
});

const TaxConfigSchema = new mongoose.Schema({
  fiscalYear: { type: String, required: true, unique: true },
  enableMedicalExemption: { type: Boolean, default: true },
  slabs: [TaxSlabSchema],
});

module.exports = mongoose.model("TaxConfig", TaxConfigSchema);
