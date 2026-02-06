const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const SalarySchema = new Schema({
  owner: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  employee: { type: Schema.Types.ObjectId, ref: 'Employee', required: true },
  encryptedWithKeyVersion: { type: Number, default: 1 },

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

  // Tax Deduction Fields (encrypted)
  taxDeduction: { type: String, default: "" }, // Monthly tax
  annualTaxDeduction: { type: String, default: "" }, // Annual tax
  totalAllowances: { type: String, default: "" },
  totalDeductions: { type: String, default: "" },
  netPayable: { type: String, default: "" },

  isActive: { type: Boolean, default: true },
  month: { type: String, required: true },
  year: { type: String, required: true }
}, { timestamps: true });

module.exports = mongoose.model('Salaries', SalarySchema);