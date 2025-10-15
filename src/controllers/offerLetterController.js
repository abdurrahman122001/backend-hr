const mongoose = require("mongoose");
const CompanyProfile = require("../models/CompanyProfile");
const Salaries = require("../models/Salaries");
const Employee = require("../models/Employees");
const nodemailer = require("nodemailer");
const { encrypt } = require("../utils/encryption");
const Signature = require("../models/Signature");
const OfferEmailTemplate = require("../models/OfferEmailTemplate");
const probationPeriods = require("../models/ProbationPeriod");
const OfferEmailGenerated = require("../models/OfferEmailGenerated");
require("dotenv").config();

/* ----------------------------- Mail Transport ----------------------------- */
const transporter = nodemailer.createTransport({
  host: process.env.MAIL_HOST,
  port: Number(process.env.MAIL_PORT),
  secure: Number(process.env.MAIL_PORT) === 465,
  auth: { user: process.env.MAIL_USERNAME, pass: process.env.MAIL_PASSWORD },
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

function sanitizeName(raw = "") {
  return String(raw).replace(/[0-9]/g, "").replace(/\s+/g, " ").trim();
}

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
  } catch (_) {}
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
function enforceComicSans(html) {
  const family = "font-family: Arial, Helvetica, sans-serif; font-size: 16px";
  const pRequired = [
    "margin:0 !important",
    "margin-block-start:0",
    "margin-block-end:0",
    "mso-margin-top-alt:0",
    "mso-margin-bottom-alt:0",
    "mso-line-height-rule:exactly",
    family,
  ].join("; ");
  html = html.replace(/<p\b([^>]*)>/gi, (full, attrs) => {
    if (/style\s*=/.test(attrs)) {
      const newAttrs = attrs.replace(/style\s*=\s*"([^"]*)"/i, (_m, style) => {
        let cleaned = style
          .replace(/(^|;)\s*margin[^;]*;?/gi, "")
          .replace(/(^|;)\s*margin-block-(start|end)\s*:[^;]*;?/gi, "")
          .replace(/(^|;)\s*font-family\s*:[^;]*;?/gi, "")
          .replace(/(^|;)\s*mso-[^;]*;?/gi, "")
          .replace(/;;+/g, ";")
          .replace(/^\s*;|;\s*$/g, "");
        return `style="${pRequired}${cleaned ? "; " + cleaned : ""}"`;
      });
      const spaced = newAttrs.trim().length ? " " + newAttrs.trim() : "";
      return `<p${spaced}>`;
    }
    const spaced = attrs.trim().length ? " " + attrs.trim() : "";
    return `<p style="${pRequired}"${spaced}>`;
  });
  const addFamily = (tag) => {
    html = html.replace(
      new RegExp(`<${tag}\\b([^>]*)style="([^"]*)"([^>]*)>`, "gi"),
      (full, pre, style, post) => {
        const cleaned = style
          .replace(/(^|;)\s*font-family\s*:[^;]*;?/gi, "")
          .replace(/;;+/g, ";")
          .replace(/^\s*;|;\s*$/g, "");
        return `<${tag}${pre}style="${family}${
          cleaned ? " " + cleaned : ""
        }"${post}>`;
      }
    );
    html = html.replace(
      new RegExp(`<${tag}\\b(?![^>]*\\bstyle=)([^>]*)>`, "gi"),
      `<${tag} style="${family}"$1>`
    );
  };
  ["ul", "ol", "li", "div"].forEach(addFamily);
  return html;
}
function enforceImgCss(html) {
  html = html.replace(/<img([^>]*?)style="[^"]*"/gi, `<img$1`);
  html = html.replace(
    /<img([^>]*?)\/?>/gi,
    `<img$1 style="height:200px;width:200px;object-fit:contain;display:inline-block;vertical-align:middle;max-width:200px;max-height:200px;" />`
  );
  return html;
}

