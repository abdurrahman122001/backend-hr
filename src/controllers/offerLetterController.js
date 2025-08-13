const mongoose = require("mongoose");
const CompanyProfile = require("../models/CompanyProfile");
const Salaries = require("../models/Salaries");
const Employee = require("../models/Employees");
const nodemailer = require("nodemailer");
const { encrypt } = require("../utils/encryption");
const Signature = require("../models/Signature"); // add this to your requires
require("dotenv").config();

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
const COMPANY_CONTACT = process.env.COMPANY_CONTACT || "+92 312 3850846";
const COMPANY_WEBSITE = process.env.COMPANY_WEBSITE || "www.mavensadvisor.com";

const SALARY_COMPONENTS = [
  "basic",
  "dearnessAllowance",
  "houseRentAllowance",
  "conveyanceAllowance",
  "medicalAllowance",
  "utilityAllowance",
  "overtimeComp",
  "dislocationAllowance",
  "leaveEncashment",
  "bonus",
  "arrears",
  "autoAllowance",
  "incentive",
  "fuelAllowance",
  "othersAllowances",
];

// --- Helper: Enforce Comic Sans ---
function enforceComicSans(html) {
  const fontStyle =
    "font-family: 'Comic Sans MS', Comic Sans, cursive, sans-serif;";
  return html
    .replace(/<p(\s|>)/g, `<p style="${fontStyle}"$1`)
    .replace(/<ul(\s|>)/g, `<ul style="${fontStyle}"$1`)
    .replace(/<ol(\s|>)/g, `<ol style="${fontStyle}"$1`)
    .replace(/<li(\s|>)/g, `<li style="${fontStyle}"$1`)
    .replace(/<div(\s|>)/g, `<div style="${fontStyle}"$1`);
}

// --- Helper: Enforce <img> CSS ---
function enforceImgCss(html) {
  html = html.replace(/<img([^>]*?)style="[^"]*"/g, `<img$1`);
  html = html.replace(
    /<img([^>]*?)\/?>/g,
    `<img$1 style="height:200px;width:200px;object-fit:contain;display:inline-block;vertical-align:middle;max-width:200px;max-height:200px;" />`
  );
  return html;
}

// --- Formatting Helpers ---
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

function probationDaysToMonths(probationDays) {
  const days = Number(probationDays) || 0;
  if (!days) return "";
  const months = Math.round(days / 30);
  return months > 0
    ? `${months} month${months > 1 ? "s" : ""}`
    : `${days} days`;
}

// --- Generate Offer Letter ---
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
      shift,
      probationDays,
    } = req.body;

    if (
      !candidateName ||
      !candidateEmail ||
      !position ||
      !startDate ||
      !reportingTime ||
      !confirmationDeadlineDate ||
      !probationDays
    ) {
      return res
        .status(400)
        .json({ error: "Missing required candidate or date fields." });
    }
    if (!req.user || !req.user._id) {
      return res.status(401).json({ error: "No user context found." });
    }

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
    const signature = await Signature.findOne({ owner: ownerId });

    let signatureBlock = "";
    if (signature) {
      signatureBlock = `
        <div style="margin-top:32px;margin-bottom:12px;">
          ${
            signature.signatureImage
              ? `<img src="${process.env.SERVER_URL || ""}${
                  signature.signatureImage
                }" alt="Signature" style="height:70px;display:block;margin-bottom:6px;object-fit:contain;max-width:200px;" />`
              : ""
          }
          <div style="text-align:left;">
            ${signature.signatureText}
          </div>
        </div>
      `;
    }

    let bodyHtml = `
      <div style="font-family: 'Comic Sans MS', Comic Sans, cursive, Arial, sans-serif; font-size: 16px; color: #212121; line-height: 1.7; text-align: left; margin:0; padding:0; max-width:600px;">
        <p>Dear <strong>${candidateName}</strong>,</p>
        <p>We're thrilled to have you on board!</p>
        <p>
          After getting to know you during your recent interview, we were truly inspired by your passion, potential, and the energy you bring. It gives us great pleasure to officially offer you the position of <b>${position}</b> at <b>${company.name}</b>.
        </p>
        <p>
          Your appointment is subject to a <b>${probationDaysToMonths(probationDays)}</b>, after successful completion of which your position will be confirmed as permanent.
        </p>
        <p>
          We believe you will be a valuable addition to our growing team, and we're excited about what we can build together. This isn't just a job it's a journey, and we're looking forward to seeing you thrive with us.
        </p>
        <p>Your monthly gross salary will be <b>PKR ${grossSalary}</b>, paid through online bank transfer at the end of each month.</p>
        <p>If you accept this offer, your anticipated start date will be <b>${formattedStartDate}</b>, and we look forward to welcoming you in person at our <b>${address}</b> by <b>${formattedTime}</b>.</p>
        <p>In this role, you'll be working 45 hours per week, from Monday to Friday a full week of opportunities to grow, collaborate, and contribute.</p>
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
          We're truly excited to have you join us. Your future teammates are just as eager to welcome you, support you, and learn from you as you are to begin this new chapter. Let's make great things happen together!
        </p>
        <p style="margin-top:12px">
          Regards,
        </p>
        ${signatureBlock}
      </div>
    `.trim();

    bodyHtml = enforceComicSans(bodyHtml);
    bodyHtml = enforceImgCss(bodyHtml);

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
    console.error("Offer gen error:", err);
    return res.status(500).json({ error: "Failed to generate offer letter." });
  }
}

// --- Send Offer Letter ---
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
      shift,
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

    let employee = await Employee.findOne({ email: candidateEmail });
    if (employee) {
      return res.status(400).json({
        error: "An employee with this email already exists. Offer not sent.",
      });
    }

    employee = await Employee.create({
      name: candidate,
      email: candidateEmail,
      designation: position,
      joiningDate: startDate,
      department: department || null,
      owner: req.user?._id,
      createdBy: req.user?._id,
      shifts: shift ? [shift] : undefined,
    });

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

    await Salaries.create(slipData);

    let html = enforceComicSans(letter);
    html = enforceImgCss(html);

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
}

module.exports = {
  generateOfferLetter,
  sendOfferLetter,
};