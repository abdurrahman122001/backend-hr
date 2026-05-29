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
    month: { type: String }, // e.g. "2026-05" — relevant for salary-slip
    purpose: { type: String }, // e.g. "Visa application", "Bank loan"
    reason: { type: String },
    status: { type: String, enum: ["pending", "approved", "rejected"], default: "pending" },
    adminReason: { type: String },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    approvedAt: { type: Date },
  },
  { timestamps: true }
);

documentRequestSchema.index({ employee: 1, status: 1, createdAt: -1 });
documentRequestSchema.index({ owner: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model("DocumentRequest", documentRequestSchema);
