const CompanyProfile = require("../models/CompanyProfile");
const SalarySlipFields = require("../models/SalarySlipFields");
const LoanDetail = require("../models/LoanDetail");
const nodemailer = require("nodemailer");
const numberToWords = require("number-to-words");
const SalarySlip = require("../models/SalarySlip");
const LeaveRecord = require("../models/LeaveRecord");
const leaveSummary = require("./leaveSummary"); // adjust the path if needed

const { decrypt } = require("../utils/encryption");
const monthsList = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
// Helper to normalize month names
function normMonth(m) {
  if (!m || typeof m !== "string") return "";
  const t = m.trim();
  return t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
}
// Helper to format numbers as currency
function formatDate(dt) {
  if (!dt) return "-";
  try {
    return new Date(dt)
      .toLocaleDateString("en-GB", {
        day: "2-digit",
        month: "long",
        year: "numeric",
      })
      .replace(/ (\d{4})$/, ", $1");
  } catch (e) {
    return dt;
  }
}

function formatPhoneNumber(phone) {
  if (!phone) return "-";
  let num = phone.replace(/[^\d]/g, "");
  if (!num) return "-";
  if (num.startsWith("92") && num.length === 12) {
    num = num.slice(0, 12);
  }
  if (num.startsWith("92") && num.length === 12) {
    return `+${num.slice(0, 2)} ${num.slice(2, 5)} ${num.slice(5)}`;
  }
  if (num.startsWith("92") && num.length === 11) {
    return `+${num.slice(0, 2)} ${num.slice(2, 5)} ${num.slice(5)}`;
  }
  return `+${num}`;
}

function calculateYearsOfService(joiningDate, currentDate) {
  if (!joiningDate) return 0;
  try {
    const joinDate = new Date(joiningDate);
    if (isNaN(joinDate.getTime())) return 0;
    const diffMs = currentDate.getTime() - joinDate.getTime();
    const years = diffMs / (1000 * 60 * 60 * 24 * 365);
    if (years < 0) return 0;
    return Number(years.toFixed(1));
  } catch {
    return 0;
  }
}

const ALLOWANCES_LABELS = {
  basic: "Basic Pay",
  dearnessAllowance: "Dearness Allowance",
  houseRentAllowance: "House Rent Allowance",
  conveyanceAllowance: "Conveyance Allowance",
  medicalAllowance: "Medical Allowance",
  utilityAllowance: "Utility Allowance",
  autoAllowance: "Auto Allowance",
  fuelAllowance: "Fuel Allowance",
  dislocationAllowance: "Dislocation Allowance",
  overtimeCompensation: "Overtime Compensation",
  leaveEncashment: "Leave Encashment",
  bonus: "Bonus",
  arrears: "Arrears",
  incentive: "Incentive",
  othersAllowances: "Other Allowances",
  loanBenefits: "Loan Benefits",
};

const DEDUCTIONS_LABELS = {
  eobiDeduction: "EOBI Deduction",
  sessiDeduction: "SESSI Deduction",
  providentFundDeduction: "Provident Fund Deduction",
  gratuityFundDeduction: "Gratuity Fund Deduction",
  taxDeduction: "Tax Deduction",
  leaveDeductions: "Leave Deduction",
  lateDeductions: "Late Deduction",
  advanceSalaryDeductions: "Advance Salary Deduction",
  vehicleLoanDeduction: "Vehicle Loan Deduction",
  otherLoanDeductions: "Loan Deduction",
  medicalInsurance: "Medical Insurance",
  lifeInsurance: "Life Insurance",
  penalties: "Penalties",
  otherDeductions: "Other Deduction",
};

const PROFILE_LABELS = {
  name: "Employee Name",
  fatherOrHusbandName: "Father/Husband Name",
  dateOfBirth: "Date of Birth",
  nationality: "Nationality",
  gender: "Gender",
  maritalStatus: "Marital Status",
  religion: "Religion",
  cnic: "CNIC",
  cnicIssueDate: "CNIC Issue Date",
  cnicExpiryDate: "CNIC Expiry Date",
  latestQualification: "Latest Qualification",
  fieldOfQualification: "Field of Qualification",
  phone: "Phone",
  email: "Email",
  permanentAddress: "Permanent Address",
  presentAddress: "Present Address",
  bankName: "Bank Name",
  bankAccountNumber: "Bank Account Number",
  department: "Department",
  designation: "Designation",
  joiningDate: "Joining Date",
  nomineeName: "Nominee Name",
  nomineeCnic: "Nominee CNIC",
  nomineeRelation: "Relation with Nominee",
  nomineeEmergencyNo: "Nominee Number",
  emergencyContactNumber: "Emergency Contact Number",
  shifts: "Shift(s)",
};

const PROVIDENT_FUND_FIELDS = [
  { label: "Balance Brought Forward", key: "providentFundBalanceBF" },
  { label: "Employee Contribution", key: "employeeProvidentFundContribution" },
  { label: "Employer Contribution", key: "employerProvidentFundContribution" },
  { label: "Withdrawal", key: "providentFundWithdrawal" },
  { label: "Profit", key: "providentFundProfit" },
  { label: "Balance", key: "providentFundBalance" },
];

const GRATUITY_FUND_FIELDS = [
  { label: "Balance Brought Forward", key: "gratuityFundBalanceBF" },
  { label: "Years of Service", key: "yearsOfService" },
  { label: "Monthly Contribution", key: "monthlyContribution" },
  { label: "Withdrawal", key: "gratuityFundWithdrawal" },
  { label: "Profit", key: "gratuityFundProfit" },
  { label: "Balance", key: "gratuityFundBalance" },
];

// Main cell formatter for all numbers (avoids NaN) - UPDATED FOR LOAN DETAILS
function safeAmountCell(val) {
  if (
    val === undefined ||
    val === null ||
    val === "" ||
    val === "-" ||
    isNaN(Number(val))
  ) {
    return "-";
  }
  const num = Math.round(Number(val));
  return !isNaN(num) ? num.toLocaleString() : "-";
}

function safeDecimalCell(val) {
  if (val === undefined || val === null || val === "" || val === "-")
    return "-";
  const num = parseFloat(val.toString().replace(/,/g, ""));
  if (isNaN(num)) return "-";
  return num.toLocaleString("en-PK");
}

