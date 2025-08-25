// controllers/offerLetterController.js
const mongoose = require("mongoose");
const CompanyProfile = require("../models/CompanyProfile");
const Salaries = require("../models/Salaries");
const Employee = require("../models/Employees");
const nodemailer = require("nodemailer");
const { encrypt } = require("../utils/encryption");
const Signature = require("../models/Signature");
require("dotenv").config();

/* ----------------------------- Mail Transport ----------------------------- */
const transporter = nodemailer.createTransport({
  host: process.env.MAIL_HOST,
  port: Number(process.env.MAIL_PORT),
  secure: Number(process.env.MAIL_PORT) === 465,
  auth: {
    user: process.env.MAIL_USERNAME,
    pass: process.env.MAIL_PASSWORD,
  },
  tls: { rejectUnauthorized: false },
});

/* ----------------------------- Env Fallbacks ------------------------------ */
const FALLBACKS = {
  name: process.env.COMPANY_NAME || "Mavens Advisors",
  email: process.env.COMPANY_EMAIL || "HR@mavensadvisor.com",
  phone: process.env.COMPANY_CONTACT || "+92 312 3850846",
  website: process.env.COMPANY_WEBSITE || "www.mavensadvisor.com",
  address: "GULSHAN-E-MAYMAR, KARACHI",
};

/* ------------------------------ Salary Fields ----------------------------- */
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

/* ----------------------------- Helper: Company ---------------------------- */
async function getCompanyContext(ownerId) {
  let companyDoc = null;
  try {
    companyDoc = await CompanyProfile.findOne(
      { owner: ownerId },
      { name: 1, email: 1, phone: 1, website: 1, address: 1 }
    ).lean();
  } catch (_) {
    // ignore and fall back
  }
  const name = (companyDoc?.name || "").trim() || FALLBACKS.name;
  const email = (companyDoc?.email || "").trim() || FALLBACKS.email;
  const phone = (companyDoc?.phone || "").trim() || FALLBACKS.phone;
  const website = (companyDoc?.website || "").trim() || FALLBACKS.website;
  const address =
    (companyDoc?.address && String(companyDoc.address).trim()) ||
    FALLBACKS.address;

  return { name, email, phone, website, address };
}

/* ----------------------------- Helper: Styles ----------------------------- */
// Enforce Comic Sans on common blocks WITHOUT altering paragraph margins.
// --- Helper: Force Comic Sans + HARD margin:0 on <p> across clients ---
function enforceComicSans(html) {
  const family =
    "font-family: 'Comic Sans MS', Comic Sans, cursive, Arial, sans-serif;";
  // Works better across Gmail/Outlook: include margin-block and MSO fallbacks
  const pRequired = [
    "margin:0 !important",
    "margin-block-start:0",
    "margin-block-end:0",
    "mso-margin-top-alt:0",
    "mso-margin-bottom-alt:0",
    "mso-line-height-rule:exactly",
    family,
  ].join("; ");

  // Normalize <p> …> style
  html = html.replace(/<p\b([^>]*)>/gi, (full, attrs) => {
    // If style exists, rewrite it
    if (/style\s*=/.test(attrs)) {
      const newAttrs = attrs.replace(/style\s*=\s*"([^"]*)"/i, (_m, style) => {
        let cleaned = style
          // strip any margin-related declarations
          .replace(/(^|;)\s*margin[^;]*;?/gi, "")
          .replace(/(^|;)\s*margin-block-(start|end)\s*:[^;]*;?/gi, "")
          // strip font-family + old MSO margin hints
          .replace(/(^|;)\s*font-family\s*:[^;]*;?/gi, "")
          .replace(/(^|;)\s*mso-[^;]*;?/gi, "")
          // tidy ; ;
          .replace(/;;+/g, ";")
          .replace(/^\s*;|;\s*$/g, "");
        return `style="${pRequired}${cleaned ? "; " + cleaned : ""}"`;
      });
      // Ensure there is a leading space before remaining attrs
      const spaced = newAttrs.trim().length ? " " + newAttrs.trim() : "";
      return `<p${spaced}>`;
    }
    // No style attr: inject one
    const spaced = attrs.trim().length ? " " + attrs.trim() : "";
    return `<p style="${pRequired}"${spaced}>`;
  });

  // Apply Comic Sans to ul/ol/li/div (preserve their margins)
  const addFamily = (tag) => {
    // with existing style
    html = html.replace(
      new RegExp(`<${tag}\\b([^>]*)style="([^"]*)"([^>]*)>`, "gi"),
      (full, pre, style, post) => {
        const cleaned = style
          .replace(/(^|;)\s*font-family\s*:[^;]*;?/gi, "")
          .replace(/;;+/g, ";")
          .replace(/^\s*;|;\s*$/g, "");
        return `<${tag}${pre}style="${family}${cleaned ? " " + cleaned : ""}"${post}>`;
      }
    );
    // without style
    html = html.replace(
      new RegExp(`<${tag}\\b(?![^>]*\\bstyle=)([^>]*)>`, "gi"),
      `<${tag} style="${family}"$1>`
    );
  };
  ["ul", "ol", "li", "div"].forEach(addFamily);

  return html;
}
function enforceImgCss(html) {
  // Remove any existing style attr on <img>
  html = html.replace(/<img([^>]*?)style="[^"]*"/gi, `<img$1`);
  // Add our enforced style
  html = html.replace(
    /<img([^>]*?)\/?>/gi,
    `<img$1 style="height:200px;width:200px;object-fit:contain;display:inline-block;vertical-align:middle;max-width:200px;max-height:200px;" />`
  );
  return html;
}
/* --------------------------- Helper: Formatting --------------------------- */
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

