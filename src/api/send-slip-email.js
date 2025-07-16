const CompanyProfile = require('../models/CompanyProfile');
const SalarySlipFields = require('../models/SalarySlipFields');
const LoanDetail = require('../models/LoanDetail');
const nodemailer = require("nodemailer");
const numberToWords = require("number-to-words");
const SalarySlip = require('../models/SalarySlip');
const LeaveRecord = require('../models/LeaveRecord');

// Helper to format numbers as currency
function formatDate(dt) {
  if (!dt) return "-";
  try {
    return new Date(dt).toLocaleDateString("en-GB", {
      day: "2-digit",
      month: "long",
      year: "numeric",
    }).replace(/ (\d{4})$/, ", $1");
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

// Table columns for funds
const PROVIDENT_FUND_FIELDS = [
  { label: "Balance Brought Forward", key: "providentFundBalanceBF" },
  { label: "Employee Contribution", key: "employeeProvidentFundContribution" },
  { label: "Employer Contribution", key: "employerProvidentFundContribution" },
  { label: "Withdrawal", key: "providentFundWithdrawal" },
  { label: "Profit", key: "providentFundProfit" },
  { label: "Balance", key: "providentFundBalance" }
];
const GRATUITY_FUND_FIELDS = [
  { label: "Balance Brought Forward", key: "gratuityFundBalanceBF" },
  { label: "Employee Contribution", key: "employeeGratuityFundContribution" },
  { label: "Employer Contribution", key: "employerGratuityFundContribution" },
  { label: "Withdrawal", key: "gratuityFundWithdrawal" },
  { label: "Profit", key: "gratuityFundProfit" },
  { label: "Balance", key: "gratuityFundBalance" }
];

// Render the Loan Table
function renderLoanTable(loans = []) {
  const arr = Array.isArray(loans) && loans.length ? loans : [{}];
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
          ${arr.map(loan => {
    let paidPrev = '-';
    if (Array.isArray(loan.paymentSchedule) && loan.paymentSchedule.length > 0) {
      const paid = loan.paymentSchedule.slice(0, -1).reduce((sum, payment) => sum + (payment.amount || 0), 0);
      paidPrev = paid ? paid.toLocaleString() : '-';
    }
    return `
              <tr>
                <td style="padding:8px 6px; border:1px solid #e5e7eb; text-align:center;">${loan.type || '-'}</td>
                <td style="padding:8px 6px; border:1px solid #e5e7eb; text-align:center;">${loan.monthlyInstallment != null ? loan.monthlyInstallment.toLocaleString() : '-'}</td>
                <td style="padding:8px 6px; border:1px solid #e5e7eb; text-align:center;">${paidPrev}</td>
                <td style="padding:8px 6px; border:1px solid #e5e7eb; text-align:center;">${loan.loanAmount != null ? loan.loanAmount.toLocaleString() : '-'}</td>
                <td style="padding:8px 6px; border:1px solid #e5e7eb; text-align:center;">${loan.totalMarkup != null ? loan.totalMarkup.toLocaleString() : '-'}</td>
                <td style="padding:8px 6px; border:1px solid #e5e7eb; text-align:center;">${loan.totalToBePaid != null ? loan.totalToBePaid.toLocaleString() : '-'}</td>
              </tr>
            `;
  }).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function renderProvidentFundTable(data = {}) {
  return `
    <div style="margin-bottom: 24px;">
      <div style="font-weight:bold; color:#1d4ed8; background:#dbeafe; border-radius:8px 8px 0 0; padding:8px 18px;">
        Provident Fund
      </div>
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse; background:#f8fafc;">
        <thead>
          <tr style="background:#f1f5f9;">
            ${PROVIDENT_FUND_FIELDS.map(f => `<th style="padding:10px 6px; border:1px solid #e5e7eb;">${f.label}</th>`).join("")}
          </tr>
        </thead>
        <tbody>
          <tr>
            ${PROVIDENT_FUND_FIELDS.map(f => `<td style="padding:8px 6px; border:1px solid #e5e7eb; text-align:center;">${data && data[f.key] != null && data[f.key] !== "" && data[f.key] !== 0 ? data[f.key] : "-"}</td>`).join("")}
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
            ${GRATUITY_FUND_FIELDS.map(f => `<th style="padding:10px 6px; border:1px solid #e5e7eb;">${f.label}</th>`).join("")}
          </tr>
        </thead>
        <tbody>
          <tr>
            ${GRATUITY_FUND_FIELDS.map(f => `<td style="padding:8px 6px; border:1px solid #e5e7eb; text-align:center;">${data && data[f.key] != null && data[f.key] !== "" && data[f.key] !== 0 ? data[f.key] : "-"}</td>`).join("")}
          </tr>
        </tbody>
      </table>
    </div>
  `;
}

// Render Leave Table
function renderLeaveTable(leaves = {}, enabledLeaveRecords = []) {
  if (!Array.isArray(enabledLeaveRecords) || !enabledLeaveRecords.length) return "";
  const cols = ["Entitled", "AvailedYTD", "AvailedMTH", "Balance"];
  const colLabel = { Entitled: "Entitled", AvailedYTD: "Availed (YTD)", AvailedMTH: "Availed (MTH)", Balance: "Balance" };
  const typeLabel = { casual: "Casual", sick: "Sick", annual: "Annual", wop: "WOP", other: "Other" };
  return `
    <div style="margin: 24px 0;">
      <div style="font-weight:bold; color:#1d4ed8; background:#dbeafe; border-radius:8px 8px 0 0; padding:8px 18px;">Leave Records</div>
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse; background:#f8fafc;">
        <thead>
          <tr style="background:#f1f5f9;">
            <th style="padding:10px 6px; border:1px solid #e5e7eb;">Leave Type</th>
            ${cols.map(c => `<th style="padding:10px 6px; border:1px solid #e5e7eb;">${colLabel[c]}</th>`).join("")}
          </tr>
        </thead>
        <tbody>
          ${enabledLeaveRecords.map(type => `
            <tr>
              <td style="padding:8px 6px; border:1px solid #e5e7eb; text-align:center;">${typeLabel[type] || type}</td>
              ${cols.map(col => {
    const key = `${type.toLowerCase()}${col}`;
    const val = leaves && leaves[key] != null && leaves[key] !== "" && leaves[key] !== 0 ? leaves[key] : "-";
    return `<td style="padding:8px 6px; border:1px solid #e5e7eb; text-align:center;">${val}</td>`;
  }).join("")}
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;
}

// Net Salary Table Builder
function buildNetSalaryTable({ netSalary, amountInWords, enabledNetSalaryFields }) {
  const NET_FIELD_LABELS = { netSalary: "Net Salary", amountInWords: "Amount in Words", modeOfPayment: "Mode of Payment" };
  const netValues = { netSalary: netSalary, amountInWords: amountInWords, modeOfPayment: "Bank Transfer" };
  const enabledFields = Array.isArray(enabledNetSalaryFields) && enabledNetSalaryFields.length ? enabledNetSalaryFields : ["netSalary", "amountInWords", "modeOfPayment"];
  const netRows = enabledFields.map(key => {
    let val = netValues[key];
    if (key === "netSalary") val = val !== undefined && val !== null && val !== 0 ? "Rs. " + Number(val).toLocaleString() : "-";
    if (key === "amountInWords") val = val || "-";
    if (key === "modeOfPayment") val = val || "-";
    if (val === undefined || val === null || val === 0) val = "-";
    return `
      <tr>
        <td style="font-weight:700; color:#334155; padding:10px 10px 10px 14px;">${NET_FIELD_LABELS[key] || key}</td>
        <td style="font-weight:700; text-align:right; color:#334155; padding:10px 14px 10px 10px;">${val}</td>
      </tr>
    `;
  }).join("\n");
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
}) {
  const amountInWords = netSalary > 0 ? `${numberToWords.toWords(netSalary).replace(/,/g, "")} Rupees Only`.replace(/(^\w|\s\w)/g, m => m.toUpperCase()) : "-";

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
            empObj[key] !== null && empObj[key] !== undefined && empObj[key] !== ""
              ? key === "shifts"
                ? Array.isArray(empObj.shifts) && empObj.shifts.length > 0
                  ? empObj.shifts
                      .map((s) => (typeof s === "object" && s && s.name ? s.name : "-"))
                      .join(", ")
                  : "-"
                : key === "phone" || key === "nomineeEmergencyNo" || key === "emergencyContactNumber"
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


  function renderSalaryDeductionTables(compObj, dedObj, compLabels = {}, dedLabels = {}, enabledCompFields = [], enabledDedFields = []) {
    const defaultCompKeys = Object.keys(ALLOWANCES_LABELS);
    const defaultDedKeys = Object.keys(DEDUCTIONS_LABELS);
    const compKeys = enabledCompFields.length ? enabledCompFields : defaultCompKeys;
    const dedKeys = enabledDedFields.length ? enabledDedFields : defaultDedKeys;

    let compRows = "";
    let dedRows = "";
    let totalEarnings = 0;
    let totalDeductions = 0;

    // Generate rows for allowances in the specified order
    compKeys.forEach((compKey) => {
      const compVal = Number(compObj[compKey]) || 0;
      totalEarnings += compVal;
      compRows += `
      <tr>
        <td style="border:1px solid #e5e7eb; padding:10px 18px; color:#111827; font-weight:500; font-size:14px; text-align:left;">
          ${compLabels[compKey] || ALLOWANCES_LABELS[compKey] || compKey}
        </td>
        <td style="border:1px solid #e5e7eb; padding:10px 18px; color:#111827; font-weight:500; font-size:14px; text-align:center;">
          ${compVal ? compVal.toLocaleString() : "-"}
        </td>
      </tr>
    `;
    });

    // Generate rows for deductions in the specified order
    dedKeys.forEach((dedKey) => {
      const dedVal = Number(dedObj[dedKey]) || 0;
      totalDeductions += dedVal;
      dedRows += `
      <tr>
        <td style="border:1px solid #e5e7eb; padding:10px 18px; color:#111827; font-weight:500; font-size:14px; text-align:left;">
          ${dedLabels[dedKey] || DEDUCTIONS_LABELS[dedKey] || dedKey}
        </td>
        <td style="border:1px solid #e5e7eb; padding:10px 18px; color:#b91c1c; font-weight:500; font-size:14px; text-align:center;">
          ${dedVal ? dedVal.toLocaleString() : "-"}
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
              <tfoot><tr><td style="background:#dbeafe; color:#15803d; font-weight:bold; border:1px solid #cbd5e1; font-size:14px; padding:10px 18px;">Total Additions</td><td style="background:#dbeafe; color:#15803d; font-weight:bold; border:1px solid #cbd5e1; font-size:14px; text-align:center; padding:10px 18px;">${totalEarnings.toLocaleString()}</td></tr></tfoot>
            </table>
          </td>
          <td valign="top" width="50%" style="padding-left:10px;">
            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse; background:#fff; border-radius:10px; border:1px solid #cbd5e1; box-shadow:0 2px 8px 0 rgba(0,0,0,0.04); font-size:0.97rem;">
              <thead><tr><th style="background:#f1f5f9; font-weight:bold; text-align:center; border:1px solid #cbd5e1; padding:11px 18px; font-size:14px;">Deductions</th><th style="background:#f1f5f9; font-weight:bold; text-align:center; border:1px solid #cbd5e1; padding:11px 18px; font-size:14px;">Amount</th></tr></thead>
              <tbody>${dedRows}</tbody>
              <tfoot><tr><td style="background:#dbeafe; color:#b91c1c; font-weight:bold; border:1px solid #cbd5e1; font-size:14px; padding:10px 18px;">Total Deductions</td><td style="background:#dbeafe; color:#b91c1c; font-weight:bold; border:1px solid #cbd5e1; font-size:14px; text-align:center; padding:10px 18px;">${totalDeductions.toLocaleString()}</td></tr></tfoot>
            </table>
          </td>
        </tr>
      </table>
    `,
      totalEarnings,
      totalDeductions,
    };
  }

  const { table: salaryDeductionTable } = renderSalaryDeductionTables(
    compensation || {},
    deductions || {},
    labels?.compensation || {},
    labels?.deductions || {},
    normalizeFields(enabledCompFields),
    normalizeFields(enabledDedFields)
  );

  const employeeTable = renderEmployeeTable(employee || {}, labels?.employee || {}, profileFields);
  const loansHtml = showLoanDetails ? renderLoanTable(loans) : "";
  const providentFundHtml = showProvidentFund ? renderProvidentFundTable(providentFund) : "";
  const gratuityFundHtml = showGratuityFund ? renderGratuityFundTable(gratuityFund) : "";
  const leavesHtml = renderLeaveTable(leaves, enabledLeaveRecords);
  const netSalaryTable = buildNetSalaryTable({ netSalary, amountInWords, enabledNetSalaryFields });

  return `<!DOCTYPE html>
  <html>
    <head>
      <meta charset="UTF-8">
      <title>Pay Slip - ${company.name}</title>
    </head>
    <body style="background:#f1f5f9; margin:0; padding:0; font-family:Segoe UI,Arial,sans-serif; color:#1e293b;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f1f5f9;">
        <tr>
          <td align="center">
            <table width="800" cellpadding="0" cellspacing="0" border="0" style="margin:40px auto 20px auto; background:#fff; border-radius:14px; box-shadow:0 4px 20px rgba(0,0,0,0.07); border:1px solid #dbeafe;">
              <tr>
                <td style="padding:24px 32px 16px 32px; border-bottom:1px solid #e5e7eb;">
                  <table width="100%">
                    <tr>
                      <td valign="middle" style="padding:0;">
                        <span style="font-size:22px; font-weight:700; color:#1d4ed8;">${company.name}</span><br>
                        <span style="color:#334155; font-size:15px; font-weight:500;">${company.address}</span>
                      </td>
                      <td valign="top" align="right" style="padding:0;">
                        <span style="color:#334155; font-size:18px; font-weight:700;">Pay slip – ${monthYear}</span><br>
                        <span style="color:#64748b; font-size:13px;">Generated: ${new Date().toLocaleString()}</span>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>
              <tr>
                <td style="padding:32px 32px 8px 32px;">${employeeTable}</td>
              </tr>
              <tr>
                <td style="padding:8px 32px 8px 32px;">${salaryDeductionTable}</td>
              </tr>
              <tr>
                <td style="padding:24px 32px;">${netSalaryTable}</td>
              </tr>
              <tr>
                <td style="padding:10px 32px 24px 32px;">${loansHtml}${providentFundHtml}${gratuityFundHtml}${leavesHtml}</td>
              </tr>
              <tr>
                <td style="padding:16px 32px; color:#64748b; font-size:14px; text-align:center; border-top:1px solid #e5e7eb;">
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
function normalizeFields(fieldArr) {
  return Array.isArray(fieldArr)
    ? fieldArr.map(f =>
      Array.isArray(f) ? f[1] : (typeof f === "object" && f.key ? f.key : f)
    )
    : [];
}

module.exports = async function sendSlipEmail(req, res) {
  try {
    const companyProfile = await CompanyProfile.findOne({ owner: req.user._id }).lean();
    const company = {
      name: companyProfile?.name || 'Company Name',
      address: companyProfile?.address || '',
      email: companyProfile?.email || '',
    };

    const salaryFieldsDoc = await SalarySlipFields.findOne({ owner: req.user._id }).lean();
    const enabledNetSalaryFields = salaryFieldsDoc?.enabledNetSalaryFields || [];
    const showLoanDetails = salaryFieldsDoc?.showLoanDetails !== false;
    const showProvidentFund = salaryFieldsDoc?.showProvidentFund !== false;
    const showGratuityFund = salaryFieldsDoc?.showGratuityFund !== false;
    const enabledLeaveRecords = salaryFieldsDoc?.enabledLeaveRecords || [];
    const enabledCompFields = normalizeFields(salaryFieldsDoc?.enabledSalaryFields || [
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
    ]);
    const enabledDedFields = normalizeFields(salaryFieldsDoc?.enabledDeductionFields || [
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
    ]);


    const { employee, providentFund, gratuityFund, labels, monthYear: monthYearFromBody, email, profileFields } = req.body;

    const leaveRecord = await LeaveRecord.findOne({ owner: req.user._id }).lean();
    const leaves = {
      annualEntitled: leaveRecord?.totalEntitled ?? "-",
      annualAvailedYTD: leaveRecord?.totalAvailedYTD ?? "-",
      annualAvailedMTH: leaveRecord?.totalAvailedFTM ?? "-",
      annualBalance: leaveRecord?.totalBalance ?? "-",
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

        const slip = await SalarySlip.findById(req.body.slipId)
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
    const getEmployee = slip.employee;
    const employeeId = getEmployee?._id;

    let loans = [];
    if (employee && employeeId) loans = await LoanDetail.find({ employee: employeeId }).lean();

    const compensation = {};
    for (const key of enabledCompFields) compensation[key] = slip[key] || 0;

    const deductions = {};
    for (const key of enabledDedFields) deductions[key] = slip[key] || 0;

    let monthYear = monthYearFromBody;
    if (!monthYear) monthYear = new Date().toLocaleDateString("en-GB", { month: "long", year: "numeric" });

    const totalEarnings = Object.values(compensation || {}).reduce((sum, v) => sum + (typeof v === "number" ? v : Number(v) || 0), 0);
    const totalDeductions = Object.values(deductions || {}).reduce((sum, v) => sum + (typeof v === "number" ? v : Number(v) || 0), 0);
    const netSalary = totalEarnings - totalDeductions;

    const basicSalary = Number(slip.basic) || 0;
    const pfRate = Number(slip.employee?.providentFund?.pfRate) || 0; // Fetch PF rate from employee.pf.pfRate
    const pfContribution = pfRate > 0 ? (basicSalary * pfRate) / 100 : 0; // Employee and Employer contribution
    const pfBalanceBroughtForward = slip.pf_balanceBF !== undefined ? Number(slip.pf_balanceBF) : pfContribution;


    const providentFundData = {
      providentFundBalanceBF: pfBalanceBroughtForward.toLocaleString(),
      employeeProvidentFundContribution: pfRate.toString()+"%", 
      employerProvidentFundContribution: pfRate.toString()+"%", 
      providentFundWithdrawal: "-",
      providentFundProfit: "-",
      providentFundBalance: pfBalanceBroughtForward.toLocaleString(),
    };

    const html = buildSalarySlipHtml({
      employee: getEmployee,
      compensation,
      deductions,
      loans,
      leaves,
      providentFund: providentFundData,
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
    });

    const transporter = nodemailer.createTransport({
      host: process.env.MAIL_HOST,
      port: Number(process.env.MAIL_PORT),
      secure: process.env.MAIL_ENCRYPTION === "ssl",
      auth: { user: process.env.MAIL_USERNAME, pass: process.env.MAIL_PASSWORD },
    });

    await transporter.sendMail({
      from: `"${process.env.MAIL_FROM_NAME || "HR System"}" <${process.env.MAIL_FROM_ADDRESS}>`,
      to: email,
      subject: `Salary Slip${employee?.name ? " - " + employee.name : ""}`,
      html,
    });

    res.json({ success: true, message: "Email sent!" });
  } catch (err) {
    res.status(500).json({ success: false, message: "Failed to send email", error: err.message });
  }
};