// Render the Loan Table with updated field names
function renderLoanTable(loans = []) {
  const arr = Array.isArray(loans) && loans.length ? loans : [{}];

  console.log("Rendering loan table with data:", loans);

  return `
    <div style="margin-bottom: 24px;">
      <div style="font-weight:bold; color:#1d4ed8; background:#dbeafe; border-radius:8px 8px 0 0; padding:8px 18px;">
        Loan Details
      </div>
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse; background:#f8fafc;">
        <thead>
          <tr style="background:#f1f5f9;">
            <th style="padding:10px 6px; border:1px solid #e5e7eb;">Type</th>
            <th style="padding:10px 6px; border:1px solid #e5e7eb;">Amount Paid in Current Month</th>
            <th style="padding:10px 6px; border:1px solid #e5e7eb;">Amount Paid in Previous Month(s)</th>
            <th style="padding:10px 6px; border:1px solid #e5e7eb;">Balance (Principal)</th>
            <th style="padding:10px 6px; border:1px solid #e5e7eb;">Balance (Markup)</th>
            <th style="padding:10px 6px; border:1px solid #e5e7eb;">Net Balance</th>
          </tr>
        </thead>
        <tbody>
          ${arr
            .map(
              (loan) => `
            <tr>
              <td style="padding:8px 6px; border:1px solid #e5e7eb; text-align:center;">${
                loan.type || "-"
              }</td>
              <td style="padding:8px 6px; border:1px solid #e5e7eb; text-align:center;">${safeAmountCell(
                loan.amountPaidCurrentMonth
              )}</td>
              <td style="padding:8px 6px; border:1px solid #e5e7eb; text-align:center;">${safeAmountCell(
                loan.amountPaidPreviousMonths
              )}</td>
              <td style="padding:8px 6px; border:1px solid #e5e7eb; text-align:center;">${safeAmountCell(
                loan.balancePrincipal
              )}</td>
              <td style="padding:8px 6px; border:1px solid #e5e7eb; text-align:center;">${safeAmountCell(
                loan.balanceMarkup
              )}</td>
              <td style="padding:8px 6px; border:1px solid #e5e7eb; text-align:center;">${safeAmountCell(
                loan.netBalance
              )}</td>
            </tr>
          `
            )
            .join("")}
        </tbody>
      </table>
    </div>
  `;
}

// Render Provident Fund Table
function renderProvidentFundTable(data = {}) {
  return `
    <div style="margin-bottom: 24px;">
      <div style="font-weight:bold; color:#1d4ed8; background:#dbeafe; border-radius:8px 8px 0 0; padding:8px 18px;">
        Provident Fund
      </div>
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse; background:#f8fafc;">
        <thead>
          <tr style="background:#f1f5f9;">
            ${PROVIDENT_FUND_FIELDS.map(
              (f) =>
                `<th style="padding:10px 6px; border:1px solid #e5e7eb;">${f.label}</th>`
            ).join("")}
          </tr>
        </thead>
        <tbody>
          <tr>
            ${PROVIDENT_FUND_FIELDS.map(
              (f) =>
                `<td style="padding:8px 6px; border:1px solid #e5e7eb; text-align:center;">${
                  data &&
                  data[f.key] != null &&
                  data[f.key] !== "" &&
                  data[f.key] !== 0
                    ? data[f.key]
                    : "-"
                }</td>`
            ).join("")}
          </tr>
        </tbody>
      </table>
    </div>
  `;
}

// Render Gratuity Fund Table
function renderGratuityFundTable(data = {}) {
  return `
    <div style="margin-bottom: 24px;">
      <div style="font-weight:bold; color:#1d4ed8; background:#dbeafe; border-radius:8px 8px 0 0; padding:8px 18px;">
        Gratuity Fund
      </div>
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse; background:#f8fafc;">
        <thead>
          <tr style="background:#f1f5f9;">
            ${GRATUITY_FUND_FIELDS.map(
              (f) =>
                `<th style="padding:10px 6px; border:1px solid #e5e7eb;">${f.label}</th>`
            ).join("")}
          </tr>
        </thead>
        <tbody>
          <tr>
            ${GRATUITY_FUND_FIELDS.map((f) => {
              let value =
                data &&
                data[f.key] != null &&
                data[f.key] !== "" &&
                data[f.key] !== 0
                  ? data[f.key]
                  : "-";
              if (
                f.key === "gratuityFundBalanceBF" ||
                f.key === "monthlyContribution" ||
                f.key === "gratuityFundWithdrawal" ||
                f.key === "gratuityFundProfit" ||
                f.key === "gratuityFundBalance"
              ) {
                value = value !== "-" ? `Rs. ${safeDecimalCell(value)}` : "-";
              } else if (f.key === "yearsOfService") {
                value = value !== "-" ? `${value} years` : "-";
              }
              return `<td style="padding:8px 6px; border:1px solid #e5e7eb; text-align:center;">${value}</td>`;
            }).join("")}
          </tr>
        </tbody>
      </table>
    </div>
  `;
}

// Render Leave Table
function renderLeaveTable(leaves = {}, enabledLeaveRecords = []) {
  if (!Array.isArray(enabledLeaveRecords) || !enabledLeaveRecords.length)
    return "";

  // Detect if any leave type has a bonus > 0
  const hasAnyBonus = enabledLeaveRecords.some((type) => {
    const key = `${type.toLowerCase()}Bonus`;
    return Number(leaves[key] || 0) > 0;
  });

  // Table columns
  const cols = ["Entitled"];
  if (hasAnyBonus) cols.push("Bonus");
  cols.push("AvailedYTD", "AvailedMTH", "Balance");
  const colLabel = {
    Entitled: "Entitled",
    Bonus: "Overtime Bonus",
    AvailedYTD: "Availed (YTD)",
    AvailedMTH: "Availed (MTH)",
    Balance: "Balance",
  };
  const typeLabel = {
    casual: "Casual",
    sick: "Sick",
    annual: "Annual",
    wop: "WOP",
    other: "Other",
  };

  return `
    <div style="margin: 24px 0;">
      <div style="font-weight:bold; color:#1d4ed8; background:#dbeafe; border-radius:8px 8px 0 0; padding:8px 18px;">Leave Records</div>
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse; background:#f8fafc;">
        <thead>
          <tr style="background:#f1f5f9;">
            <th style="padding:10px 6px; border:1px solid #e5e7eb;">Leave Type</th>
            ${cols
              .map(
                (c) =>
                  `<th style="padding:10px 6px; border:1px solid #e5e7eb;">${colLabel[c]}</th>`
              )
              .join("")}
          </tr>
        </thead>
        <tbody>
          ${enabledLeaveRecords
            .map((type) => {
              const entitled = leaves[`${type.toLowerCase()}Entitled`] ?? "-";
              const bonus = leaves[`${type.toLowerCase()}Bonus`] ?? 0;
              const availedYTD =
                leaves[`${type.toLowerCase()}AvailedYTD`] ?? "-";
              const availedMTH =
                leaves[`${type.toLowerCase()}AvailedMTH`] ?? "-";
              const balance = leaves[`${type.toLowerCase()}Balance`] ?? "-";
              return `
              <tr>
                <td style="padding:8px 6px; border:1px solid #e5e7eb; text-align:center;">${
                  typeLabel[type] || type
                }</td>
                <td style="padding:8px 6px; border:1px solid #e5e7eb; text-align:center;">${entitled}</td>
                ${
                  hasAnyBonus
                    ? `<td style="padding:8px 6px; border:1px solid #e5e7eb; text-align:center;">${
                        Number(bonus) > 0 ? bonus : "-"
                      }</td>`
                    : ""
                }
                <td style="padding:8px 6px; border:1px solid #e5e7eb; text-align:center;">${availedYTD}</td>
                <td style="padding:8px 6px; border:1px solid #e5e7eb; text-align:center;">${availedMTH}</td>
                <td style="padding:8px 6px; border:1px solid #e5e7eb; text-align:center;">${balance}</td>
              </tr>
            `;
            })
            .join("")}
        </tbody>
      </table>
    </div>
  `;
}

