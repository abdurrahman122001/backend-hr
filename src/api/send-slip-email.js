// sendSlipEmail.js
const CompanyProfile = require('../models/CompanyProfile');
const nodemailer = require("nodemailer");
const numberToWords = require("number-to-words");

// Helper to format numbers as currency
const formatCurrency = (val) =>
  val !== undefined && val !== null && !isNaN(val)
    ? `Rs. ${Number(val).toLocaleString()}`
    : "-";

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
  // Remove all non-digits
  let num = phone.replace(/[^\d]/g, "");
  if (!num) return "-"; // <--- Fix: If nothing left, return "-"

  // Should start with '92' and have 11 or 12 digits
  if (num.startsWith("92") && num.length === 12) {
    num = num.slice(0, 12);
  }
  if (num.startsWith("92") && num.length === 12) {
    return `+${num.slice(0, 2)} ${num.slice(2, 5)} ${num.slice(5)}`;
  }
  if (num.startsWith("92") && num.length === 11) {
    return `+${num.slice(0, 2)} ${num.slice(2, 5)} ${num.slice(5)}`;
  }
  // fallback: just return as +<number>
  return `+${num}`;
}

  // Field Label Maps
const ALLOWANCES_LABELS = {
  basic: "Basic Pay",
  dearnessAllowance: "Dearness Allowance",
  conveyanceAllowance: "Conveyance Allowance",
  houseRentAllowance: "House Rent Allowance",
  medicalAllowance: "Medical Allowance",
  utilityAllowance: "Utility Allowance",
  overtimeCompensation: "Overtime Compensation",
  dislocationAllowance: "Dislocation Allowance",
  leaveEncashment: "Leave Encashment",
  bonus: "Bonus",
  arrears: "Arrears",
  autoAllowance: "Auto Allowance",
  incentive: "Incentive",
  fuelAllowance: "Fuel Allowance",
  othersAllowances: "Other Allowances",
};

const DEDUCTIONS_LABELS = {
  leaveDeductions: "Leave Deduction",
  lateDeductions: "Late Deduction",
  eobiDeduction: "EOBI Deduction",
  sessiDeduction: "SESSI Deduction",
  providentFundDeduction: "Provident Fund Deduction",
  gratuityFundDeduction: "Gratuity Fund Deduction",
  vehicleLoanDeduction: "Vehicle Loan Deduction",
  otherLoanDeductions: "Loan Deduction",
  advanceSalaryDeductions: "Advance Salary Deduction",
  medicalInsurance: "Medical Insurance",
  lifeInsurance: "Life Insurance",
  penalties: "Penalties",
  otherDeductions: "Other Deduction",
  taxDeduction: "Tax Deduction",
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
};


// Backend: use this for Provident Fund
const PROVIDENT_FUND_FIELDS = [
  { label: "Balance Brought Forward", key: "providentFundBalanceBF" },
  { label: "Employee Contribution", key: "employeeProvidentFundContribution" },
  { label: "Employer Contribution", key: "employerProvidentFundContribution" },
  { label: "Withdrawal", key: "providentFundWithdrawal" },
  { label: "Profit", key: "providentFundProfit" },
  { label: "Balance", key: "providentFundBalance" }
];

// Backend: use this for Gratuity Fund
const GRATUITY_FUND_FIELDS = [
  { label: "Balance Brought Forward", key: "gratuityFundBalanceBF" },
  { label: "Employee Contribution", key: "employeeGratuityFundContribution" },
  { label: "Employer Contribution", key: "employerGratuityFundContribution" },
  { label: "Withdrawal", key: "gratuityFundWithdrawal" },
  { label: "Profit", key: "gratuityFundProfit" },
  { label: "Balance", key: "gratuityFundBalance" }
];



function padRows(htmlRows, count) {
  const emptyRow = `
    <div style="display:flex; justify-content:space-between; padding:4px 0;">
      <span style="color: transparent;">-</span>
      <span style="font-weight:500; margin-left:auto; color:transparent;">-</span>
    </div>
  `;
  while (htmlRows.length < count) {
    htmlRows.push(emptyRow);
  }
  return htmlRows;
}