// normalize to 24h HH:mm
function normalizeTime(timeStr) {
  if (!timeStr || typeof timeStr !== "string") return "";
  const [hRaw = "", mRaw = ""] = timeStr.split(":");
  const h = String(hRaw).padStart(2, "0");
  const m = String(mRaw).padStart(2, "0");
  return `${h}:${m}`;
}

function formatNumberWithCommas(x) {
  return Number(x).toLocaleString("en-PK");
}

function probationDaysToMonths(probationDays) {
  const days = Number(probationDays) || 0;
  if (!days) return "";
  const months = Math.round(days / 30);
  return months > 0 ? `${months} month${months > 1 ? "s" : ""}` : `${days} days`;
}

/* ------------------------ Controller: Generate Letter --------------------- */
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

    const companyCtx = await getCompanyContext(ownerId);

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
        <div>
        <br>
          ${
            signature.signatureImage
              ? `<img src="${process.env.SERVER_URL || ""}${signature.signatureImage}" alt="Signature" style="height:70px;display:block;margin-bottom:6px;object-fit:contain;max-width:200px;" />`
              : ""
          }
          <div style="text-align:left;">
            ${signature.signatureText}
          </div>
        </div>
      `;
    }

    // Keep natural paragraph margins; Comic Sans is enforced later
    let bodyHtml = `
      <div style="font-family: 'Comic Sans MS', Comic Sans, cursive, Arial, sans-serif; font-size: 16px; color: #212121; line-height: 1.7; text-align: left; padding:0; max-width:600px;">
        <p>Dear <strong>${candidateName}</strong>,</p>
        <br>
        <p>We're thrilled to have you on board!</p>
        <br>
        <p>
          After getting to know you during your recent interview, we were truly inspired by your passion, potential, and the energy you bring. It gives us great pleasure to officially offer you the position of <b>${position}</b> at <b>${companyCtx.name}</b>.
        </p>
        <br>
        <p>
          Your appointment is subject to a <b>${probationDaysToMonths(
            probationDays
          )}</b>, after successful completion of which your position will be confirmed as permanent.
        </p>
        <br>
        <p>
          We believe you will be a valuable addition to our growing team, and we're excited about what we can build together. This isn't just a job it's a journey, and we're looking forward to seeing you thrive with us.
        </p>
        <br>
        <p>Your monthly gross salary will be <b>PKR ${grossSalary}</b>, paid through online bank transfer at the end of each month.</p>
        <br>
        <p>If you accept this offer, your anticipated start date will be <b>${formattedStartDate}</b>, and we look forward to welcoming you in person at our <b>${companyCtx.address}</b> by <b>${formattedTime}</b>.</p>
        <br>
        <p>In this role, you'll be working 45 hours per week, from Monday to Friday—a full week of opportunities to grow, collaborate, and contribute.</p>
        <br>
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
        <br>
        <p>
          We're truly excited to have you join us. Your future teammates are just as eager to welcome you, support you, and learn from you as you are to begin this new chapter. Let's make great things happen together!
        </p>
        ${signatureBlock}
      </div>
    `.trim();

    bodyHtml = enforceComicSans(bodyHtml); // font only, keep paragraph margins
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
      // (Optional) expose company context if frontend wants to show it
      company: companyCtx,
    });
  } catch (err) {
    console.error("Offer gen error:", err);
    return res.status(500).json({ error: "Failed to generate offer letter." });
  }
}

/* -------------------------- Controller: Send Letter ----------------------- */
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
      probationDays,
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

    let existing = await Employee.findOne({ email: candidateEmail });
    if (existing) {
      return res.status(400).json({
        error: "An employee with this email already exists. Offer not sent.",
      });
    }

    if (!req.user || !req.user._id) {
      return res.status(401).json({ error: "No user context found." });
    }
    const ownerId = req.user._id;
    const companyCtx = await getCompanyContext(ownerId);

    const probationDaysNum = Number(probationDays) || 0;
    const normalizedRT = normalizeTime(reportingTime);

    // Create employee (probation -> 0 total leave)
    let employee = await Employee.create({
      name: candidate,
      email: candidateEmail,
      designation: position,
      joiningDate: startDate,
      department: department || null,
      owner: ownerId,
      createdBy: ownerId,
      rt: normalizedRT,
      shifts: shift ? [shift] : undefined,
      ...(probationDaysNum > 0
        ? {
            leaveEntitlement: {
              total: 0,
              usedPaid: 0,
              usedUnpaid: 0,
            },
          }
        : {}),
    });

    if (probationDaysNum > 0) {
      await Employee.updateOne(
        { _id: employee._id },
        { $set: { "leaveEntitlement.total": 0 } },
        { runValidators: false }
      );
      employee = await Employee.findById(employee._id);
    }

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
      reportingTime: await encrypt(normalizedRT),
      confirmationDeadlineDate: await encrypt(confirmationDeadlineDate),
      grossSalary: await encrypt(grossSalaryRaw.toString()),
      owner: ownerId,
      createdBy: ownerId,
      ...encryptedSalaryBreakup,
      probationDays: await encrypt((Number(probationDays) || 0).toString()),
    };

    await Salaries.create(slipData);

    // Apply Comic Sans & image CSS to the provided letter (do NOT change <p> margins)
    let html = enforceComicSans(letter);
    html = enforceImgCss(html);
    const text = html.replace(/<[^>]+>/g, " ");

    await transporter.sendMail({
      from: `"${process.env.MAIL_FROM_NAME}" <${process.env.MAIL_FROM_ADDRESS}>`,
      to: candidateEmail,
      subject: `Welcome Aboard – Offer of Employment at ${companyCtx.name}`,
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