// Net Salary Table Builder
function buildNetSalaryTable({
  netSalary,
  amountInWords,
  enabledNetSalaryFields,
}) {
  const NET_FIELD_LABELS = {
    netSalary: "Net Salary",
    amountInWords: "Amount in Words",
    modeOfPayment: "Mode of Payment",
  };
  const netValues = {
    netSalary: netSalary,
    amountInWords: amountInWords,
    modeOfPayment: "Bank Transfer",
  };
  const enabledFields =
    Array.isArray(enabledNetSalaryFields) && enabledNetSalaryFields.length
      ? enabledNetSalaryFields
      : ["netSalary", "amountInWords", "modeOfPayment"];
  const netRows = enabledFields
    .map((key) => {
      let val = netValues[key];
      if (key === "netSalary")
        val =
          val != null && val !== 0
            ? "Rs. " + Math.round(Number(val)).toLocaleString()
            : "-";
      if (key === "amountInWords") val = val && val !== "-" ? val : "-";
      if (key === "modeOfPayment") val = val || "-";
      if (val == null || val === 0) val = "-";
      return `
      <tr>
        <td style="font-weight:700; color:#334155; padding:10px 10px 10px 14px;">${
          NET_FIELD_LABELS[key] || key
        }</td>
        <td style="font-weight:700; text-align:right; color:#334155; padding:10px 14px 10px 10px;">${val}</td>
      </tr>
    `;
    })
    .join("\n");
  return `
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f1f5f9; border:1px solid #dbeafe; border-radius:10px; font-size:15px;">
      <tr>
        <td colspan="2" style="font-weight:700; color:#1d4ed8; font-size:16.5px; background:#dbeafe; border-top-left-radius:10px; border-top-right-radius:10px; padding:10px 14px; border-bottom:1px solid #e5e7eb;">Net Salary</td>
      </tr>
      ${netRows}
    </table>
  `;
}

