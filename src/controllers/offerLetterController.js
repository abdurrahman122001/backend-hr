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

// --- Beautified Signature and Disclaimer (Comic Sans, block style) ---
const EMAIL_SIGNATURE = `
  <div style="font-family: 'Comic Sans MS', Comic Sans, cursive; font-size: 18px; margin-top:28px; margin-bottom:0; line-height:1.7; color:#1a1a1a;">
    <div style="margin-bottom:10px;">
      <strong>Regards,</strong><br>
      <span style="font-weight:bold;">Human Resource Department</span><br>
      <span style="font-style: italic;">Mavens Advisor</span>
    </div>
    <div style="margin-bottom:10px;">
      <div style="margin-bottom:2px;"><b>T</b> +44 7451 285285</div>
      <div style="margin-bottom:2px;"><b>E</b> <a href="mailto:HR@mavensadvisor.com" style="color:#0057b7; text-decoration:underline;">HR@mavensadvisor.com</a></div>
      <div style="margin-bottom:2px;"><b>W</b> <a href="https://www.mavensadvisor.com" style="color:#0057b7; text-decoration:underline;">www.mavensadvisor.com</a></div>
    </div>
    <div>
      <span>Mavens Advisor LLC</span><br>
      <span>East Grand Boulevard, Detroit</span><br>
      <span>Michigan, United States</span>
    </div>
  </div>
`;

const EMAIL_DISCLAIMER = `
  <div style="margin-top:28px; margin-bottom:0;">
    <div style="background:#f4f4f4; border-radius:7px; font-family:'Comic Sans MS', Comic Sans, cursive, monospace; font-size:13px; color:#333; white-space:pre-wrap; padding:18px 12px; overflow-x:auto; border:1.5px solid #dadada;">
*********************************************************************************

The information contained in this email (including any attachments) is intended only for the personal and confidential use of the recipient(s) named above. If you are not an intended recipient of this message, please notify the sender by replying to this message and then delete the message and any copies from your system. Any use, dissemination, distribution, or reproduction of this message by unintended recipients is not authorized and may be unlawful.

*********************************************************************************
    </div>
  </div>
`;

// --- For text-only fallback (strip all HTML) ---
function htmlToText(html) {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<li>/gi, "• ")
    .replace(/<\/li>/gi, "\n")
    .replace(/<ul[^>]*>/gi, "")
    .replace(/<\/ul>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stripSignatureAndDisclaimer(html) {
  // Remove both EMAIL_SIGNATURE and EMAIL_DISCLAIMER if present
  let out = html.replace(EMAIL_SIGNATURE.trim(), "");
  out = out.replace(EMAIL_DISCLAIMER.trim(), "");
  return out.replace(/\s*$/, ""); // Remove trailing whitespace
}

module.exports = {
  // GENERATE OFFER LETTER: Always add signature/disclaimer for Quill preview
  async generateOfferLetter(req, res) {
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

      // Do not generate if employee already exists
      const exists = await Employee.findOne({ email: candidateEmail });
      if (exists) {
        return res.status(400).json({
          error: "An employee with this email already exists.",
        });
      }

      if (
        !candidateName ||
        !candidateEmail ||
        !position ||
        !startDate ||
        !reportingTime ||
        !confirmationDeadlineDate
      ) {
        return res
          .status(400)
          .json({ error: "Missing required candidate or date fields." });
      }
      if (!req.user || !req.user._id) {
        return res.status(400).json({ error: "No user context found." });
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

      // Offer letter HTML, signature, disclaimer: all Comic Sans, always at the end
      const bodyHtml = `
        <div style="font-family: 'Comic Sans MS', Comic Sans, cursive; font-size: 18px;">
          <p>Dear ${candidateName},</p>
          <p>We’re thrilled to have you on board!</p>
          <p>After getting to know you during your recent interview, we were truly inspired by your passion, potential, and the energy you bring. It gives us great pleasure to officially offer you the position of <b>${position}</b> at <b>${company.name}</b>.</p>
          <p>We believe you will be a valuable addition to our growing team, and we’re excited about what we can build together. This isn’t just a job it’s a journey, and we’re looking forward to seeing you thrive with us.</p>
          <p>Your monthly gross salary will be <b>PKR ${grossSalary}</b>, paid through online bank transfer at the end of each month.</p>
          <p>If you accept this offer, your anticipated start date will be <b>${formattedStartDate}</b>, and we look forward to welcoming you in person at our <b>${address}</b> by <b>${formattedTime}</b>.</p>
          <p>In this role, you’ll be working 45 hours per week, from Monday to Friday – a full week of opportunities to grow, collaborate, and contribute.</p>
          <p>To move forward, please confirm your acceptance of this offer by <b>${formattedDeadline}</b>. On your first day, we kindly ask that you bring:</p>
          <ul>
            <li>All original educational and professional certificates</li>
            <li>Original CNIC with a photocopy</li>
            <li>Two recent passport-sized photographs</li>
          </ul>
          <p>By accepting this offer, you also agree to the terms set forth in our Employment Contract and Non-Disclosure Agreement (NDA), which we will share with you separately.</p>
          <p>We’re truly excited to have you join us. Your future teammates are just as eager to welcome you, support you, and learn from you as you are to begin this new chapter. Let’s make great things happen together!</p>
          ${EMAIL_SIGNATURE}
          ${EMAIL_DISCLAIMER}
        </div>
      `.trim();

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
  },

  // SEND OFFER LETTER: send exactly as in Quill, do not append, do not duplicate
  async sendOfferLetter(req, res) {
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

      // Otherwise, create new employee
      employee = await Employee.create({
        name: candidate,
        email: candidateEmail,
        designation: position,
        startDate,
        department: department || null,
        owner: req.user?._id,
        createdBy: req.user?._id,
      });

      // ENCRYPT SalarySlip fields (except _id/refs)
      const grossSalaryRaw = SALARY_COMPONENTS.reduce(
        (sum, k) => sum + (Number(salaryBreakup[k]) || 0),
        0
      );
      const slipData = {
        employee: employee._id,
        candidateName: encrypt(candidate),
        candidateEmail: encrypt(candidateEmail),
        position: encrypt(position),
        startDate: encrypt(startDate),
        reportingTime: encrypt(reportingTime),
        confirmationDeadlineDate: encrypt(confirmationDeadlineDate),
        grossSalary: encrypt(grossSalaryRaw.toString()),
        owner: req.user?._id,
        createdBy: req.user?._id,
      };
      SALARY_COMPONENTS.forEach((k) => {
        slipData[k] = encrypt((salaryBreakup[k] || 0).toString());
      });
      await SalarySlip.create(slipData);

      // Send *exact* HTML from Quill editor (already has signature/disclaimer)
      const html = letter;

      // Fallback: plain text
      const text = htmlToText(letter);

      await transporter.sendMail({
        from: `"${process.env.MAIL_FROM_NAME}" <${process.env.MAIL_FROM_ADDRESS}>`,
        to: candidateEmail,
        subject: "Welcome Aboard – Offer of Employment",
        text: text,
        html: html,
      });

      return res.json({ success: true });
    } catch (err) {
      console.error("Email send error:", err);
      return res.status(500).json({ error: "Failed to send offer letter." });
    }
  },
};
