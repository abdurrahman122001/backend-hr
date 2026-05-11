const mongoose = require("mongoose");
const Schema = mongoose.Schema;

const SalaryChangeRequestSchema = new Schema(
  {
    employee: {
      type: Schema.Types.ObjectId,
      ref: "Employee",
      required: true,
    },
    owner: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    // Current salary details (for reference)
    currentSalary: {
      basic: { type: String, default: "" },
      dearnessAllowance: { type: String, default: "" },
      houseRentAllowance: { type: String, default: "" },
      conveyanceAllowance: { type: String, default: "" },
      medicalAllowance: { type: String, default: "" },
      utilityAllowance: { type: String, default: "" },
      overtimeCompensation: { type: String, default: "" },
      dislocationAllowance: { type: String, default: "" },
      leaveEncashment: { type: String, default: "" },
      bonus: { type: String, default: "" },
      arrears: { type: String, default: "" },
      autoAllowance: { type: String, default: "" },
      incentive: { type: String, default: "" },
      fuelAllowance: { type: String, default: "" },
      othersAllowances: { type: String, default: "" },
      grossSalary: { type: String, default: "" },
    },
    // Proposed new salary details
    proposedSalary: {
      basic: { type: String, default: "" },
      dearnessAllowance: { type: String, default: "" },
      houseRentAllowance: { type: String, default: "" },
      conveyanceAllowance: { type: String, default: "" },
      medicalAllowance: { type: String, default: "" },
      utilityAllowance: { type: String, default: "" },
      overtimeCompensation: { type: String, default: "" },
      dislocationAllowance: { type: String, default: "" },
      leaveEncashment: { type: String, default: "" },
      bonus: { type: String, default: "" },
      arrears: { type: String, default: "" },
      autoAllowance: { type: String, default: "" },
      incentive: { type: String, default: "" },
      fuelAllowance: { type: String, default: "" },
      othersAllowances: { type: String, default: "" },
      grossSalary: { type: String, default: "" },
    },
    effectiveDate: {
      type: Date,
      required: true,
    },
    payrollPeriod: {
      type: String, // format: "YYYY-MM"
      required: true,
    },
    reason: {
      type: String,
      required: true,
    },
    status: {
      type: String,
      enum: ["pending", "approved", "rejected"],
      default: "pending",
    },
    adminReason: {
      type: String,
    },
    approvedBy: {
      type: Schema.Types.ObjectId,
      ref: "Employee",
    },
    approvedAt: {
      type: Date,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("SalaryChangeRequest", SalaryChangeRequestSchema);