function buildSalarySlipHtml({
  employee,
  compensation,
  deductions,
  loans,
  leaves,
  providentFund,
  gratuityFund,
  labels,
  netSalary,
  monthYear,
  company,
  profileFields,
  enabledNetSalaryFields,
  showLoanDetails,
  showProvidentFund,
  showGratuityFund,
  enabledLeaveRecords,
  enabledCompFields,
  enabledDedFields,
  hasActiveLoans,
  isDraft = false, // Flag for draft watermark
}) {
  const amountInWords =
    netSalary != null && netSalary !== 0
      ? `${numberToWords
          .toWords(netSalary)
          .replace(/,/g, "")} Rupees Only`.replace(/(^\w|\s\w)/g, (m) =>
          m.toUpperCase()
        )
      : "-";

  function renderEmployeeTable(empObj, labelObj, profileFieldsOrder = null) {
    const fields =
      Array.isArray(profileFieldsOrder) && profileFieldsOrder.length
        ? profileFieldsOrder
        : Object.keys(empObj);
    const colCount = 3;
    const rows = Math.ceil(fields.length / colCount);
    let html = `<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#fff; border:1px solid #dbeafe; border-radius:12px; margin:0 auto 20px auto;">`;
    for (let i = 0; i < rows; i++) {
      html += "<tr>";
      for (let j = 0; j < colCount; j++) {
        const idx = i * colCount + j;
        const key = fields[idx];
        if (key) {
          let valueToShow =
            empObj[key] != null && empObj[key] !== "" && empObj[key] !== 0
              ? key === "shifts"
                ? Array.isArray(empObj.shifts) && empObj.shifts.length > 0
                  ? empObj.shifts
                      .map((s) =>
                        typeof s === "object" && s && s.name ? s.name : "-"
                      )
                      .join(", ")
                  : "-"
                : key === "phone" ||
                  key === "nomineeEmergencyNo" ||
                  key === "emergencyContactNumber"
                ? formatPhoneNumber(empObj[key])
                : key === "dateOfBirth" ||
                  key === "joiningDate" ||
                  key === "cnicIssueDate" ||
                  key === "cnicExpiryDate"
                ? formatDate(empObj[key])
                : empObj[key]
              : "-";
          html += `
            <td style="padding:10px 14px; font-size:14px; vertical-align:top;">
              <span style="display:block; color:#64748b; font-weight:600;">${
                labelObj?.[key] || PROFILE_LABELS[key] || key
              }</span>
              <span style="color:#111827; font-weight:500; display:block; margin-top:2px;">
                ${valueToShow}
              </span>
            </td>
          `;
        } else {
          html += `<td></td>`;
        }
      }
      html += "</tr>";
    }
    html += "</table>";
    return html;
  }

  function renderSalaryDeductionTables(
    compObj,
    dedObj,
    compLabels = {},
    dedLabels = {},
    enabledCompFields = [],
    enabledDedFields = []
  ) {
    const defaultCompKeys = Object.keys(ALLOWANCES_LABELS);
    const defaultDedKeys = Object.keys(DEDUCTIONS_LABELS);
    const compKeys = enabledCompFields.length
      ? enabledCompFields
      : defaultCompKeys;
    const dedKeys = enabledDedFields.length ? enabledDedFields : defaultDedKeys;

    let compRows = "";
    let dedRows = "";
    let totalEarnings = 0;
    let totalDeductions = 0;

    // Generate rows for allowances in the specified order
    compKeys.forEach((compKey) => {
      const rawVal = compObj[compKey];
      const numVal = Number(rawVal);
      // Only add to totalEarnings if it is a valid number
      if (!isNaN(numVal)) totalEarnings += numVal;
      compRows += `
    <tr>
      <td style="border:1px solid #e5e7eb; padding:10px 18px; color:#111827; font-weight:500; font-size:14px; text-align:left;">
        ${compLabels[compKey] || ALLOWANCES_LABELS[compKey] || compKey}
      </td>
      <td style="border:1px solid #e5e7eb; padding:10px 18px; color:#111827; font-weight:500; font-size:14px; text-align:center;">
        ${safeAmountCell(rawVal)}
      </td>
    </tr>
  `;
    });

    dedKeys.forEach((dedKey) => {
      const rawVal = dedObj[dedKey];
      const numVal = Number(rawVal);
      // Only add to totalDeductions if it is a valid number
      if (!isNaN(numVal)) totalDeductions += numVal;
      dedRows += `
    <tr>
      <td style="border:1px solid #e5e7eb; padding:10px 18px; color:#111827; font-weight:500; font-size:14px; text-align:left;">
        ${dedLabels[dedKey] || DEDUCTIONS_LABELS[dedKey] || dedKey}
      </td>
      <td style="border:1px solid #e5e7eb; padding:10px 18px; color:#111827; font-weight:500; font-size:14px; text-align:center;">
        ${safeAmountCell(rawVal)}
      </td>
    </tr>
  `;
    });

    // Add padding rows if one table has more rows than the other
    const maxRows = Math.max(compKeys.length, dedKeys.length);
    for (let i = compKeys.length; i < maxRows; i++) {
      compRows += `
      <tr>
        <td style="border:1px solid #e5e7eb; padding:9px 18px; color:#64748b; font-size:14px;"> </td>
        <td style="border:1px solid #e5e7eb; padding:9px 18px;"> </td>
      </tr>
    `;
    }
    for (let i = dedKeys.length; i < maxRows; i++) {
      dedRows += `
      <tr>
        <td style="border:1px solid #e5e7eb; padding:9px 18px; color:#64748b; font-size:14px;"> </td>
        <td style="border:1px solid #e5e7eb; padding:9px 18px;"> </td>
      </tr>
    `;
    }

    if (maxRows === 0) {
      compRows = `<tr><td style="border:1px solid #cbd5e1; padding:10px 18px; color:#64748b; font-size:14px;">-</td><td style="border:1px solid #cbd5e1; padding:10px 18px; color:#64748b; font-size:14px;">-</td></tr>`;
      dedRows = `<tr><td style="border:1px solid #cbd5e1; padding:10px 18px; color:#64748b; font-size:14px;">-</td><td style="border:1px solid #cbd5e1; padding:10px 18px; color:#64748b; font-size:14px;">-</td></tr>`;
    }

    return {
      table: `
      <table width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td valign="top" width="50%" style="padding-right:10px;">
            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse; background:#fff; border-radius:10px; border:1px solid #cbd5e1; box-shadow:0 2px 8px 0 rgba(0,0,0,0.04); font-size:0.97rem;">
              <thead><tr><th style="background:#f1f5f9; font-weight:bold; text-align:center; border:1px solid #cbd5e1; padding:11px 18px; font-size:14px;">Salary & Allowance</th><th style="background:#f1f5f9; font-weight:bold; text-align:center; border:1px solid #cbd5e1; padding:11px 18px; font-size:14px;">Amount</th></tr></thead>
              <tbody>${compRows}</tbody>
              <tfoot><tr><td style="background:#dbeafe; color:#15803d; font-weight:bold; border:1px solid #cbd5e1; font-size:14px; padding:10px 18px;">Total Additions</td><td style="background:#dbeafe; color:#15803d; font-weight:bold; border:1px solid #cbd5e1; font-size:14px; text-align:center; padding:10px 18px;">${
                totalEarnings != null && totalEarnings !== 0
                  ? safeAmountCell(totalEarnings)
                  : "-"
              }</td></tr></tfoot>
            </table>
          </td>
          <td valign="top" width="50%" style="padding-left:10px;">
            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse; background:#fff; border-radius:10px; border:1px solid #cbd5e1; box-shadow:0 2px 8px 0 rgba(0,0,0,0.04); font-size:0.97rem;">
              <thead><tr><th style="background:#f1f5f9; font-weight:bold; text-align:center; border:1px solid #cbd5e1; padding:11px 18px; font-size:14px;">Deductions</th><th style="background:#f1f5f9; font-weight:bold; text-align:center; border:1px solid #cbd5e1; padding:11px 18px; font-size:14px;">Amount</th></tr></thead>
              <tbody>${dedRows}</tbody>
              <tfoot><tr><td style="background:#dbeafe; color:#b91c1c; font-weight:bold; border:1px solid #cbd5e1; font-size:14px; padding:10px 18px;">Total Deductions</td><td style="background:#dbeafe; color:#b91c1c; font-weight:bold; border:1px solid #cbd5e1; font-size:14px; text-align:center; padding:10px 18px;">${
                totalDeductions != null && totalDeductions !== 0
                  ? safeAmountCell(totalDeductions)
                  : "-"
              }</td></tr></tfoot>
            </table>
          </td>
        </tr>
      </table>
    `,
      totalEarnings,
      totalDeductions,
    };
  }

  const {
    table: salaryDeductionTable,
    totalEarnings,
    totalDeductions,
  } = renderSalaryDeductionTables(
    compensation || {},
    deductions || {},
    labels?.compensation || {},
    labels?.deductions || {},
    normalizeFields(enabledCompFields, ALLOWANCE_ORDER),
    normalizeFields(enabledDedFields, DEDUCTION_ORDER)
  );

  const employeeTable = renderEmployeeTable(
    employee || {},
    labels?.employee || {},
    profileFields
  );
  const loansHtml =
    showLoanDetails && hasActiveLoans ? renderLoanTable(loans) : "";
  const providentFundHtml = showProvidentFund
    ? renderProvidentFundTable(providentFund)
    : "";
  const gratuityFundHtml = showGratuityFund
    ? renderGratuityFundTable(gratuityFund)
    : "";
  const leavesHtml = renderLeaveTable(leaves, enabledLeaveRecords);
  const netSalaryTable = buildNetSalaryTable({
    netSalary,
    amountInWords,
    enabledNetSalaryFields,
  });

  return `<!DOCTYPE html>
  <html>
    <head>
      <meta charset="UTF-8">
      <title>Pay Slip - ${company.name}</title>
      <style>
        .draft-watermark {
          position: relative;
          background: url('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1000"><text x="400" y="500" font-size="180" font-weight="900" fill="rgba(239, 68, 68, 0.12)" text-anchor="middle" transform="rotate(-45 400 500)" letter-spacing="8">DRAFT</text></svg>') center center no-repeat;
          background-size: contain;
          background-attachment: fixed;
        }
      </style>
    </head>
    <body style="background:#f1f5f9; margin:0; padding:0; font-family:Segoe UI,Arial,sans-serif; color:#1e293b;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f1f5f9;">
        <tr>
          <td align="center">
            <table width="800" cellpadding="0" cellspacing="0" border="0" style="margin:40px auto 20px auto; background:#fff; border-radius:14px; box-shadow:0 4px 20px rgba(0,0,0,0.07); border:1px solid #dbeafe; position:relative;">
              ${isDraft ? `
              <tr>
                <td align="center" valign="middle" style="padding:0; position:absolute; top:0; left:0; width:100%; height:100%; z-index:0; pointer-events:none;">
                  <div style="position:relative; width:100%; height:100%; display:flex; align-items:center; justify-content:center;">
                    <span style="font-size:180px; font-weight:900; color:rgba(239, 68, 68, 0.12); transform:rotate(-45deg); white-space:nowrap; letter-spacing:8px; font-family:Arial, sans-serif;">DRAFT</span>
                  </div>
                </td>
              </tr>
              ` : ''}
              <tr style="position:relative; z-index:1;">
                <td style="padding:24px 32px 16px 32px; border-bottom:1px solid #e5e7eb; position:relative; background:#fff;">
                  <table width="100%">
                    <tr>
                      <td valign="middle" style="padding:0;">
                        <span style="font-size:22px; font-weight:700; color:#1d4ed8;">${
                          company.name
                        }</span><br>
                        <span style="color:#334155; font-size:15px; font-weight:500;">${
                          company.address
                        }</span>
                      </td>
                      <td valign="top" align="right" style="padding:0;">
                        <span style="color:#334155; font-size:18px; font-weight:700;">Pay slip – ${monthYear}</span><br>
                        <span style="color:#64748b; font-size:13px;">Generated: ${new Date().toLocaleString()}</span>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>
              <tr style="position:relative; z-index:1;">
                <td style="padding:32px 32px 8px 32px; position:relative; background:#fff;">${employeeTable}</td>
              </tr>
              <tr style="position:relative; z-index:1;">
                <td style="padding:8px 32px 8px 32px; position:relative; background:#fff;">${salaryDeductionTable}</td>
              </tr>
              <tr style="position:relative; z-index:1;">
                <td style="padding:24px 32px; position:relative; background:#fff;">${netSalaryTable}</td>
              </tr>
              <tr style="position:relative; z-index:1;">
                <td style="padding:10px 32px 24px 32px; position:relative; background:#fff;">${loansHtml}${providentFundHtml}${gratuityFundHtml}${leavesHtml}</td>
              </tr>
              <tr style="position:relative; z-index:1;">
                <td style="padding:16px 32px; color:#64748b; font-size:14px; text-align:center; border-top:1px solid #e5e7eb; position:relative; background:#fff;">
                  This is a system generated pay slip and does not require signature.
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </body>
  </html>`;
}

