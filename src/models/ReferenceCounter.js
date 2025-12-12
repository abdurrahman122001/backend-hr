// models/ReferenceCounter.js
const mongoose = require("mongoose");

const referenceCounterSchema = new mongoose.Schema({
  docType: {
    type: String,
    required: true,
    index: true
  },
  yearMonth: {
    type: String, // Format: "092025" for September 2025
    required: true,
    index: true
  },
  sequence: {
    type: Number,
    default: 0
  },
  lastGenerated: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

// Compound index for efficient lookups
referenceCounterSchema.index({ docType: 1, yearMonth: 1 }, { unique: true });

module.exports = mongoose.model("ReferenceCounter", referenceCounterSchema);