require("dotenv").config();
const mongoose = require("mongoose");
const CompanyProfile = require("../models/CompanyProfile");
const SalarySlip = require("../models/SalarySlip");
const Employee = require("../models/Employees");
const nodemailer = require("nodemailer");

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

// --- Signature Block (Comic Sans, but contact details neatly in a table) ---
const EMAIL_SIGNATURE = `
  <div style="font-family: 'Comic Sans MS', Comic Sans, cursive; font-size: 15px; margin-top:32px; margin-bottom:0; line-height:1.6;">
    <div style="margin-bottom:10px;">
      Regards,<br>
      <span style="font-weight:bold;">Human Resource Department</span><br>
      <span style="font-style: italic;">Mavens Advisor</span>
    </div>
    <table style="font-family:inherit; font-size:15px; line-height:1.4; margin-bottom:8px;">
      <tr>
        <td style="padding-right:12px;"><b>T</b></td>
        <td>+44 7451 285285</td>
      </tr>
      <tr>
        <td style="padding-right:12px;"><b>E</b></td>
        <td><a href="mailto:HR@mavensadvisor.com" style="color:#0057b7; text-decoration:underline;">HR@mavensadvisor.com</a></td>
      </tr>
      <tr>
        <td style="padding-right:12px;"><b>W</b></td>
        <td><a href="https://www.mavensadvisor.com" style="color:#0057b7; text-decoration:underline;">www.mavensadvisor.com</a></td>
      </tr>
    </table>
    <div>
      Mavens Advisor LLC<br>
      East Grand Boulevard, Detroit<br>
      Michigan, United States
    </div>
  </div>
`;

const EMAIL_DISCLAIMER = `
  <div style="margin-top:28px;">
    <div style="background:#f4f4f4; border-radius:7px; font-family:monospace; font-size:13px; color:#333; white-space:pre; padding:18px 12px; overflow-x:auto;">
*********************************************************************************

The information contained in this email (including any attachments) is intended only for the personal and confidential use of the recipient(s) named above. If you are not an intended recipient of this message, please notify the sender by replying to this message and then delete the message and any copies from your system. Any use, dissemination, distribution, or reproduction of this message by unintended recipients is not authorized and may be unlawful.

*********************************************************************************
    </div>
  </div>
`;

// --- Helper: Convert HTML to plain text for email fallback (minimal) ---
function htmlToText(html) {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<li>/gi, "• ")
    .replace(/<\/li>/gi, "\n")
    .replace(/<ul[^>]*>/gi, "")
    .replace(/<\/ul>/gi, "")
    .replace(/<[^>]+>/g, "") // remove all other tags
    .replace(/\n{3,}/g, "\n\n") // reduce 3+ newlines to 2
    .trim();
}

module.exports = {
  // Only generates letter (NO DB WRITE)
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
        department, // DEPARTMENT NAME should be sent from frontend
      } = req.body;

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

      // --- HTML VERSION for Quill/editor ---
      const letter = `
      
<p>Dear ${candidateName},</p>

<p>We’re thrilled to have you on board!</p>

<p>After getting to know you during your recent interview, we were truly inspired by your passion, potential, and the energy you bring. It gives us great pleasure to officially offer you the position of <b>${position}</b> at <b>${company.name}</b>.</p>

<p>We believe you will be a valuable addition to our growing team, and we’re excited about what we can build together. This isn’t just a job it’s a journey, and we’re looking forward to seeing you thrive with us.</p>

<p>Your monthly gross salary will be <b>PKR ${grossSalary}</b>, paid through online bank transfer at the end of each month.</p>

<p>If you accept this offer, your anticipated start date will be <b>${formattedStartDate}</b>, and we look forward to welcoming you in person at our <b>${address}</b> by <b>${formattedTime}</b>.</p>

<p>In this role, you’ll be working 45 hours per week, from Monday to Friday a full week of opportunities to grow, collaborate, and contribute.</p>

<p>To move forward, please confirm your acceptance of this offer by <b>${formattedDeadline}</b>. On your first day, we kindly ask that you bring:</p>
<ul>
  <li>All original educational and professional certificates</li>
  <li>Original CNIC with a photocopy</li>
  <li>Two recent passport-sized photographs</li>
</ul>

<p>By accepting this offer, you also agree to the terms set forth in our Employment Contract and Non-Disclosure Agreement (NDA), which we will share with you separately.</p>

<p>We’re truly excited to have you join us. Your future teammates are just as eager to welcome you, support you, and learn from you as you are to begin this new chapter. Let’s make great things happen together!</p>
`.trim();

      // Send as {letter} so frontend puts directly into ReactQuill!
      return res.json({
        letter,
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

  // Actually sends the letter and CREATES Employee & SalarySlip
  async sendOfferLetter(req, res) {
    try {
      const {
        candidateEmail,
        letter, // This is HTML from Quill!
        salaryBreakup,
        position,
        candidateName,
        startDate,
        reportingTime,
        confirmationDeadlineDate,
        department, // <-- department name (string)
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

      // Check for existing employee to enable threading (optional)
      let employee = await Employee.findOne({ email: candidateEmail });
      if (!employee) {
        employee = await Employee.create({
          name: candidate,
          email: candidateEmail,
          designation: position,
          startDate,
          department: department || null,
          owner: req.user?._id,
          createdBy: req.user?._id,
        });
      } else {
        employee.name = candidate;
        employee.designation = position;
        employee.startDate = startDate;
        employee.department = department || employee.department;
        await employee.save();
      }

      // Create SalarySlip
      const grossSalaryRaw = SALARY_COMPONENTS.reduce(
        (sum, k) => sum + (Number(salaryBreakup[k]) || 0),
        0
      );
      const slipData = {
        employee: employee._id,
        candidateName: candidate,
        candidateEmail,
        position,
        startDate,
        reportingTime,
        confirmationDeadlineDate,
        grossSalary: grossSalaryRaw,
        owner: req.user?._id,
        createdBy: req.user?._id,
      };
      SALARY_COMPONENTS.forEach(
        (k) => (slipData[k] = Number(salaryBreakup[k]) || 0)
      );
      await SalarySlip.create(slipData);

      // --- Email: Use HTML directly as received ---
      const html = `
  <div style="font-family: 'Comic Sans MS', Comic Sans, cursive; font-size: 16px;">
        ${letter}
        ${EMAIL_SIGNATURE}
        ${EMAIL_DISCLAIMER}
      </div>
      `;

      // Fallback: convert Quill HTML to plain text for .text email
      const text =
        htmlToText(letter) +
        `

Regards,
Human Resource Department
Mavens Advisor

T          +44 7451 285285  
E          HR@mavensadvisor.com  
W         www.mavensadvisor.com

Mavens Advisor LLC  
East Grand Boulevard, Detroit  
Michigan, United States

*********************************************************************************

The information contained in this email (including any attachments) is intended only for the personal and confidential use of the recipient(s) named above. If you are not an intended recipient of this message, please notify the sender by replying to this message and then delete the message and any copies from your system. Any use, dissemination, distribution, or reproduction of this message by unintended recipients is not authorized and may be unlawful.

*********************************************************************************
`;

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