const ALLOWANCE_ORDER = [
  "basic",
  "dearnessAllowance",
  "houseRentAllowance",
  "conveyanceAllowance",
  "medicalAllowance",
  "utilityAllowance",
  "autoAllowance",
  "fuelAllowance",
  "dislocationAllowance",
  "overtimeCompensation",
  "leaveEncashment",
  "bonus",
  "arrears",
  "incentive",
  "othersAllowances",
  "loanBenefits",
];

const DEDUCTION_ORDER = [
  "eobiDeduction",
  "sessiDeduction",
  "providentFundDeduction",
  "gratuityFundDeduction",
  "taxDeduction",
  "leaveDeductions",
  "lateDeductions",
  "advanceSalaryDeductions",
  "vehicleLoanDeduction",
  "otherLoanDeductions",
  "medicalInsurance",
  "lifeInsurance",
  "penalties",
  "otherDeductions",
];

function normalizeFields(fieldArr, orderArr) {
  const keys = Array.isArray(fieldArr)
    ? fieldArr.map((f) =>
        Array.isArray(f) ? f[1] : typeof f === "object" && f.key ? f.key : f
      )
    : [];
  // Ensure loanBenefits is included if not explicitly disabled
  if (!keys.includes("loanBenefits")) {
    keys.push("loanBenefits");
  }
  return orderArr.filter((key) => keys.includes(key));
}
async function calculateLoanBenefits(employeeId, monthYear, decryptionKey) {
  if (!monthYear) {
    throw new Error("monthYear is required");
  }

  // Extract month and year from monthYear (e.g. "July 2025")
  const [monthNameRaw, yearStr] = monthYear.split(" ");
  const monthName = normMonth(monthNameRaw);
  const year = parseInt(yearStr);

  if (!monthName || !yearStr || isNaN(year)) {
    throw new Error(
      "Invalid monthYear format. Expected format like 'July 2025'"
    );
  }

  // Find all loans for this employee
  const loans = await LoanDetail.find({ employee: employeeId }).lean();

  // Process each loan's payment schedule
  const loanDetails = [];
  let totalLoanBenefits = 0;
  let totalLoanInstallments = 0;

  for (const loan of loans) {
    if (!loan.paymentSchedule || !Array.isArray(loan.paymentSchedule)) continue;

    // Find the matching schedule entry for current month
    const currentMonthEntry = loan.paymentSchedule.find(
      (ps) => normMonth(ps.month) === monthName && Number(ps.year) === year
    );

    if (!currentMonthEntry) continue;

    try {
      // Decrypt the relevant amounts
      const loanAmount = loan.loanAmount
        ? parseFloat(await decrypt(loan.loanAmount, decryptionKey)) || 0
        : 0;

      const totalMarkup = loan.totalMarkup
        ? parseFloat(await decrypt(loan.totalMarkup, decryptionKey)) || 0
        : 0;

      const totalToBePaid = loan.totalToBePaid
        ? parseFloat(await decrypt(loan.totalToBePaid, decryptionKey)) || 0
        : 0;

      const currentMonthMarkup = currentMonthEntry.markupAmount
        ? parseFloat(
            await decrypt(currentMonthEntry.markupAmount, decryptionKey)
          ) || 0
        : 0;

      let currentMonthPayment = 0;
      let currentMonthPrincipal = 0;
      
      if (currentMonthEntry.totalPayment) {
        currentMonthPayment =
          parseFloat(
            await decrypt(currentMonthEntry.totalPayment, decryptionKey)
          ) || 0;
      } else if (loan.monthlyInstallment) {
        currentMonthPayment =
          parseFloat(await decrypt(loan.monthlyInstallment, decryptionKey)) ||
          0;
      }
      
      // Calculate current month principal (total payment - markup)
      currentMonthPrincipal = Math.max(0, currentMonthPayment - currentMonthMarkup);

      // Calculate previous months PRINCIPAL payments (all principal payments before current month)
      let previousMonthsPrincipal = 0;
      let previousMonthsTotalPayment = 0;
      
      for (const scheduleEntry of loan.paymentSchedule) {
        const scheduleYear = Number(scheduleEntry.year);
        const scheduleMonth = normMonth(scheduleEntry.month);
        const currentMonthIndex = monthsList.indexOf(monthName);
        const scheduleMonthIndex = monthsList.indexOf(scheduleMonth);

        // Check if this schedule entry is before the current month
        const isBeforeCurrentMonth =
          scheduleYear < year ||
          (scheduleYear === year && scheduleMonthIndex < currentMonthIndex);

        if (isBeforeCurrentMonth) {
          let entryTotalPayment = 0;
          let entryMarkup = 0;
          
          if (scheduleEntry.totalPayment) {
            entryTotalPayment =
              parseFloat(
                await decrypt(scheduleEntry.totalPayment, decryptionKey)
              ) || 0;
          }
          
          if (scheduleEntry.markupAmount) {
            entryMarkup =
              parseFloat(
                await decrypt(scheduleEntry.markupAmount, decryptionKey)
              ) || 0;
          }
          
          // Calculate principal for this entry
          const entryPrincipal = Math.max(0, entryTotalPayment - entryMarkup);
          previousMonthsPrincipal += entryPrincipal;
          previousMonthsTotalPayment += entryTotalPayment;
        }
      }

      // Get outstanding balance from current month's schedule entry (if available)
      // This should be the principal balance AFTER this month's payment
      let principalBalance = 0;
      if (currentMonthEntry.outstanding) {
        principalBalance = parseFloat(
          await decrypt(currentMonthEntry.outstanding, decryptionKey)
        ) || 0;
      } else {
        // Calculate principal balance if outstanding field is not available
        // Principal balance = original loan amount - (previous principal + current principal)
        principalBalance = Math.max(
          0, 
          loanAmount - (previousMonthsPrincipal + currentMonthPrincipal)
        );
      }

      // Calculate remaining markup balance (future markup payments)
      let remainingMarkup = 0;
      for (const scheduleEntry of loan.paymentSchedule) {
        const scheduleYear = Number(scheduleEntry.year);
        const scheduleMonth = normMonth(scheduleEntry.month);
        const currentMonthIndex = monthsList.indexOf(monthName);
        const scheduleMonthIndex = monthsList.indexOf(scheduleMonth);

        // Check if this schedule entry is after the current month
        const isAfterCurrentMonth =
          scheduleYear > year ||
          (scheduleYear === year && scheduleMonthIndex > currentMonthIndex);

        if (isAfterCurrentMonth && scheduleEntry.markupAmount) {
          const futureMarkup =
            parseFloat(
              await decrypt(scheduleEntry.markupAmount, decryptionKey)
            ) || 0;
          remainingMarkup += futureMarkup;
        }
      }

      // Calculate TOTAL paid so far (for reference)
      const totalPaidSoFar = previousMonthsTotalPayment + currentMonthPayment;
      
      // NET BALANCE: Just the principal balance (NOT principal + markup)
      const netBalance = principalBalance;

      loanDetails.push({
        type: loan.type || "Personal Loan",
        amountPaidCurrentMonth: currentMonthPayment, // Total installment for current month
        amountPaidPreviousMonths: previousMonthsPrincipal, // Only principal for previous months
        balancePrincipal: principalBalance,
        balanceMarkup: remainingMarkup,
        netBalance: netBalance, // Just the principal balance
        // Additional details for reference
        loanAmount: loanAmount,
        totalMarkup: totalMarkup,
        totalToBePaid: totalToBePaid,
        markupAmount: currentMonthMarkup,
        markupValue: loan.markupValue || 0,
        markupType: loan.markupType || "fixed",
        loanId: loan._id.toString(),
        // For debugging/verification
        totalPaidSoFar: totalPaidSoFar,
        principalPaidSoFar: previousMonthsPrincipal + currentMonthPrincipal
      });

      totalLoanBenefits += currentMonthMarkup;
      totalLoanInstallments += currentMonthPayment;
    } catch (e) {
      console.error(`Decryption failed for loan ${loan._id}:`, e);
      continue;
    }
  }

  return {
    loanDetails,
    totalLoanBenefits,
    totalLoanInstallments,
  };
}

