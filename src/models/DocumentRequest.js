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
    monthMode: { type: String, enum: ["single", "multiple"], default: "single" }, // for salary-slip only
    month: { type: String }, // e.g. "2026-05" — used for single month mode or certificate
    fromMonth: { type: String }, // e.g. "2026-01" — used for range mode
    toMonth: { type: String }, // e.g. "2026-05" — used for range mode
    purpose: { type: String }, // e.g. "Visa Application", "Bank Loan"
    purposeOther: { type: String }, // custom purpose when selected "Other"
    copyType: {
      type: String,
      enum: ["soft-copy", "attested", null],
      default: null,
    }, // for both salary-slip and salary-certificate
    reason: { type: String },
    status: { type: String, enum: ["pending", "approved", "rejected"], default: "pending" },
    adminReason: { type: String },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    approvedAt: { type: Date },
    generatedDocUrl: { type: String, default: null }, // URL of the generated document PDF
    referenceNumber: { type: String, default: null },  // e.g. MA01-SS-19062026
  },
  { timestamps: true }
);

documentRequestSchema.index({ employee: 1, status: 1, createdAt: -1 });
documentRequestSchema.index({ owner: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model("DocumentRequest", documentRequestSchema);
