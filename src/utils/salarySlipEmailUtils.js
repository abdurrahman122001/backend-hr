// utils/salarySlipEmailUtils.js

const numberToWords = require("number-to-words");

// --- HELPER FUNCTIONS ---

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

function safeAmountCell(val) {
  if (val === undefined || val === null || val === "" || val === "-" || isNaN(Number(val))) {
    return "-";
  }
  const num = Number(val);
  return num !== 0 && !isNaN(num) ? num.toLocaleString() : "-";
}

// LABELS & FIELD ORDERS (reusable)
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
  companyEmail: "Company Email",
  permanentAddress: "Permanent Address",
  presentAddress: "Present Address",
  bankName: "Bank Name",
  bankAccountNumber: "Bank Account Number",
  department: "Department",
  designation: "Designation",
  joiningDate: "Joining Date",
  shifts: "Shifts",
  nomineeName: "Nominee Name",
  nomineeCnic: "Nominee CNIC",
  nomineeRelation: "Relation with Nominee",
  nomineeEmergencyNo: "Nominee Number",
  emergencyContactName: "Emergency Contact Name",
  emergencyContactRelation: "Emergency Contact Relation",
  emergencyContactNumber: "Emergency Contact Number",
};

// Which fields show in manual's info table:
const INFO_FIELDS = [
  "name",
  "fatherOrHusbandName",
  "dateOfBirth",
  "gender",
  "nationality",
  "maritalStatus",
  "cnic",
  "phone",
  "email",
  "companyEmail",
  "department",
  "designation",
  "joiningDate",
  "permanentAddress",
  "presentAddress",
  "bankName",
  "bankAccountNumber",
  // Emergency Contact fields:
  "emergencyContactName",
  "emergencyContactRelation",
  "emergencyContactNumber"
];

