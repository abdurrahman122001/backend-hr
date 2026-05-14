const mongoose = require("mongoose");

const leaveEncashmentRequestSchema = new mongoose.Schema(
  {
    employee: { type: mongoose.Schema.Types.ObjectId, ref: "Employee", required: true },
    owner: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    days: { type: Number, required: true },
    encashmentRate: { type: Number, required: true },
    reason: { type: String },
    status: { type: String, enum: ["pending", "approved", "rejected"], default: "pending" },
    adminReason: { type: String },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Employee" },
    approvedAt: { type: Date },
  },
  { timestamps: true }
);

module.exports = mongoose.model("LeaveEncashmentRequest", leaveEncashmentRequestSchema);