const mongoose = require("mongoose");

const ReferenceCounterSchema = new mongoose.Schema(
  {
    docType: { type: String, required: true },
    yearMonth: { type: String, required: true }, // Format: 092025
    sequence: { type: Number, default: 1 },
    lastGenerated: { type: Date, default: Date.now },
    lastGeneratedDate: { type: String }, // YYYY-MM-DD format for date comparison
    timezone: { type: String, default: "UTC" },
    owner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

// Compound index for unique counters per user per month per document type
ReferenceCounterSchema.index(
  { docType: 1, yearMonth: 1, owner: 1 },
  { unique: true }
);

module.exports = mongoose.model("ReferenceCounter", ReferenceCounterSchema);
