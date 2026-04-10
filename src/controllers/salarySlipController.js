const PFSetting = require("../models/PFSetting");
const Employee = require("../models/Employees");
const SalarySlip = require("../models/SalarySlip");
const { encrypt } = require("../utils/encryption");

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

async function createSalarySlip(employeeId, slipData, encryptionKey) {
  const { pfRate } = await getPFRateAndYears(employeeId);
  const basicSalary = Number(slipData.basic || 0);
  const empPFMonthly = Math.round(basicSalary * (pfRate / 100));

  if (slipData.providentFundDeduction === undefined || slipData.providentFundDeduction === "") {
      slipData.providentFundDeduction = empPFMonthly.toString();
  }

  if (encryptionKey) {
    const allowances = [
      "basic", "dearnessAllowance", "houseRentAllowance", "conveyanceAllowance", "medicalAllowance",
      "utilityAllowance", "overtimeCompensation", "dislocationAllowance", "leaveEncashment",
      "bonus", "arrears", "autoAllowance", "incentive", "fuelAllowance", "othersAllowances", "loanBenefits"
    ];
    // Notice loanBenefits is added above, check if it's needed! But I will copy all.
    const deductions = [
      "leaveDeductions", "lateDeductions", "eobiDeduction", "sessiDeduction", "providentFundDeduction",
      "gratuityFundDeduction", "advanceSalaryDeductions",
      "medicalInsurance", "lifeInsurance", "penalties", "otherDeductions", "taxDeduction"
    ];

    const allowedFields = [...allowances, ...deductions];

    for (let key of allowedFields) {
      if (slipData[key] !== undefined && slipData[key] !== null) {
        let val = slipData[key];
        if (typeof val === "string" && val.includes(":")) {
          // already encrypted
        } else {
          slipData[key] = await encrypt(val, encryptionKey);
        }
      }
    }
    
    // Handle loan deductions - map flat fields to nested structure
    if (slipData.vehicleLoanDeduction !== undefined || slipData.otherLoanDeductions !== undefined) {
        slipData.loanDeductions = {};
        if (slipData.vehicleLoanDeduction !== undefined) {
            let val = slipData.vehicleLoanDeduction;
            if (typeof val === "string" && val.includes(":")) {
                slipData.loanDeductions.vehicleLoan = val;
            } else {
                slipData.loanDeductions.vehicleLoan = await encrypt(val, encryptionKey);
            }
            delete slipData.vehicleLoanDeduction; // Remove flat field
        }
        if (slipData.otherLoanDeductions !== undefined) {
            let val = slipData.otherLoanDeductions;
            if (typeof val === "string" && val.includes(":")) {
                slipData.loanDeductions.otherLoans = val;
            } else {
                slipData.loanDeductions.otherLoans = await encrypt(val, encryptionKey);
            }
            delete slipData.otherLoanDeductions; // Remove flat field
        }
    }
    
    // Check if loanDeductions nested exists (for direct nested input)
    if (slipData.loanDeductions && typeof slipData.loanDeductions === "object") {
        for (const subKey of ["vehicleLoan", "otherLoans"]) {
             if (slipData.loanDeductions[subKey] !== undefined) {
                 let val = slipData.loanDeductions[subKey];
                 if (typeof val === "string" && val.includes(":")) continue;
                 slipData.loanDeductions[subKey] = await encrypt(val, encryptionKey);
             }
        }
    }
  }

  const slip = await SalarySlip.create({
    ...slipData,
    employee: employeeId,
  });

  return slip;
}

module.exports = {
  getPFRateAndYears,
  createSalarySlip
};
