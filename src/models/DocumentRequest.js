const mongoose = require("mongoose");

const documentRequestSchema = new mongoose.Schema(
  {
    employee: { type: mongoose.Schema.Types.ObjectId, ref: "Employee", required: true },
    owner: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    documentType: {
      type: String,
      enum: ["salary-slip", "salary-certificate"],
      required: true,
    },
    month: { type: String }, // e.g. "2026-05" — relevant for salary-slip only
    purpose: { type: String }, // e.g. "Visa Application", "Bank Loan"
    copyType: {
      type: String,
      enum: ["soft-copy", "hard-copy", "attested", null],
      default: null,
    }, // salary-certificate only
    reason: { type: String },
    status: { type: String, enum: ["pending", "approved", "rejected"], default: "pending" },
    adminReason: { type: String },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    approvedAt: { type: Date },
    generatedDocUrl: { type: String, default: null }, // URL of the generated certificate PDF
    referenceNumber: { type: String, default: null },  // e.g. MA01-SC-19062026
  },
  { timestamps: true }
);

documentRequestSchema.index({ employee: 1, status: 1, createdAt: -1 });
documentRequestSchema.index({ owner: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model("DocumentRequest", documentRequestSchema);