function renderLoanTable(loanRows = []) {
  if (!Array.isArray(loanRows) || !loanRows.length) return "";

  // Get all unique column keys (in order of first appearance)
  const columns = Array.from(
    loanRows.reduce((set, row) => {
      Object.keys(row).forEach((k) => set.add(k));
      return set;
    }, new Set())
  );

  // Human-readable column labels
  const labelMap = {
    type: "Type",
    amountPaidCurrent: "Amount Paid in Current Month",
    amountPaidPrevious: "Amount Paid in Previous Month(s)",
    balancePrincipal: "Balance (Principal)",
    balanceMarkup: "Balance (Markup)",
    netBalance: "Net Balance",
    // fallback: use field name itself
  };

  return `
    <div style="margin-bottom: 24px;">
      <div style="font-weight:bold; color:#1d4ed8; background:#dbeafe; border-radius:8px 8px 0 0; padding:8px 18px;">
        Loan Details
      </div>
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse; background:#f8fafc;">
        <thead>
          <tr style="background:#f1f5f9;">
            ${columns
              .map(
                (col) =>
                  `<th style="padding:10px 6px; border:1px solid #e5e7eb;">${
                    labelMap[col] || col
                  }</th>`
              )
              .join("")}
          </tr>
        </thead>
        <tbody>
          ${loanRows
            .map(
              (row) =>
                `<tr>
                  ${columns
                    .map(
                      (col) =>
                        `<td style="padding:8px 6px; border:1px solid #e5e7eb; text-align:center;">${
                          row[col] !== undefined && row[col] !== null && row[col] !== ""
                            ? row[col]
                            : "-"
                        }</td>`
                    )
                    .join("")}
                </tr>`
            )
            .join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderLeaveTable(leaves = {}) {
  // Extract actual present fields (e.g., casualEntitled, sickEntitled, etc.)
  const types = ["casual", "sick", "annual", "wop", "other"];
  const cols = ["Entitled", "AvailedYTD", "AvailedMTH", "Balance"];
  // Only types/fields present in leaves
  const present = types.map(type => {
    const row = {};
    cols.forEach(col => {
      const key = `${type}${col}`;
      if (leaves.hasOwnProperty(key)) row[col] = leaves[key];
    });
    return { type, row };
  }).filter(r => Object.keys(r.row).length > 0);

  // If no leave data, return nothing
  if (present.length === 0) return "";

  // Find which columns to show (union of present)
  const presentCols = Array.from(new Set(present.flatMap(r => Object.keys(r.row))));

  const colLabel = {
    Entitled: "Entitled",
    AvailedYTD: "Availed (YTD)",
    AvailedMTH: "Availed (MTH)",
    Balance: "Balance"
  };
  const typeLabel = {
    casual: "Casual",
    sick: "Sick",
    annual: "Annual",
    wop: "WOP",
    other: "Other"
  };

  return `
    <div style="margin: 24px 0;">
      <div style="font-weight:bold; color:#1d4ed8; background:#dbeafe; border-radius:8px 8px 0 0; padding:8px 18px;">Leave Records</div>
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse; background:#f8fafc;">
        <thead>
          <tr style="background:#f1f5f9;">
            <th style="padding:10px 6px; border:1px solid #e5e7eb;">Leave Type</th>
            ${presentCols.map(c => `<th style="padding:10px 6px; border:1px solid #e5e7eb;">${colLabel[c]}</th>`).join("")}
          </tr>
        </thead>
        <tbody>
          ${present.map(({ type, row }) =>
            `<tr>
              <td style="padding:8px 6px; border:1px solid #e5e7eb; text-align:center;">${typeLabel[type] || type}</td>
              ${presentCols.map(col =>
                `<td style="padding:8px 6px; border:1px solid #e5e7eb; text-align:center;">${row[col] ?? "-"}</td>`
              ).join("")}
            </tr>`
          ).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderProvidentFundTable(data = {}) {
  const visibleFields = PROVIDENT_FUND_FIELDS.filter(f => data.hasOwnProperty(f.key));
  if (visibleFields.length === 0) return "";
  return `
    <div style="margin-bottom: 24px;">
      <div style="font-weight:bold; color:#1d4ed8; background:#dbeafe; border-radius:8px 8px 0 0; padding:8px 18px;">
        Provident Fund
      </div>
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse; background:#f8fafc;">
        <thead>
          <tr style="background:#f1f5f9;">
            ${visibleFields.map(f => `<th style="padding:10px 6px; border:1px solid #e5e7eb;">${f.label}</th>`).join("")}
          </tr>
        </thead>
        <tbody>
          <tr>
            ${visibleFields.map(f =>
              `<td style="padding:8px 6px; border:1px solid #e5e7eb; text-align:center;">${data[f.key] ?? "-"}</td>`
            ).join("")}
          </tr>
        </tbody>
      </table>
    </div>
  `;
}

function renderGratuityFundTable(data = {}) {
  const visibleFields = GRATUITY_FUND_FIELDS.filter(f => data.hasOwnProperty(f.key));
  if (visibleFields.length === 0) return "";
  return `
    <div style="margin-bottom: 24px;">
      <div style="font-weight:bold; color:#1d4ed8; background:#dbeafe; border-radius:8px 8px 0 0; padding:8px 18px;">
        Gratuity Fund
      </div>
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse; background:#f8fafc;">
        <thead>
          <tr style="background:#f1f5f9;">
            ${visibleFields.map(f => `<th style="padding:10px 6px; border:1px solid #e5e7eb;">${f.label}</th>`).join("")}
          </tr>
        </thead>
        <tbody>
          <tr>
            ${visibleFields.map(f =>
              `<td style="padding:8px 6px; border:1px solid #e5e7eb; text-align:center;">${data[f.key] ?? "-"}</td>`
            ).join("")}
          </tr>
        </tbody>
      </table>
    </div>
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
}) {
  // Amount in words
  const amountInWords = netSalary > 0
    ? `${numberToWords.toWords(netSalary).replace(/,/g, "")} Rupees Only`
        .replace(/(^\w|\s\w)/g, (m) => m.toUpperCase())
    : "-";

  function renderEmployeeTable(empObj, labelObj) {
    const fields = Object.keys(empObj);
    const colCount = 3;
    const rows = Math.ceil(fields.length / colCount);
    let html = `<table width="100%" cellpadding="0" cellspacing="0" border="0" style="table-layout:fixed; box-shadow: 0 1px 3px rgba(0,0,0,0.1), 0 1px 2px -1px rgba(0,0,0,0.1); background-color: #fff; padding: 2rem; border: 1px solid #dbeafe; border-radius: 1rem;">`;
    for (let i = 0; i < rows; i++) {
      html += "<tr>";
      for (let j = 0; j < colCount; j++) {
        const idx = i * colCount + j;
        const key = fields[idx];
        // Only set border if not last row
        const borderStyle =
          i === rows - 1 ? "" : "border-bottom:1px solid #e5e7eb;";
        if (key) {
          html += `
            <td style="vertical-align:top; min-width:200px; word-break:break-word; overflow-wrap:break-word; ${borderStyle} padding-top: 15px; padding-bottom:15px; padding-right:12px;">
              <label style="font-size:0.95rem; font-weight:500; color:#6b7280;">${labelObj?.[key] || PROFILE_LABELS[key] || key}</label>
                <p style="color:#111827; margin:2px 0 0 0;">
                  ${
                    (empObj[key] !== null && empObj[key] !== undefined && empObj[key] !== "")
                      ? (
                          (key === "phone" || key === "nomineeEmergencyNo")
                            ? formatPhoneNumber(empObj[key])
                            : (key === "dateOfBirth" || key === "joiningDate" || key === "cnicIssueDate" || key === "cnicExpiryDate")
                              ? formatDate(empObj[key])
                              : empObj[key]
                        )
                      : "-"
                  }
                </p>
            </td>
          `;
        } else {
          html += "<td></td>";
        }
      }
      html += "</tr>";
    }
    html += "</table>";
    return html;
  }

  function renderSalaryTable(compObj, labelObj = {}) {
    let total = 0;
    const rows = Object.keys(compObj).map((key) => {
      const value = Number(compObj[key]) || 0;
      total += value;
      return `
        <div style="display: flex; justify-content: space-between; padding: 4px 0;">
          <span style="color: #334155;">${labelObj[key] || ALLOWANCES_LABELS[key] || key}</span>
          <span style="font-weight: 500; margin-left: auto;">${value !== 0 ? value.toLocaleString() : "-"}</span>
        </div>
      `;
    });
    return { rows, total };
  }

  function renderDeductionsTable(dedObj, labelObj = {}) {
    let total = 0;
    const rows = Object.keys(dedObj).map((key) => {
      const value = Number(dedObj[key]) || 0;
      total += value;
      return `
        <div style="display: flex; justify-content: space-between; padding: 4px 0;">
          <span style="color: #334155;">${labelObj[key] || DEDUCTIONS_LABELS[key] || key}</span>
          <span style="font-weight: 500; margin-left: auto;">${value !== 0 ? value.toLocaleString() : "-"}</span>
        </div>
      `;
    });
    return { rows, total };
  }

  const loansHtml = loans && Object.keys(loans).length ? renderLoanTable(loans) : "";
  const leavesHtml = leaves && Object.keys(leaves).length ? renderLeaveTable(leaves) : "";
  const providentFundHtml = providentFund && Object.keys(providentFund).length ? renderProvidentFundTable(providentFund) : "";
  const gratuityFundHtml = gratuityFund && Object.keys(gratuityFund).length ? renderGratuityFundTable(gratuityFund) : "";


  const { rows: earningsRows, total: totalEarnings } = renderSalaryTable(
    compensation || {},
    labels?.compensation || {}
  );
  const { rows: deductionsRows, total: totalDeductions } = renderDeductionsTable(
    deductions || {},
    labels?.deductions || {}
  );

  const maxRows = Math.max(earningsRows.length, deductionsRows.length);
  const paddedEarningsRows = padRows(earningsRows, maxRows);
  const paddedDeductionsRows = padRows(deductionsRows, maxRows);

  const earningsHtml = paddedEarningsRows.join("");
  const deductionsHtml = paddedDeductionsRows.join("");

  const employeeTable = renderEmployeeTable(
    employee || {},
    labels?.employee || {}
  );


  // The rest is **your existing HTML**...
  return `<!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8">
    <title>Pay Slip - ${company.name}</title>
    <meta name="viewport" content="width=900", initial-scale=1.0">
  </head>
  <style>
  .im{
  color: unset !important;
  }
  </style>
  <body style="min-height:100vh; background-color:#eff6ff; margin:0; padding:16px; font-family:'Segoe UI',Arial,sans-serif; box-sizing: border-box;">
    <div style="max-width:900px; min-width: 900px; margin:0 auto;background:#fff;border-radius:16px;overflow:hidden; box-shadow:0 4px 24px rgba(0,0,0,0.08);  width:100%;">
      <!-- Header -->
      <div style="background:#dbeafe; padding:24px 32px; border-bottom:1px solid #e5e7eb;">
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="table-layout:fixed; word-break:break-word; ">
          <tr>
            <td style="word-break:break-word; overflow-wrap:break-word; vertical-align:top;">
              <h1 style="font-size:25px; font-weight:700; color:#1d4ed8; margin:0; letter-spacing:0.5px; line-height:1.1;">
                ${company.name}
              </h1>
              <p style="color:#334155; font-weight:600; margin:8px 0 0 0;">${company.address}</p>
            </td>
            <td align="right" style="vertical-align:top;">
              <div style="display:inline-block; text-align:right;">
                <h2 style="font-size:1.25rem; font-weight:bold; color:#0f172a; margin:0 0 4px 0;">Pay Slip</h2>
                <p style="color:#334155; margin:0 0 2px 0; font-size:1rem;">${monthYear}</p>
                <p style="font-size:0.85rem; color:#64748b; margin:4px 0 0 0;">Generated:<br/>${new Date().toLocaleString()}</p>
              </div>
            </td>
          </tr>
        </table>
      </div>
      <!-- Employee Information -->
      <div style="padding:32px;">
        <h3 style="font-size:22px; font-weight:700; color:#1d4ed8; margin-bottom:16px; border-bottom:1px solid #bfdbfe; padding-bottom:8px;">Employee Information</h3>
        ${employeeTable}
      </div>
      <!-- Salary Details -->
      <div style="padding:0 32px 32px 32px;">
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="table-layout:fixed; word-break:break-word;">
          <tr>
            <!-- Earnings -->
            <td valign="top" width="50%" style="padding-right:16px; min-width:220px; word-break:break-word; overflow-wrap:break-word;">
              <h3 style="font-size:22px; font-weight:700; color:#1d4ed8; margin-bottom:16px; border-bottom:1px solid #bfdbfe; padding-bottom:8px;">
                Salary &amp; Allowances
              </h3>
              <div style="background:#eff6ff; border-radius:12px; padding:16px;">
                <div>${earningsHtml}</div>
                <div style="border-top:1px solid #bfdbfe; padding-top:8px; margin-top:12px;">
                  <div style="display:flex; justify-content:space-between; font-weight:700; color:#1d4ed8;">
                    <span>Total Additions</span>
                    <span style="margin-left: auto;">${formatCurrency(totalEarnings)}</span>
                  </div>
                </div>
              </div>
            </td>
            <!-- Deductions -->
            <td valign="top" width="50%" style="padding-left:16px; min-width:220px; word-break:break-word; overflow-wrap:break-word;">
              <h3 style="font-size:22px; font-weight:700; color:#1d4ed8; margin-bottom:16px; border-bottom:1px solid #bfdbfe; padding-bottom:8px;">
                Deductions
              </h3>
              <div style="background:#eff6ff; border-radius:12px; padding:16px;">
                <div>${deductionsHtml}</div>
                <div style="border-top:1px solid #bfdbfe; padding-top:8px; margin-top:12px;">
                  <div style="display:flex; justify-content:space-between; font-weight:700; color:#991b1b;">
                    <span>Total Deductions</span>
                    <span style="margin-left: auto;">${formatCurrency(totalDeductions)}</span>
                  </div>
                </div>
              </div>
            </td>
          </tr>
        </table>
      </div>
      <!-- Net Salary -->
      <div style="background:#f1f5f9; padding:24px 32px;">
        <table style="width:100%; color:#0f172a; font-size:1.05rem; border-collapse:collapse;">
          <tbody>
            <tr style="border-bottom:1px solid #e5e7eb;">
              <td style="padding:8px 8px; font-weight:600; word-break:break-word; overflow-wrap:break-word;">
                <h3 style="font-size:1.125rem; font-weight:bold; color:#1d4ed8; margin:0;">Net Salary</h3>
              </td>
              <td style="padding:8px 8px; text-align:right; font-weight:600; word-break:break-word; overflow-wrap:break-word;">
                <p style="font-size:1.125rem; color:#334155; margin:0;">${formatCurrency(netSalary)}</p>
              </td>
            </tr>
            <tr style="border-bottom:1px solid #e5e7eb;">
              <td style="padding:8px 8px; font-weight:600; word-break:break-word; overflow-wrap:break-word;">
                <h3 style="font-size:1.125rem; font-weight:bold; color:#1d4ed8; margin:0;">Amount in Words</h3>
              </td>
              <td style="padding:8px 8px; text-align:right; font-weight:600;">
                <p style="font-size:1.125rem; color:#334155; margin:0;">${amountInWords}</p>
              </td>
            </tr>
            <tr style="border-bottom:1px solid #e5e7eb;">
              <td style="padding:8px 8px; font-weight:600; word-break:break-word; overflow-wrap:break-word;">
                <h3 style="font-size:1.125rem; font-weight:bold; color:#1d4ed8; margin:0;">Mode of Payment</h3>
              </td>
              <td style="padding:8px 8px; text-align:right; font-weight:600; word-break:break-word; overflow-wrap:break-word;">
                <p style="font-size:1.125rem; color:#334155; margin:0;">Bank Transfer</p>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div style="padding: 40px 32px 0 32px;">
        ${loansHtml}
        ${providentFundHtml}
        ${gratuityFundHtml}
        ${leavesHtml}
      </div>
      <div style="padding:24px 24px 24px 24px; margin-bottom:12px; border-bottom-left-radius:16px; border-bottom-right-radius:16px; border-top:1px solid #f1f5f9; background:#f8fafc;">
        <!-- Empty bottom block (matches original) -->
      </div>
      <!-- Footer -->
      <div style="text-align:center; color:#6b7280; font-size:0.95rem; padding:16px 0; border-top:1px solid #e5e7eb;">
        <p style="margin:0;">This is a system generated pay slip and does not require signature.</p>
      </div>
    </div>
  </body>
  </html>`;
}

module.exports = async function sendSlipEmail(req, res) {
  try {
    const companyProfile = await CompanyProfile.findOne({ owner: req.user._id }).lean();

    const company = {
      name: companyProfile?.name || 'Company Name',
      address: companyProfile?.address || '',
      email: companyProfile?.email || '',
    };
    const {
      employee,
      compensation,
      deductions,
      loans,     // <--- NEW
      leaves,    // <--- NEW
      providentFund,  // <-- Add this if you use a nested structure
      gratuityFund,
      labels,
      monthYear: monthYearFromBody,
      email,
    } = req.body;

        let monthYear = monthYearFromBody;
    if (!monthYear) {
      monthYear = new Date().toLocaleDateString("en-GB", {
        month: "long",
        year: "numeric",
      });
    }

    // Backend net salary calculation
    const totalEarnings = Object.values(compensation || {}).reduce(
      (sum, v) => sum + (typeof v === "number" ? v : Number(v) || 0),
      0
    );
    const totalDeductions = Object.values(deductions || {}).reduce(
      (sum, v) => sum + (typeof v === "number" ? v : Number(v) || 0),
      0
    );
    const netSalary = totalEarnings - totalDeductions;

    const html = buildSalarySlipHtml({
      employee,
      compensation,
      deductions,
      loans,     // <--- NEW
      leaves,    // <--- NEW
      providentFund,  // <-- Add this if you use a nested structure
      gratuityFund,
      labels,
      netSalary,
      monthYear,
      company,
    });

    const transporter = nodemailer.createTransport({
      host: process.env.MAIL_HOST,
      port: Number(process.env.MAIL_PORT),
      secure: process.env.MAIL_ENCRYPTION === "ssl",
      auth: {
        user: process.env.MAIL_USERNAME,
        pass: process.env.MAIL_PASSWORD,
      },
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

