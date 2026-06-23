const mongoose = require("mongoose");

const leaveCarryForwardRequestSchema = new mongoose.Schema(
  {
    employee: { type: mongoose.Schema.Types.ObjectId, ref: "Employee", required: true },
    owner: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    days: { type: Number, required: true },
    year: { type: String, required: true }, // e.g., "2025"
    reason: { type: String },
    status: { type: String, enum: ["pending", "approved", "rejected", "cancelled"], default: "pending" },
    adminReason: { type: String },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Employee" },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Employee" },
    approvedAt: { type: Date },
  },
  { timestamps: true }
);

module.exports = mongoose.model("LeaveCarryForwardRequest", leaveCarryForwardRequestSchema);
