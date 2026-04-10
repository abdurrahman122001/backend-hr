// models/SalarySlip.js
const mongoose = require("mongoose");
const Schema = mongoose.Schema;

const SalarySlipSchema = new Schema(
  {
    owner: { type: Schema.Types.ObjectId, ref: "User", required: true },

    employee: { type: Schema.Types.ObjectId, ref: "Employee", required: true },
    encryptedWithKeyVersion: { type: Number, default: 1 }, // Track which key version was used
    isLocked: { type: Boolean, default: false },
    manuallyEditedFields: {
      type: Map,
      of: Boolean,
      default: () => new Map()
    },

    // All encrypted fields
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
    leaveDeductions: { type: String, default: "" },
    lateDeductions: { type: String, default: "" },
    eobiDeduction: { type: String, default: "" },
    sessiDeduction: { type: String, default: "" },
    providentFundDeduction: { type: String, default: "" },
    gratuityFundDeduction: { type: String, default: "" },
    loanDeductions: {
      vehicleLoan: { type: String, default: "" },
      otherLoans: { type: String, default: "" },
    },
    advanceSalaryDeductions: { type: String, default: "" },
    medicalInsurance: { type: String, default: "" },
    lifeInsurance: { type: String, default: "" },
    penalties: { type: String, default: "" },
    otherDeductions: { type: String, default: "" },
    taxDeduction: { type: String, default: "" },
    totalAllowances: { type: String, default: "" },
    totalDeductions: { type: String, default: "" },
    netPayable: { type: String, default: "" },
    lateDeductionDaysCredited: { type: Number, default: 0 },

    month: {
      type: String,
      default: () => new Date().toLocaleString("en-US", { month: "long" }),
    },
    year: {
      type: String,
      default: () => new Date().getFullYear().toString(),
    },
  },
  { timestamps: true }
);
SalarySlipSchema.methods.toJSON = function () {
  const obj = this.toObject();

  // Convert manuallyEditedFields Map to plain object
  if (obj.manuallyEditedFields && obj.manuallyEditedFields instanceof Map) {
    obj.manuallyEditedFields = Object.fromEntries(obj.manuallyEditedFields);
  } else if (!obj.manuallyEditedFields) {
    obj.manuallyEditedFields = {};
  }

  return obj;
};

module.exports = mongoose.model("SalarySlip", SalarySlipSchema);
