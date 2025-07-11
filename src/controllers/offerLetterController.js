require("dotenv").config();
const mongoose = require("mongoose");
const CompanyProfile = require("../models/CompanyProfile");
const SalarySlip = require("../models/SalarySlip");
const Employee = require("../models/Employees");
const nodemailer = require("nodemailer");
const { encrypt } = require("../utils/encryption");

const transporter = nodemailer.createTransport({
  host: process.env.MAIL_HOST,
  port: Number(process.env.MAIL_PORT),
  secure: process.env.MAIL_PORT === "465",
  auth: {
    user: process.env.MAIL_USERNAME,
    pass: process.env.MAIL_PASSWORD,
  },
  tls: { rejectUnauthorized: false },
});

const COMPANY_NAME = process.env.COMPANY_NAME || "Mavens Advisors";
const COMPANY_EMAIL = process.env.COMPANY_EMAIL || "HR@mavensadvisor.com";
const COMPANY_CONTACT = process.env.COMPANY_CONTACT || "+44 7451 285285";
const COMPANY_WEBSITE = process.env.COMPANY_WEBSITE || "www.mavensadvisor.com";

const SALARY_COMPONENTS = [
  "basic", "dearnessAllowance", "houseRentAllowance", "conveyanceAllowance",
  "medicalAllowance", "utilityAllowance", "overtimeComp", "dislocationAllowance",
  "leaveEncashment", "bonus", "arrears", "autoAllowance", "incentive",
  "fuelAllowance", "othersAllowances"
];

// --- DISCLAIMER: Only inside the box, nowhere else ---
const EMAIL_DISCLAIMER = `
  <div style="
    background:#f4f4f4;
    border-radius:12px;
    border:1.8px solid #dadada;
    margin-top:44px;
    margin-bottom:0;
    padding:18px 18px 24px 18px;
    font-family: 'Comic Sans MS', Comic Sans, cursive, monospace;
    font-size:16px;
    color:#7a5366;
    line-height:2.15;
    text-align:left;
    white-space:pre;
    overflow-x:auto;
  ">
************************************************************************************************

The information contained in this email (including any attachments) is intended only for the personal and confidential use of the recipient(s) named above. If you are not an intended recipient of this message, please notify the sender by replying to this message and then delete the message and any copies from your system. Any use, dissemination, distribution, or reproduction of this message by unintended recipients is not authorized and may be unlawful.

************************************************************************************************
  </div>
`;

// --- Helper: Enforce Comic Sans everywhere except disclaimer block ---
function enforceComicSans(html) {
  const fontStyle = "font-family: 'Comic Sans MS', Comic Sans, cursive, sans-serif;";
  return html
    .replace(/<p(\s|>)/g, `<p style="${fontStyle}"$1`)
    .replace(/<ul(\s|>)/g, `<ul style="${fontStyle}"$1`)
    .replace(/<ol(\s|>)/g, `<ol style="${fontStyle}"$1`)
    .replace(/<li(\s|>)/g, `<li style="${fontStyle}"$1`)
    .replace(/<div(\s|>)/g, `<div style="${fontStyle}"$1`);
}

// --- Helpers for formatting ---
function formatDateDMY(dateInput) {
  if (!dateInput) return "";
  const dateObj = new Date(dateInput);
  if (isNaN(dateObj.getTime())) return "";
  const day = dateObj.getDate();
  const month = dateObj.toLocaleString("default", { month: "long" });
  const year = dateObj.getFullYear();
  return `${day} ${month} ${year}`;
}
function formatTime12hr(timeStr) {
  if (!timeStr) return "";
  let [hour, min] =
    timeStr.split(":").length >= 2
      ? [parseInt(timeStr.split(":")[0], 10), timeStr.split(":")[1]]
      : [parseInt(timeStr, 10), "00"];
  let suffix = "AM";
  if (hour >= 12) {
    suffix = "PM";
    if (hour > 12) hour -= 12;
  }
  if (hour === 0) hour = 12;
  return `${hour}:${min.padStart(2, "0")} ${suffix}`;
}
function formatNumberWithCommas(x) {
  return Number(x).toLocaleString("en-PK");
}

