const PFSetting = require("../models/PFSetting");
const Employee = require("../models/Employees");
const SalarySlip = require("../models/SalarySlip");

/**
 * Returns correct PF rate and years for an employee:
 * - Uses per-employee override if present and enabled
 * - Falls back to global PFSetting if not overridden
 */
async function getPFRateAndYears(employeeId) {
  const employee = await Employee.findById(employeeId);
  let pfRate, years;
  if (employee?.providentFund?.override && employee.providentFund.pfRate != null) {
    pfRate = employee.providentFund.pfRate;
    years = employee.providentFund.years;
  } else {
    const latestPF = await PFSetting.findOne().sort({ updatedAt: -1 });
    pfRate = latestPF?.pfRate || 0;
    years = latestPF?.years || 1;
  }
  return { pfRate, years };
}

/**
 * Create a salary slip with correct PF deduction.
 * - Calculates employee's PF monthly contribution (deduction)
 * - Stores this in providentFundDeduction
 * - Other deductions/allowances can be added as per your logic
 */
async function createSalarySlip(employeeId, slipData) {
  const { pfRate } = await getPFRateAndYears(employeeId);
  // Use slipData.basic as string or number
  const basicSalary = Number(slipData.basic);
  const empPFMonthly = Math.round(basicSalary * (pfRate / 100));

  // Add PF deduction to deductions, but you may want to handle all totals here
  const slip = await SalarySlip.create({
    ...slipData,
    employee: employeeId,
    providentFundDeduction: empPFMonthly.toString(), // Only employee's share is deducted
    // ... other fields as needed
  });

  return slip;
}

// Export for use in your routes
module.exports = {
  getPFRateAndYears,
  createSalarySlip
};
