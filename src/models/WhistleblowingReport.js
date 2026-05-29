const mongoose = require("mongoose");

const whistleblowingReportSchema = new mongoose.Schema(
  {
    employee: { type: mongoose.Schema.Types.ObjectId, ref: "Employee", required: true },
    owner: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    reportType: {
      type: String,
      enum: ["misconduct", "fraud", "harassment", "safety-violation", "policy-breach", "discrimination", "other"],
      required: true,
    },
    incidentDate: { type: Date, required: true },
    location: { type: String },
    description: { type: String, required: true },
    involvedParties: { type: String },
    witnessInfo: { type: String },
    isAnonymous: { type: Boolean, default: false },
    attachmentUrl: { type: String },
    status: {
      type: String,
      enum: ["pending", "under-review", "resolved", "dismissed"],
      default: "pending",
    },
    adminNote: { type: String },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    reviewedAt: { type: Date },
  },
  { timestamps: true }
);

whistleblowingReportSchema.index({ employee: 1, status: 1, createdAt: -1 });
whistleblowingReportSchema.index({ owner: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model("WhistleblowingReport", whistleblowingReportSchema);