// --- OFFER LETTER GENERATOR ---
async function generateOfferLetter(req, res) {
  try {
    const {
      candidateName,
      candidateEmail,
      position,
      salaryBreakup = {},
      startDate,
      reportingTime,
      confirmationDeadlineDate,
      department,
    } = req.body;

    if (
      !candidateName ||
      !candidateEmail ||
      !position ||
      !startDate ||
      !reportingTime ||
      !confirmationDeadlineDate
    ) {
      return res.status(400).json({ error: "Missing required candidate or date fields." });
    }
    if (!req.user || !req.user._id) {
      return res.status(400).json({ error: "No user context found." });
    }

    // Prevent duplicate employee
    const exists = await Employee.findOne({ email: candidateEmail });
    if (exists) {
      return res.status(400).json({
        error: "An employee with this email already exists.",
      });
    }

    let ownerId = req.user._id;
    if (!(ownerId instanceof mongoose.Types.ObjectId)) {
      ownerId = new mongoose.Types.ObjectId(ownerId);
    }
    const company = await CompanyProfile.findOne({ owner: ownerId });
    if (!company) {
      return res.status(404).json({ error: "Company profile not found." });
    }
    let address = company.address;
    if (!address || typeof address !== "string" || !address.trim()) {
      address = "GULSHAN-E-MAYMAR, KARACHI";
    }

    const formattedStartDate = formatDateDMY(startDate);
    const formattedDeadline = formatDateDMY(confirmationDeadlineDate);
    const formattedTime = formatTime12hr(reportingTime);
    const grossSalaryRaw = SALARY_COMPONENTS.reduce(
      (sum, k) => sum + (Number(salaryBreakup[k]) || 0),
      0
    );
    const grossSalary = formatNumberWithCommas(grossSalaryRaw);

    // --- Main email body, left-aligned, signature block, NO asterisks ---
    let bodyHtml = `
      <div style="font-family: 'Comic Sans MS', Comic Sans, cursive, Arial, sans-serif; font-size: 16px; color: #212121; line-height: 1.7; text-align: left; margin:0; padding:0; max-width:600px;">
        <p>Dear <strong>${candidateName}</strong>,</p>
        <p>We’re thrilled to have you on board!</p>
        <p>
          After getting to know you during your recent interview, we were truly inspired by your passion, potential, and the energy you bring. It gives us great pleasure to officially offer you the position of <b>${position}</b> at <b>${company.name}</b>.
        </p>
        <p>
          We believe you will be a valuable addition to our growing team, and we’re excited about what we can build together. This isn’t just a job it’s a journey, and we’re looking forward to seeing you thrive with us.
        </p>
        <p>Your monthly gross salary will be <b>PKR ${grossSalary}</b>, paid through online bank transfer at the end of each month.</p>
        <p>If you accept this offer, your anticipated start date will be <b>${formattedStartDate}</b>, and we look forward to welcoming you in person at our <b>${address}</b> by <b>${formattedTime}</b>.</p>
        <p>In this role, you’ll be working 45 hours per week, from Monday to Friday – a full week of opportunities to grow, collaborate, and contribute.</p>
        <p>
          To move forward, please confirm your acceptance of this offer by <b>${formattedDeadline}</b>. On your first day, we kindly ask that you bring:
        </p>
        <ul style="margin:0 0 1em 2em;padding:0;">
          <li style="margin-bottom:4px;">All original educational and professional certificates</li>
          <li style="margin-bottom:4px;">Original CNIC with a photocopy</li>
          <li style="margin-bottom:4px;">Two recent passport-sized photographs</li>
        </ul>
        <p>
          By accepting this offer, you also agree to the terms set forth in our Employment Contract and Non-Disclosure Agreement (NDA), which we will share with you separately.
        </p>
        <p>
          We’re truly excited to have you join us. Your future teammates are just as eager to welcome you, support you, and learn from you as you are to begin this new chapter. Let’s make great things happen together!
        </p>
        <br/>
        <div style="margin-bottom:16px;">
          Regards,<br/>
          <span style="font-weight:bold;">Human Resource Department</span><br/>
          <span style="font-style: italic;">${COMPANY_NAME}</span>
          <br/><br/>
          T &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; ${COMPANY_CONTACT}<br/>
          E &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; ${COMPANY_EMAIL}<br/>
          W &nbsp;&nbsp;&nbsp;&nbsp;&nbsp; ${COMPANY_WEBSITE}<br/>
          <br/>
          Mavens Advisor LLC<br/>
          East Grand Boulevard, Detroit<br/>
          Michigan, United States
        </div>
      </div>
    `.trim();

    // --- Enforce Comic Sans everywhere except disclaimer ---
    bodyHtml = enforceComicSans(bodyHtml);

    // --- Append disclaimer (NEVER Quill/user editable) ---
    bodyHtml += EMAIL_DISCLAIMER;

    return res.json({
      letter: bodyHtml,
      grossSalary: grossSalaryRaw,
      salaryBreakup,
      position,
      candidateName,
      candidateEmail,
      startDate,
      reportingTime,
      confirmationDeadlineDate,
      department,
    });
  } catch (err) {
    console.error("Offer gen error:", err?.response?.data || err);
    return res
      .status(500)
      .json({ error: "Failed to generate offer letter." });
  }
}