/* --------------------------- Helper: Formatting --------------------------- */
function formatDateDMY(dateInput) {
  if (!dateInput) return "";
  const d = new Date(dateInput);
  if (isNaN(d.getTime())) return "";
  return `${d.getDate()} ${d.toLocaleString("default", {
    month: "long",
  })} ${d.getFullYear()}`;
}
function formatTime12hr(timeStr) {
  if (!timeStr) return "";
  let [h, m] = timeStr.includes(":")
    ? [+timeStr.split(":")[0], timeStr.split(":")[1]]
    : [+timeStr, "00"];
  let suf = "AM";
  if (h >= 12) {
    suf = "PM";
    if (h > 12) h -= 12;
  }
  if (h === 0) h = 12;
  return `${h}:${String(m).padStart(2, "0")} ${suf}`;
}
function normalizeTime(s) {
  if (!s || typeof s !== "string") return "";
  const [h = "00", m = "00"] = s.split(":");
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
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

/* -------------------- Robust template renderer --------------------------- */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function renderWithContext(tpl = "", ctx = {}) {
  let out = String(tpl || "");
  // Replace longest keys first
  const keys = Object.keys(ctx).sort((a, b) => b.length - a.length);
  for (const k of keys) {
    const re = new RegExp(`{{\\s*${escapeRegExp(k)}\\s*}}`, "g");
    out = out.replace(re, String(ctx[k] ?? ""));
  }
  return out;
}
/* ------------------------ Build render context --------------------------- */
/* ------------------------ Build render context --------------------------- */
function probationDaysToMonths(probationDays) {
  const days = Number(probationDays) || 0;
  if (!days) return "";
  const months = Math.round(days / 30);
  return months > 0
    ? `${months} month${months > 1 ? "s" : ""}`
    : `${days} days`;
}

async function buildContext({
  ownerId,
  candidateName,
  candidateEmail,
  position,
  salaryBreakup,
  startDate,
  reportingTime,
  confirmationDeadlineDate,
  department,
  shift,
  probationDays,
}) {
  const companyCtx = await getCompanyContext(ownerId);
  const safeCandidateName = sanitizeName(candidateName);

  const formattedStartDate = formatDateDMY(startDate);
  const formattedDeadline = formatDateDMY(confirmationDeadlineDate);
  const formattedTime = formatTime12hr(reportingTime);

  const grossSalaryRaw = SALARY_COMPONENTS.reduce(
    (sum, k) => sum + (Number(salaryBreakup?.[k]) || 0),
    0
  );
  const grossSalary = formatNumberWithCommas(grossSalaryRaw);

  const signature = await Signature.findOne({ owner: ownerId });
  const signatureBlock = signature
    ? `
    <div>
      <br>
      ${
        signature.signatureImage
          ? `<img src="${process.env.SERVER_URL || ""}${
              signature.signatureImage
            }" 
                   alt="Signature" 
                   style="height:70px;display:block;margin-bottom:6px;object-fit:contain;max-width:200px;" />`
          : ""
      }
      <div style="text-align:left;">${signature.signatureText || ""}</div>
    </div>
  `
    : "";

  const probationDaysNum = Number(probationDays) || 0;
  const probationPeriodText = probationDaysToMonths(probationDaysNum);

  console.log("🔍 DEBUG probationDays:", probationDays); // Should be raw number like "90"
  console.log("🔍 DEBUG probationPeriodText:", probationPeriodText); // Should be "3 months"

  const ctx = {
    candidateName: safeCandidateName,
    position,
    companyName: companyCtx.name,
    companyAddress: companyCtx.address,
    formattedStartDate,
    formattedDeadline,
    formattedTime,
    grossSalary,

    // 🔑 CRITICAL FIX: probationDays should be the FORMATTED text
    probationDays: probationPeriodText, // This replaces {{probationDays}} with "3 months"

    signatureHtml: signatureBlock,
    signatureBlock: signatureBlock,
  };

  console.log("🔍 DEBUG final ctx.probationDays:", ctx.probationDays); // Should be "3 months"

  return {
    ctx,
    companyCtx,
    signatureBlock,
    safeCandidateName,
    grossSalaryRaw,
  };
}
/* -------------------------- Controller: Send (single-step) --------------- */
async function sendOfferLetter(req, res) {
  try {
    const {
      candidateEmail,
      candidateName,
      position,
      salaryBreakup = {},
      startDate,
      reportingTime,
      confirmationDeadlineDate,
      department,
      shift,
      probationDays,
      subject: subjectOverride,
      letter: letterOverride, // optional from client editor
    } = req.body;

    if (
      !candidateEmail ||
      !candidateName ||
      !position ||
      !startDate ||
      !reportingTime ||
      !confirmationDeadlineDate ||
      !probationDays
    ) {
      return res
        .status(400)
        .json({ error: "Missing required fields for sending offer." });
    }
    if (!req.user || !req.user._id) {
      return res.status(401).json({ error: "No user context found." });
    }
    let ownerId = req.user._id;
    if (!(ownerId instanceof mongoose.Types.ObjectId))
      ownerId = new mongoose.Types.ObjectId(ownerId);

    const exists = await Employee.findOne({ email: candidateEmail });
    if (exists)
      return res
        .status(400)
        .json({
          error: "An employee with this email already exists. Offer not sent.",
        });

    // Build context and load template
    const {
      ctx,
      companyCtx,
      signatureBlock,
      safeCandidateName,
      grossSalaryRaw,
    } = await buildContext({
      ownerId,
      candidateName,
      candidateEmail,
      position,
      salaryBreakup,
      startDate,
      reportingTime,
      confirmationDeadlineDate,
      department,
      shift,
      probationDays,
    });

    const key = "offer_letter";
    const tpl = await OfferEmailTemplate.findOne({
      owner: ownerId,
      key,
    }).lean();

    // Render final subject + html (prefer client override but ensure signature)
    let finalSubject =
      subjectOverride ||
      (tpl
        ? renderWithContext(tpl.subject || "", ctx)
        : `Offer of Employment – ${position} at ${companyCtx.name}`);
    let finalHtml =
      letterOverride ||
      (tpl
        ? renderWithContext(tpl.html || "", ctx)
        : `
      <div style="font-family: Arial, sans-serif; line-height:1.7;">
        <p>Dear <b>${safeCandidateName}</b>,</p>
        <p>We're thrilled to have you on board!</p>
        <p>It gives us great pleasure to officially offer you the position of <b>${position}</b> at <b>${companyCtx.name}</b>.</p>
        {{signatureBlock}}
      </div>
    `.trim());

    // Ensure signature is present (if template/editor forgot it)
    if (!/signatureBlock/i.test(finalHtml)) {
      finalHtml += signatureBlock;
    }

    finalHtml = enforceImgCss(enforceComicSans(finalHtml));

    // Persist generated email
    await OfferEmailGenerated.create({
      owner: ownerId,
      key,
      candidateEmail,
      subject: finalSubject,
      html: finalHtml,
      context: ctx,
    });

    // Create employee + salary (encrypted) and send email
    const normalizedRT = normalizeTime(reportingTime);
    const probationDaysNum = Number(probationDays) || 0;

    let employee = await Employee.create({
      name: sanitizeName(candidateName),
      email: candidateEmail,
      designation: position,
      joiningDate: startDate,
      department: department || null,
      owner: ownerId,
      createdBy: ownerId,
      rt: normalizedRT,
      shifts: shift ? [shift] : undefined,
      ...(probationDaysNum > 0
        ? { leaveEntitlement: { total: 0, usedPaid: 0, usedUnpaid: 0 } }
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

    const encryptedSalaryFields = await Promise.all(
      SALARY_COMPONENTS.map(async (k) => ({
        [k]: await encrypt((salaryBreakup?.[k] || 0).toString()),
      }))
    );
    const encryptedSalaryBreakup = Object.assign({}, ...encryptedSalaryFields);

    await Salaries.create({
      employee: employee._id,
      candidateName: await encrypt(sanitizeName(candidateName)),
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
    });

    const text = finalHtml.replace(/<[^>]+>/g, " ");
    await transporter.sendMail({
      from: `"${process.env.MAIL_FROM_NAME}" <${process.env.MAIL_FROM_ADDRESS}>`,
      to: candidateEmail,
      subject: finalSubject,
      text,
      html: finalHtml,
    });

    return res.json({ success: true });
  } catch (err) {
    console.error("Email send error:", err);
    return res.status(500).json({ error: "Failed to send offer letter." });
  }
}

module.exports = { sendOfferLetter };
