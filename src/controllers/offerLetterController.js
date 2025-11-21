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
  name: "Mavens",
  email: "HR@mavensadvisor.com",
  phone: "+92 312 3850846",
  website: "www.mavensadvisor.com",
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
  try {
    console.log("🔍 DEBUG: Fetching company profile for owner:", ownerId);
    
    const companyDoc = await CompanyProfile.findOne({ owner: ownerId })
      .select('name email website branches')
      .lean();

    console.log("🔍 DEBUG: Company Profile Found:", companyDoc);

    if (!companyDoc) {
      console.log("❌ No company profile found, using fallbacks");
      return FALLBACKS;
    }

    // --------------------- Find Documentation Branch ---------------------
    let documentationBranch = null;

    if (companyDoc.branches && companyDoc.branches.length > 0) {
      // 1. Try to find the branch marked for documentation
      documentationBranch = companyDoc.branches.find(
        (b) => b.useForDocumentation === true
      );

      // 2. If none found, use the FIRST branch as fallback
      if (!documentationBranch) {
        console.log("ℹ️ No documentation branch found, using first branch");
        documentationBranch = companyDoc.branches[0];
      }
    }

    // Extract data with FALLBACKS support
    const address = documentationBranch?.address || FALLBACKS.address;
    const phone   = documentationBranch?.phone   || FALLBACKS.phone;
    const email   = documentationBranch?.email   || companyDoc.email || FALLBACKS.email;

    console.log("🔍 DEBUG: Using documentation branch:", documentationBranch);

    const companyData = {
      name:    companyDoc.name    || FALLBACKS.name,
      email:   email,
      phone:   phone,
      website: companyDoc.website || FALLBACKS.website,
      address: address
    };

    console.log("🔍 DEBUG: Final company context:", companyData);
    return companyData;

  } catch (err) {
    console.error("❌ Error fetching company profile:", err);
    return FALLBACKS;
  }
}

/* ------------------------- Controller: Get Signature ---------------------- */
async function getSignature(req, res) {
  try {
    if (!req.user || !req.user._id) {
      return res.status(401).json({ error: "No user context found." });
    }

    const ownerId = req.user._id;
    console.log("🔍 DEBUG: Fetching signature for owner:", ownerId);

    const signature = await Signature.findOne({ owner: ownerId });

    if (!signature) {
      console.log("🔍 DEBUG: No signature found for owner:", ownerId);
      return res.status(404).json({ error: "Signature not found" });
    }

    console.log("🔍 DEBUG: Signature found:", {
      hasText: !!signature.signatureText,
      hasImage: !!signature.signatureImage,
      text: signature.signatureText ? "Present" : "Missing"
    });

    res.json({
      signatureText: signature.signatureText,
      signatureImage: signature.signatureImage,
      createdAt: signature.createdAt,
      updatedAt: signature.updatedAt
    });
  } catch (err) {
    console.error("Error fetching signature:", err);
    res.status(500).json({ error: "Failed to fetch signature" });
  }
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

/* -------------------- Robust template renderer --------------------------- */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function renderWithContext(tpl = "", ctx = {}) {
  let out = String(tpl || "");
  const keys = Object.keys(ctx).sort((a, b) => b.length - a.length);
  for (const k of keys) {
    const re = new RegExp(`{{\\s*${escapeRegExp(k)}\\s*}}`, "g");
    out = out.replace(re, String(ctx[k] ?? ""));
  }
  return out;
}

/* ------------------------ Build render context --------------------------- */
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

  console.log("🔍 DEBUG probationDays:", probationDays);
  console.log("🔍 DEBUG probationDaysNum:", probationDaysNum);

  const ctx = {
    candidateName: safeCandidateName,
    position,
    companyName: companyCtx.name,
    companyAddress: companyCtx.address,
    formattedStartDate,
    formattedDeadline,
    formattedTime,
    grossSalary,
    probationDays: probationDaysNum.toString(),
    signatureHtml: signatureBlock,
    signatureBlock: signatureBlock,
  };

  console.log("🔍 DEBUG final ctx.probationDays:", ctx.probationDays);
  console.log("🔍 DEBUG final ctx.signatureHtml:", ctx.signatureHtml ? "Present" : "Missing");

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
      letter: letterOverride,
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

    // Debug: Check if company profile exists
    console.log("🔍 DEBUG ownerId:", ownerId);
    const companyExists = await CompanyProfile.findOne({ owner: ownerId });
    console.log("🔍 DEBUG Company Profile exists:", !!companyExists);
    if (companyExists) {
      console.log("🔍 DEBUG Company Profile data:", companyExists);
    }

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

    // Render final subject + html (prefer client override)
    let finalSubject =
      subjectOverride || // This should already be rendered by frontend
      (tpl
        ? renderWithContext(tpl.subject || "", ctx)
        : `Offer of Employment – ${position} at ${companyCtx.name}`);
    
    let finalHtml = letterOverride;

    // If no letter override provided, use template or default
    if (!finalHtml) {
      finalHtml = tpl
        ? renderWithContext(tpl.html || "", ctx)
        : `
      <div style="font-family: Arial, sans-serif; line-height:1.7;">
        <p>Dear <b>${safeCandidateName}</b>,</p>
        <p>We're thrilled to have you on board!</p>
        <p>It gives us great pleasure to officially offer you the position of <b>${position}</b> at <b>${companyCtx.name}</b>.</p>
        {{signatureHtml}}
      </div>
    `.trim();

      // Only add signature if using template/default AND signatureHtml placeholder exists
      if (finalHtml.includes('{{signatureHtml}}')) {
        finalHtml = finalHtml.replace('{{signatureHtml}}', ctx.signatureHtml || signatureBlock);
      }
    }

    // IMPORTANT: DO NOT automatically add signature if letterOverride is provided
    // The frontend is responsible for including the signature in the letterOverride

    finalHtml = enforceImgCss(enforceComicSans(finalHtml));

    // Debug: Log the final subject and HTML
    console.log("🔍 DEBUG Final Subject:", finalSubject);
    console.log("🔍 DEBUG Final HTML length:", finalHtml.length);
    console.log("🔍 DEBUG Using letter override:", !!letterOverride);

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
    
    // Debug: Log email sending details
    console.log("🔍 DEBUG Sending email to:", candidateEmail);
    console.log("🔍 DEBUG Email subject:", finalSubject);
    
    await transporter.sendMail({
      from: `"${process.env.MAIL_FROM_NAME}" <${process.env.MAIL_FROM_ADDRESS}>`,
      to: candidateEmail,
      subject: finalSubject,
      text,
      html: finalHtml,
    });

    console.log("✅ Email sent successfully to:", candidateEmail);

    return res.json({ success: true });
  } catch (err) {
    console.error("Email send error:", err);
    return res.status(500).json({ error: "Failed to send offer letter." });
  }
}

module.exports = { 
  sendOfferLetter,
  getSignature 
};