// --- SEND OFFER LETTER ---
async function sendOfferLetter(req, res) {
  try {
    const {
      candidateEmail,
      letter,
      salaryBreakup,
      position,
      candidateName,
      startDate,
      reportingTime,
      confirmationDeadlineDate,
      department,
    } = req.body;
    const candidate = candidateName || "Candidate";

    if (
      !candidateEmail ||
      !letter ||
      !salaryBreakup ||
      !position ||
      !candidate ||
      !startDate ||
      !reportingTime ||
      !confirmationDeadlineDate
    ) {
      return res
        .status(400)
        .json({ error: "Missing required fields for sending offer." });
    }

    // Prevent duplicate employee
    let employee = await Employee.findOne({ email: candidateEmail });
    if (employee) {
      return res.status(400).json({
        error: "An employee with this email already exists. Offer not sent.",
      });
    }

    // Create new employee
    employee = await Employee.create({
      name: candidate,
      email: candidateEmail,
      designation: position,
      startDate,
      department: department || null,
      owner: req.user?._id,
      createdBy: req.user?._id,
    });

    // Encrypt salary fields
    const grossSalaryRaw = SALARY_COMPONENTS.reduce(
      (sum, k) => sum + (Number(salaryBreakup[k]) || 0),
      0
    );
    const encryptedSalaryFields = await Promise.all(
      SALARY_COMPONENTS.map(async (k) => ({
        [k]: await encrypt((salaryBreakup[k] || 0).toString()),
      }))
    );
    const encryptedSalaryBreakup = Object.assign({}, ...encryptedSalaryFields);

    const slipData = {
      employee: employee._id,
      candidateName: await encrypt(candidate),
      candidateEmail: await encrypt(candidateEmail),
      position: await encrypt(position),
      startDate: await encrypt(startDate),
      reportingTime: await encrypt(reportingTime),
      confirmationDeadlineDate: await encrypt(confirmationDeadlineDate),
      grossSalary: await encrypt(grossSalaryRaw.toString()),
      owner: req.user?._id,
      createdBy: req.user?._id,
      ...encryptedSalaryBreakup,
    };

    await SalarySlip.create(slipData);

    // --- Build final email (remove old disclaimers, append new) ---
    let html = enforceComicSans(letter);
    // Remove any previous disclaimer
    const disclaimerIndex = html.indexOf("The information contained in this email");
    if (disclaimerIndex !== -1) {
      html = html.slice(0, disclaimerIndex);
    }
    html += EMAIL_DISCLAIMER;

    // Fallback plain text for email clients
    const text = html.replace(/<[^>]+>/g, " ");

    await transporter.sendMail({
      from: `"${process.env.MAIL_FROM_NAME}" <${process.env.MAIL_FROM_ADDRESS}>`,
      to: candidateEmail,
      subject: "Welcome Aboard – Offer of Employment",
      text,
      html,
    });

    return res.json({ success: true });
  } catch (err) {
    console.error("Email send error:", err);
    return res.status(500).json({ error: "Failed to send offer letter." });
  }
};

module.exports = {
  generateOfferLetter,
  sendOfferLetter,
};
