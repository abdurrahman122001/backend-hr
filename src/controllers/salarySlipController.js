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
      "gratuityFundDeduction", "vehicleLoanDeduction", "otherLoanDeductions", "advanceSalaryDeductions",
      "medicalInsurance", "lifeInsurance", "penalties", "othersDeductions", "taxDeduction"
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
    
    // Check if loanDeductions nested exists
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
