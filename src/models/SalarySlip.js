const { Schema, model } = require('mongoose'); // <-- REQUIRED!

const SalarySlipSchema = new Schema({
  employee:                { type: Schema.Types.ObjectId, ref: 'Employee', required: true },

  // Allowances (all encrypted)
  basic:                   { type: String, default: "" },
  dearnessAllowance:       { type: String, default: "" },
  houseRentAllowance:      { type: String, default: "" },
  conveyanceAllowance:     { type: String, default: "" },
  medicalAllowance:        { type: String, default: "" },
  utilityAllowance:        { type: String, default: "" },
  overtimeCompensation:    { type: String, default: "" },
  dislocationAllowance:    { type: String, default: "" },
  leaveEncashment:         { type: String, default: "" },
  bonus:                   { type: String, default: "" },
  arrears:                 { type: String, default: "" },
  autoAllowance:           { type: String, default: "" },
  incentive:               { type: String, default: "" },
  fuelAllowance:           { type: String, default: "" },
  othersAllowances:        { type: String, default: "" },
  grossSalary:             { type: String, default: "" },

  // Deductions (all encrypted)
  leaveDeductions:         { type: String, default: "" },
  lateDeductions:          { type: String, default: "" },
  eobiDeduction:           { type: String, default: "" },
  sessiDeduction:          { type: String, default: "" },
  providentFundDeduction:  { type: String, default: "" },
  gratuityFundDeduction:   { type: String, default: "" },
  loanDeductions: {
    vehicleLoan:           { type: String, default: "" },
    otherLoans:            { type: String, default: "" },
  },
  advanceSalaryDeductions: { type: String, default: "" },
  medicalInsurance:        { type: String, default: "" },
  lifeInsurance:           { type: String, default: "" },
  penalties:               { type: String, default: "" },
  othersDeductions:        { type: String, default: "" },
  taxDeduction:            { type: String, default: "" },

  // Totals
  totalAllowances:         { type: String, default: "" },
  totalDeductions:         { type: String, default: "" },
  netPayable:              { type: String, default: "" },
}, { timestamps: true });

module.exports = model('SalarySlip', SalarySlipSchema);