// --- EMAIL HTML BUILDER FOR BOTH HANDLERS ---
function buildSalarySlipHtml({
  employee,
  compensation,
  deductions,
  netSalary,
  monthYear,
  company,
  profileFields,        // (for manual) pass an array to override fields (optional)
  compLabels = {},      // (optional)
  dedLabels = {},       // (optional)
  enabledCompFields = [],
  enabledDedFields = [],
  isDraft = false,      // Flag to show DRAFT watermark
}) {
  // Employee Info Table
  function renderEmployeeInfo(empObj) {
    const fields = Array.isArray(profileFields) && profileFields.length ? profileFields : INFO_FIELDS;
    const cols = 3;
    const rows = Math.ceil(fields.length / cols);
    let html = `<table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:24px; background:#fff; border-radius:8px; border:1px solid #e5e7eb;">`;
    for (let i = 0; i < rows; i++) {
      html += "<tr>";
      for (let j = 0; j < cols; j++) {
        const idx = i * cols + j;
        const key = fields[idx];
        if (key) {
          let val = empObj[key];
          if (
            key === "dateOfBirth" ||
            key === "joiningDate" ||
            key === "cnicIssueDate" ||
            key === "cnicExpiryDate"
          ) {
            val = formatDate(val);
          } else if (
            key === "phone" ||
            key === "nomineeEmergencyNo" ||
            key === "emergencyContactNumber"
          ) {
            val = formatPhoneNumber(val);
          }
          html += `<td style="padding:10px 12px; font-size:14px;">
              <span style="color:#64748b; font-weight:600;">${PROFILE_LABELS[key] || key}</span><br/>
              <span style="color:#111827; font-weight:500;">${val || "-"}</span>
            </td>`;
        } else {
          html += "<td></td>";
        }
      }
      html += "</tr>";
    }
    html += "</table>";
    return html;
  }

  // Table for compensation/deductions
  function renderTable(obj, fields, labels, title, color) {
    return `
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:18px; background:#fff; border-radius:8px; border:1px solid #e5e7eb;">
        <thead>
          <tr style="background:${color};">
            <th style="padding:12px 16px; text-align:left; font-size:15px;">${title}</th>
            <th style="padding:12px 16px; text-align:right; font-size:15px;">Amount</th>
          </tr>
        </thead>
        <tbody>
          ${
            fields
              .map(
                (key) => `
            <tr>
              <td style="padding:10px 16px; border-bottom:1px solid #f1f5f9;">${labels[key] || key}</td>
              <td style="padding:10px 16px; text-align:right; border-bottom:1px solid #f1f5f9;">${safeAmountCell(obj[key])}</td>
            </tr>`
              )
              .join("")
          }
        </tbody>
      </table>
    `;
  }

  // Net Salary Table
  function renderNetSalaryTable(netSalary) {
    const inWords =
      netSalary && netSalary > 0
        ? numberToWords.toWords(netSalary).replace(/,/g, "")
        : "-";
    return `
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f1f5f9; border:1px solid #dbeafe; border-radius:10px; margin-bottom:18px;">
        <tr>
          <td style="font-weight:700; color:#1d4ed8; padding:14px; font-size:16px;">Net Salary</td>
          <td style="font-weight:700; text-align:right; color:#1d4ed8; padding:14px; font-size:16px;">Rs. ${netSalary && netSalary > 0 ? Number(netSalary).toLocaleString() : "-"}</td>
        </tr>
        <tr>
          <td style="font-weight:500; color:#64748b; padding:12px 14px;">Amount in Words</td>
          <td style="font-weight:500; text-align:right; color:#64748b; padding:12px 14px;">${inWords !== "-" ? inWords.replace(/\b\w/g, (m) => m.toUpperCase()) + " Rupees Only" : "-"}</td>
        </tr>
      </table>
    `;
  }

  return `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="UTF-8">
        <title>Pay Slip - ${company.name}</title>
      </head>
      <body style="background:#f1f5f9; margin:0; padding:0; font-family:Segoe UI,Arial,sans-serif; color:#1e293b;">
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f1f5f9;">
          <tr>
            <td align="center">
              <table width="800" cellpadding="0" cellspacing="0" border="0" style="margin:40px auto 20px auto; background:#fff; border-radius:14px; box-shadow:0 4px 20px rgba(0,0,0,0.07); border:1px solid #dbeafe; position:relative; overflow:hidden;">
                ${isDraft ? `
                <tr>
                  <td colspan="2" style="padding:0; position:relative; height:0;">
                    <div style="position:absolute; top:50%; left:50%; transform:translate(-50%, -50%) rotate(-45deg); font-size:150px; font-weight:bold; color:rgba(239, 68, 68, 0.15); white-space:nowrap; z-index:1; pointer-events:none; line-height:1;">DRAFT</div>
                  </td>
                </tr>
                ` : ''}
                <tr>
                  <td style="padding:24px 32px 16px 32px; border-bottom:1px solid #e5e7eb; position:relative; z-index:2;">
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
                  <td style="padding:32px 32px 8px 32px; position:relative; z-index:2;">
                    ${renderEmployeeInfo(employee || {})}
                  </td>
                </tr>
                <tr>
                  <td style="padding:8px 32px 8px 32px; position:relative; z-index:2;">
                    ${renderTable(compensation || {}, enabledCompFields, compLabels, "Earnings & Allowances", "#d1fae5")}
                  </td>
                </tr>
                <tr>
                  <td style="padding:8px 32px 8px 32px; position:relative; z-index:2;">
                    ${renderTable(deductions || {}, enabledDedFields, dedLabels, "Deductions", "#fee2e2")}
                  </td>
                </tr>
                <tr>
                  <td style="padding:24px 32px; position:relative; z-index:2;">
                    ${renderNetSalaryTable(netSalary)}
                  </td>
                </tr>
                <tr>
                  <td style="padding:16px 32px; color:#64748b; font-size:14px; text-align:center; border-top:1px solid #e5e7eb; position:relative; z-index:2;">
                    This is a system generated pay slip and does not require signature.
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </body>
    </html>
  `;
}

module.exports = { buildSalarySlipHtml, formatDate, formatPhoneNumber, safeAmountCell, PROFILE_LABELS, INFO_FIELDS };
