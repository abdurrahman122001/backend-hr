const mongoose = require("mongoose");

const advanceSalaryRequestSchema = new mongoose.Schema(
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
  },
  { timestamps: true }
);

module.exports = mongoose.model("AdvanceSalaryRequest", advanceSalaryRequestSchema);