module.exports = async function sendSlipEmail(req, res) {
  try {
    // Fetch company profile
    const companyProfile = await CompanyProfile.findOne({
      owner: req.user._id,
    }).lean();
    const company = {
      name: companyProfile?.name || "Company Name",
      address: companyProfile?.address || "",
      email: companyProfile?.email || "",
    };

    // Fetch salary fields configuration
    const salaryFieldsDoc = await SalarySlipFields.findOne({
      owner: req.user._id,
    }).lean();
    const enabledNetSalaryFields =
      salaryFieldsDoc?.enabledNetSalaryFields || [];
    const showLoanDetails = salaryFieldsDoc?.showLoanDetails !== false;
    const showProvidentFund = salaryFieldsDoc?.showProvidentFund !== false;
    const showGratuityFund = salaryFieldsDoc?.showGratuityFund !== false;
    const enabledLeaveRecords = salaryFieldsDoc?.enabledLeaveRecords || [];

    // Ensure loanBenefits is included in enabledCompFields
    let enabledCompFields = normalizeFields(
      salaryFieldsDoc?.enabledSalaryFields || [...ALLOWANCE_ORDER],
      ALLOWANCE_ORDER
    );
    if (!enabledCompFields.includes("loanBenefits")) {
      enabledCompFields.push("loanBenefits");
    }
    const enabledDedFields = normalizeFields(
      salaryFieldsDoc?.enabledDeductionFields || DEDUCTION_ORDER,
      DEDUCTION_ORDER
    );

    const {
      slipId,
      employee,
      providentFund,
      gratuityFund,
      labels,
      monthYear: monthYearFromBody,
      email,
      profileFields,
      decryptionKey,
      compensation,
      deductions,
      netSalary,
      loans: manualLoans, // Allow manual loan data to be passed
      isDraft = false, // Flag for draft watermark
    } = req.body;

    let slip,
      employeeData,
      compensationData,
      deductionsData,
      netSalaryData,
      leaves = {},
      loans = [],
      providentFundData = {},
      gratuityFundData = {};
    let hasActiveLoans = false;

    if (slipId) {
      // Database-driven slip
      slip = await SalarySlip.findById(slipId)
        .populate({
          path: "employee",
          populate: { path: "shifts" },
        })
        .lean();
      if (!slip) {
        return res
          .status(404)
          .json({ success: false, message: "Salary slip not found" });
      }

      // Fetch leave records
      leaves = {
        annualEntitled: "-",
        annualAvailedYTD: "-",
        annualAvailedMTH: "-",
        annualBalance: "-",
        casualEntitled: "-",
        casualAvailedYTD: "-",
        casualAvailedMTH: "-",
        casualBalance: "-",
        sickEntitled: "-",
        sickAvailedYTD: "-",
        sickAvailedMTH: "-",
        sickBalance: "-",
        wopEntitled: "-",
        wopAvailedYTD: "-",
        wopAvailedMTH: "-",
        wopBalance: "-",
        otherEntitled: "-",
        otherAvailedYTD: "-",
        otherAvailedMTH: "-",
        otherBalance: "-",
      };

      // --- New monthly leave calculation (uses the helper)
      if (slip && slip.employee && slip.employee._id) {
        // Get month/year for this slip (e.g., "July 2025" => "July", 2025)
        let slipMonth = "";
        let slipYear = "";
        if (monthYearFromBody) {
          const [m, y] = monthYearFromBody.split(" ");
          slipMonth = m;
          slipYear = Number(y);
        } else {
          const now = new Date();
          slipMonth = now.toLocaleString("en-US", { month: "long" });
          slipYear = now.getFullYear();
        }

        // Get entitlement (total + bonus) exactly like your router
        const emp = slip.employee;
        const total = emp.leaveEntitlement?.total || 0;
        const bonus = emp.leaveEntitlement?.bonus || 0;
        const entitled = total + bonus;

        // Calculate using the exact same helper as in router
        const leaveSummaryResult =
          await leaveSummary.calculateYTDLeaveWithRunningBalance(
            emp._id,
            entitled,
            slipYear,
            slipMonth
          );

        // Fill your leaves object accordingly (annual only, for now)
        leaves.annualEntitled = total;
        leaves.annualAvailedYTD = leaveSummaryResult.ytdUsed;
        leaves.annualAvailedMTH = leaveSummaryResult.monthUsed;
        leaves.annualBalance = leaveSummaryResult.balance;
        leaves.annualBonus = bonus;
      }

      // Decrypt fields
      const decryptField = async (encryptedValue) => {
        if (!encryptedValue || encryptedValue === "" || encryptedValue === 0)
          return "-";
        if (!decryptionKey) return "[Decryption Error]";
        try {
          return await decrypt(encryptedValue, decryptionKey);
        } catch (err) {
          return "[Decryption Error]";
        }
      };

      const employeeId = slip.employee?._id;

      // Calculate loan benefits and details
      let totalLoanBenefits = 0;
      hasActiveLoans = false;

      if (employeeId && showLoanDetails) {
        try {
          const loanData = await calculateLoanBenefits(
            employeeId,
            monthYearFromBody ||
              new Date().toLocaleDateString("en-GB", {
                month: "long",
                year: "numeric",
              }),
            decryptionKey
          );
          loans = loanData.loanDetails || [];
          totalLoanBenefits = loanData.totalLoanBenefits || 0;
          hasActiveLoans = loans.length > 0;

          console.log("Loan calculation result:", {
            loansCount: loans.length,
            totalLoanBenefits,
            hasActiveLoans,
            loans: loans.map((loan) => ({
              type: loan.type,
              currentMonth: loan.amountPaidCurrentMonth,
              previousMonths: loan.amountPaidPreviousMonths,
              principalBalance: loan.balancePrincipal,
              markupBalance: loan.balanceMarkup,
              netBalance: loan.netBalance,
            })),
          });
        } catch (error) {
          console.error("Error calculating loan benefits:", error);
          loans = [];
          totalLoanBenefits = 0;
          hasActiveLoans = false;
        }
      }

      // Compensation
      const compensationPromises = enabledCompFields
        .filter((key) => key !== "loanBenefits") // Handle loanBenefits separately
        .map(async (key) => [key, await decryptField(slip[key])]);
      compensationData = Object.fromEntries(
        await Promise.all(compensationPromises)
      );
      // Add loan benefits to compensation
      compensationData.loanBenefits = totalLoanBenefits;

      // Deductions
      deductionsData = {};
      for (const key of enabledDedFields) {
        if (
          (key === "otherLoanDeductions" || key === "vehicleLoanDeduction") &&
          slip.loanDeductions &&
          typeof slip.loanDeductions === "object"
        ) {
          let encrypted;
          if (key === "otherLoanDeductions")
            encrypted = slip.loanDeductions.otherLoans;
          if (key === "vehicleLoanDeduction")
            encrypted = slip.loanDeductions.vehicleLoan;
          deductionsData[key] = await decryptField(encrypted);
        } else {
          deductionsData[key] = await decryptField(slip[key]);
        }
      }

      // Convert to numbers for calculations
      const toSafeNumber = (v) =>
        v === "-" ||
        v === undefined ||
        v === null ||
        v === "" ||
        isNaN(Number(v))
          ? 0
          : Number(v);
      compensationData = Object.fromEntries(
        Object.entries(compensationData).map(([k, v]) => [k, toSafeNumber(v)])
      );
      deductionsData = Object.fromEntries(
        Object.entries(deductionsData).map(([k, v]) => [k, toSafeNumber(v)])
      );

      // Net salary
      const totalEarnings = enabledCompFields.reduce(
        (sum, key) => sum + (compensationData[key] || 0),
        0
      );
      const totalDeductions = enabledDedFields.reduce(
        (sum, key) => sum + (deductionsData[key] || 0),
        0
      );
      netSalaryData = totalEarnings - totalDeductions;

      // Employee data
      employeeData = slip.employee;

      // Provident Fund Calculations
      const basicSalary = Number(await decryptField(slip.basic)) || 0;
      const pfRate =
        Number(await decryptField(slip.employee?.providentFund?.pfRate)) || 0;
      const pfContribution = pfRate > 0 ? (basicSalary * pfRate) / 100 : 0;
      const pfBalanceBroughtForward =
        Number(await decryptField(slip.pf_balanceBF)) || pfContribution;
      providentFundData = {
        providentFundBalanceBF:
          pfBalanceBroughtForward != null && pfBalanceBroughtForward !== 0
            ? safeAmountCell(pfBalanceBroughtForward)
            : "-",
        employeeProvidentFundContribution:
          pfRate != null && pfRate !== 0 ? `${pfRate}%` : "-",
        employerProvidentFundContribution:
          pfRate != null && pfRate !== 0 ? `${pfRate}%` : "-",
        providentFundWithdrawal: "-",
        providentFundProfit: "-",
        providentFundBalance:
          pfBalanceBroughtForward != null && pfBalanceBroughtForward !== 0
            ? safeAmountCell(pfBalanceBroughtForward)
            : "-",
      };

      // Gratuity Fund Calculations
      const currentDate = new Date();
      const yearsOfService = calculateYearsOfService(
        slip.employee?.joiningDate,
        currentDate
      );
      const monthlyContribution =
        netSalaryData > 0 && yearsOfService > 0
          ? Number(
              (
                (netSalaryData * yearsOfService) /
                (yearsOfService * 12)
              ).toFixed(2)
            )
          : 0;
      const gfBalanceBroughtForward =
        netSalaryData > 0 && yearsOfService > 0
          ? Number((monthlyContribution * (yearsOfService * 12)).toFixed(2))
          : 0;
      const gfWithdrawal = Number(await decryptField(slip.gf_withdrawal)) || 0;
      const gfProfit = Number(await decryptField(slip.gf_profit)) || 0;
      const gfBalance = gfBalanceBroughtForward - gfWithdrawal + gfProfit;
      gratuityFundData = {
        gratuityFundBalanceBF:
          gfBalanceBroughtForward != null && gfBalanceBroughtForward !== 0
            ? safeAmountCell(gfBalanceBroughtForward)
            : "-",
        yearsOfService:
          yearsOfService != null && yearsOfService !== 0 ? yearsOfService : "-",
        monthlyContribution:
          monthlyContribution != null && monthlyContribution !== 0
            ? safeAmountCell(monthlyContribution)
            : "-",
        gratuityFundWithdrawal:
          gfWithdrawal != null && gfWithdrawal !== 0
            ? safeAmountCell(gfWithdrawal)
            : "-",
        gratuityFundProfit:
          gfProfit != null && gfProfit !== 0 ? safeAmountCell(gfProfit) : "-",
        gratuityFundBalance:
          gfBalance != null && gfBalance !== 0
            ? safeAmountCell(gfBalance)
            : "-",
      };
    } else {
      // Manual slip mode
      if (
        !employee ||
        !email ||
        !compensation ||
        !deductions ||
        netSalary == null
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Missing required fields: employee, email, compensation, deductions, or netSalary",
        });
      }

      // Validate email format
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email)) {
        return res
          .status(400)
          .json({ success: false, message: "Invalid email address" });
      }

      // Use provided data directly
      employeeData = employee;
      compensationData = compensation;
      deductionsData = deductions;
      netSalaryData = netSalary;

      // LOAN DATA: use loan field if provided, else empty array (needed by renderLoanTable)
      loans = Array.isArray(manualLoans)
        ? manualLoans
        : req.body.loan
        ? [req.body.loan]
        : [];

      // Set hasActiveLoans based on provided loans
      hasActiveLoans = loans.length > 0;

      // LEAVE DATA: use leaves field if provided, else default object (needed by renderLeaveTable)
      leaves = req.body.leaves || {
        annualEntitled: "-",
        annualAvailedYTD: "-",
        annualAvailedMTH: "-",
        annualBalance: "-",
        casualEntitled: "-",
        casualAvailedYTD: "-",
        casualAvailedMTH: "-",
        casualBalance: "-",
        sickEntitled: "-",
        sickAvailedYTD: "-",
        sickAvailedMTH: "-",
        sickBalance: "-",
        wopEntitled: "-",
        wopAvailedYTD: "-",
        wopAvailedMTH: "-",
        wopBalance: "-",
        otherEntitled: "-",
        otherAvailedYTD: "-",
        otherAvailedMTH: "-",
        otherBalance: "-",
      };

      // Provident Fund & Gratuity Fund
      providentFundData = {
        providentFundBalanceBF: "-",
        employeeProvidentFundContribution: "-",
        employerProvidentFundContribution: "-",
        providentFundWithdrawal: "-",
        providentFundProfit: "-",
        providentFundBalance: "-",
      };
      gratuityFundData = {
        gratuityFundBalanceBF: "-",
        yearsOfService: "-",
        monthlyContribution: "-",
        gratuityFundWithdrawal: "-",
        gratuityFundProfit: "-",
        gratuityFundBalance: "-",
      };

      if (providentFund) {
        providentFundData = { ...providentFundData, ...providentFund };
      }
      if (gratuityFund) {
        gratuityFundData = { ...gratuityFundData, ...gratuityFund };
      }
    }

    // Month/Year handling
    let monthYear = monthYearFromBody;
    if (!monthYear) {
      monthYear = new Date().toLocaleDateString("en-GB", {
        month: "long",
        year: "numeric",
      });
    }

    // Labels (use provided labels or defaults)
    const labelsData = labels || {
      compensation: Object.fromEntries(
        enabledCompFields.map((key) => [key, ALLOWANCES_LABELS[key] || key])
      ),
      deductions: Object.fromEntries(
        enabledDedFields.map((key) => [key, DEDUCTIONS_LABELS[key] || key])
      ),
      employee: PROFILE_LABELS,
    };

    // Debug logging
    console.log("Final loan data for email:", {
      showLoanDetails,
      hasActiveLoans,
      loansCount: loans.length,
      loans: loans,
    });

    // Generate HTML
    const html = buildSalarySlipHtml({
      employee: employeeData,
      compensation: compensationData,
      deductions: deductionsData,
      loans,
      leaves,
      providentFund: providentFundData,
      gratuityFund: gratuityFundData,
      labels: labelsData,
      netSalary: netSalaryData,
      monthYear,
      company,
      profileFields: profileFields || [
        ...enabledCompFields,
        ...enabledDedFields,
      ],
      enabledNetSalaryFields,
      showLoanDetails,
      showProvidentFund,
      showGratuityFund,
      enabledLeaveRecords,
      enabledCompFields,
      enabledDedFields,
      hasActiveLoans,
      isDraft, // Pass draft flag
    });

    // Send email
    const transporter = nodemailer.createTransport({
      host: process.env.MAIL_HOST,
      port: Number(process.env.MAIL_PORT),
      secure: process.env.MAIL_ENCRYPTION === "ssl",
      auth: {
        user: process.env.MAIL_USERNAME,
        pass: process.env.MAIL_PASSWORD,
      },
    });

    console.log("Sending email with loan details:", {
      hasActiveLoans,
      loansCount: loans.length,
      showLoanDetails,
    });

    await transporter.sendMail({
      from: `"${process.env.MAIL_FROM_NAME || "HR System"}" <${
        process.env.MAIL_FROM_ADDRESS
      }>`,
      to: email,
      subject: `Salary Slip${
        employeeData?.name ? " - " + employeeData.name : ""
      }`,
      html,
    });

    res.json({ success: true, message: "Email sent!" });
  } catch (err) {
    console.error("Email sending error:", err);
    res.status(500).json({
      success: false,
      message: "Failed to send email",
      error: err.message,
    });
  }
};
