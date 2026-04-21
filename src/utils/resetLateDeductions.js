// Reset script to fix inconsistent late deduction state
// Run this to reset lateDeductionDaysCredited for affected employees

const mongoose = require("mongoose");
const SalarySlip = require("../models/SalarySlip");

async function resetLateDeductions(employeeId, month, year) {
  const slip = await SalarySlip.findOne({
    employee: employeeId,
    month: month,
    year: year
  });
  
  if (slip) {
    console.log(`Before: lateDeductionDaysCredited = ${slip.lateDeductionDaysCredited}`);
    slip.lateDeductionDaysCredited = 0;
    await slip.save();
    console.log(`Reset complete for employee ${employeeId}`);
  } else {
    console.log(`No SalarySlip found for employee ${employeeId}`);
  }
}

// Usage example (run this after connecting to MongoDB):
// resetLateDeductions("68ac9ee0a45dc85b1f1cefbd", "April", "2026");

module.exports = { resetLateDeductions };
