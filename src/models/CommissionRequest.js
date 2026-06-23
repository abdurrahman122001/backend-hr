const mongoose = require("mongoose");

const commissionRequestSchema = new mongoose.Schema(
  {
    employee: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Employee",
      required: true,
    },
    owner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Users",
      required: true,
    },
    amount: {
      type: Number,
      required: true,
    },
    month: {
      type: String, // format: "YYYY-MM"
      required: true,
    },
    reason: {
      type: String,
      required: true,
    },
    status: {
      type: String,
      enum: ["pending", "approved", "rejected", "cancelled"],
      default: "pending",
    },
    adminReason: {
      type: String,
    },
    reviewedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Employee",
    },
    approvedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Employee",
    },
    approvedAt: {
      type: Date,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("CommissionRequest", commissionRequestSchema);

