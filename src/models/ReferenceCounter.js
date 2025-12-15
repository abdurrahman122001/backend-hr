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
  },
  lastGeneratedDate: {
    type: String, // Format: "2025-09-19" for date comparison
    index: true
  }
}, {
  timestamps: true
});

// Compound index for efficient lookups
referenceCounterSchema.index({ docType: 1, yearMonth: 1 }, { unique: true });
referenceCounterSchema.index({ lastGeneratedDate: 1 });

module.exports = mongoose.model("ReferenceCounter", referenceCounterSchema);