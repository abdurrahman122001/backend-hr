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
const verifyEmail = require("../utils/verifyEmail");

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
    const companyDoc = await CompanyProfile.findOne({ owner: ownerId })
      .select("name email website branches")
      .lean();

    if (!companyDoc) {
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
        documentationBranch = companyDoc.branches[0];
      }
    }

    // Extract data with FALLBACKS support
    const address = documentationBranch?.address || FALLBACKS.address;
    const phone = documentationBranch?.phone || FALLBACKS.phone;
    const email =
      documentationBranch?.email || companyDoc.email || FALLBACKS.email;

    const companyData = {
      name: companyDoc.name || FALLBACKS.name,
      email: email,
      phone: phone,
      website: companyDoc.website || FALLBACKS.website,
      address: address,
    };
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

    const signature = await Signature.findOne({ owner: ownerId });

    if (!signature) {
      return res.status(404).json({ error: "Signature not found" });
    }
    res.json({
      signatureText: signature.signatureText,
      signatureImage: signature.signatureImage,
      createdAt: signature.createdAt,
      updatedAt: signature.updatedAt,
    });
  } catch (err) {
    console.error("Error fetching signature:", err);
    res.status(500).json({ error: "Failed to fetch signature" });
  }
}

/* ----------------------------- Helper: Styles ----------------------------- */
function enforceComicSans(html) {
  const family =
    "font-family: Arial, Helvetica, sans-serif; font-size: 16px; color: #000000;";
  const pRequired = [
    "margin:0 !important",
    "margin-block-start:0",
    "margin-block-end:0",
    "mso-margin-top-alt:0",
    "mso-margin-bottom-alt:0",
    "mso-line-height-rule:exactly",
    family,
  ].join("; ");

  // Replace all <p> tags with proper styling
  html = html.replace(/<p\b([^>]*)>/gi, (full, attrs) => {
    if (/style\s*=/.test(attrs)) {
      const newAttrs = attrs.replace(/style\s*=\s*"([^"]*)"/i, (_m, style) => {
        let cleaned = style
          .replace(/(^|;)\s*margin[^;]*;?/gi, "")
          .replace(/(^|;)\s*margin-block-(start|end)\s*:[^;]*;?/gi, "")
          .replace(/(^|;)\s*font-family\s*:[^;]*;?/gi, "")
          .replace(/(^|;)\s*color\s*:[^;]*;?/gi, "")
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

  // Add font family and color to other elements
  const addFamily = (tag) => {
    html = html.replace(
      new RegExp(`<${tag}\\b([^>]*)style="([^"]*)"([^>]*)>`, "gi"),
      (full, pre, style, post) => {
        const cleaned = style
          .replace(/(^|;)\s*font-family\s*:[^;]*;?/gi, "")
          .replace(/(^|;)\s*color\s*:[^;]*;?/gi, "")
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

  // Add font family and color to span elements specifically
  html = html.replace(
    /<span\b([^>]*)style="([^"]*)"([^>]*)>/gi,
    (full, pre, style, post) => {
      const cleaned = style
        .replace(/(^|;)\s*font-family\s*:[^;]*;?/gi, "")
        .replace(/(^|;)\s*color\s*:[^;]*;?/gi, "")
        .replace(/;;+/g, ";")
        .replace(/^\s*;|;\s*$/g, "");
      return `<span${pre}style="${family}${
        cleaned ? " " + cleaned : ""
      }"${post}>`;
    }
  );

  html = html.replace(
    /<span\b(?![^>]*\bstyle=)([^>]*)>/gi,
    `<span style="${family}"$1>`
  );

  ["ul", "ol", "li", "div", "td", "th"].forEach(addFamily);

  // Ensure body has black text
  html = html.replace(
    /<body\b([^>]*)>/gi,
    `<body style="color: #000000; font-family: Arial, Helvetica, sans-serif;"$1>`
  );

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

/* ----------------------- Remove Blue Variable Styling --------------------- */
function removeBlueVariableStyling(html) {
  // Remove variable-blue class and inline blue styling
  html = html.replace(/class="variable-blue"/gi, "");
  html = html.replace(/class='variable-blue'/gi, "");

  // Remove inline blue color styles
  html = html.replace(/style="[^"]*color:\s*#2563eb[^"]*"/gi, (match) => {
    // Remove only the color property from the style attribute
    return match
      .replace(/color:\s*#2563eb;?\s*/gi, "")
      .replace(/background[^;]*#dbeafe[^;]*;?\s*/gi, "")
      .replace(/border[^;]*#3b82f6[^;]*;?\s*/gi, "")
      .replace(/;\s*"/, '"')
      .replace(/\s*"\s*$/, '"')
      .replace(/style="\s*"/, "");
  });

  // Remove any remaining blue color declarations
  html = html.replace(/color:\s*#2563eb;?/gi, "");
  html = html.replace(/background[^;]*#dbeafe[^;]*;?/gi, "");
  html = html.replace(/border[^;]*#3b82f6[^;]*;?/gi, "");

  // Clean up empty style attributes
  html = html.replace(/style="\s*"/g, "");
  html = html.replace(/style='\s*'/g, "");
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
    <div style="color: #000000;">
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
      <div style="text-align:left; color: #000000;">${
        signature.signatureText || ""
      }</div>
    </div>
  `
    : "";

  const probationDaysNum = Number(probationDays) || 0;
  const ctx = {
    candidateName: safeCandidateName,
    position,
    department: department || "Not specified", // Added department variable
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

  return {
    ctx,
    companyCtx,
    signatureBlock,
    safeCandidateName,
    grossSalaryRaw,
  };
}
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

    const exists = await Employee.findOne({ email: candidateEmail });
    if (exists) {
      return res.status(400).json({
        error: "An employee with this email already exists. Offer not sent.",
      });
    }

    /* ---------------------------------------------------------
     * ⭐ ZEROBOUNCE EMAIL VERIFICATION (with IP bypass fix)
     * --------------------------------------------------------- */
    const isValidEmail = await verifyEmail(candidateEmail);

    if (!isValidEmail) {
      return res.status(400).json({
        error:
          "The provided email address is invalid or undeliverable. Email sending has been blocked.",
      });
    }
    /* --------------------------------------------------------- */

    // Build template context
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

    // Render subject
    let finalSubject =
      subjectOverride ||
      (tpl
        ? renderWithContext(tpl.subject || "", ctx)
        : `Offer of Employment – ${position} at ${companyCtx.name}`);

    // Render letter
    let finalHtml = letterOverride;

    if (!finalHtml) {
      finalHtml = tpl
        ? renderWithContext(tpl.html || "", ctx)
        : `
          <div style="font-family: Arial, sans-serif; line-height:1.7; color: #000000;">
            <p>Dear <b>${safeCandidateName}</b>,</p>
            <p>We're thrilled to have you on board!</p>
            <p>It gives us great pleasure to officially offer you the position of <b>${position}</b>
            in the <b>${department || "relevant"}</b> department at <b>${companyCtx.name}</b>.</p>
            {{signatureHtml}}
          </div>
        `.trim();

      if (finalHtml.includes("{{signatureHtml}}")) {
        finalHtml = finalHtml.replace(
          "{{signatureHtml}}",
          ctx.signatureHtml || signatureBlock
        );
      }
    }

    // Clean styling + enforce email-safe layout
    finalHtml = removeBlueVariableStyling(finalHtml);
    finalHtml = enforceImgCss(enforceComicSans(finalHtml));

    // Save generated email
    await OfferEmailGenerated.create({
      owner: ownerId,
      key,
      candidateEmail,
      subject: finalSubject,
      html: finalHtml,
      context: ctx,
    });

    /* ---------------------------------------------------------
     * ➕ CREATE EMPLOYEE
     * --------------------------------------------------------- */
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
      status: "Offered",
      rt: normalizedRT,
      shifts: shift ? [shift] : undefined,
      ...(probationDaysNum > 0
        ? { leaveEntitlement: { total: 0, usedPaid: 0, usedUnpaid: 0 } }
        : {}),
    });

    /* ---------------------------------------------------------
     * ⭐ FIX: Auto-generate month & year required in Salaries
     * --------------------------------------------------------- */
    const jsDate = new Date(startDate);
    const month = String(jsDate.getMonth() + 1).padStart(2, "0");
    const year = String(jsDate.getFullYear());

    /* ---------------------------------------------------------
     * ➕ CREATE SALARY RECORD
     * --------------------------------------------------------- */
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
      month, // ⭐ REQUIRED FIELD ADDED
      year,  // ⭐ REQUIRED FIELD ADDED
      ...encryptedSalaryBreakup,
      probationDays: await encrypt(probationDaysNum.toString()),
    });

    /* ---------------------------------------------------------
     * SEND EMAIL
     * --------------------------------------------------------- */
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


/* ------------------------- Controller: Preview Email ---------------------- */
async function previewOfferLetter(req, res) {
  try {
    const {
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

    if (!req.user || !req.user._id) {
      return res.status(401).json({ error: "No user context found." });
    }

    const ownerId = req.user._id;

    const { ctx, companyCtx, signatureBlock } = await buildContext({
      ownerId,
      candidateName,
      candidateEmail: "preview@example.com",
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

    // Render final subject + html
    let finalSubject =
      subjectOverride ||
      (tpl
        ? renderWithContext(tpl.subject || "", ctx)
        : `Offer of Employment – ${position} at ${companyCtx.name}`);

    let finalHtml = letterOverride;

    if (!finalHtml) {
      finalHtml = tpl
        ? renderWithContext(tpl.html || "", ctx)
        : `
      <div style="font-family: Arial, sans-serif; line-height:1.7; color: #000000;">
        <p>Dear <b>${sanitizeName(candidateName)}</b>,</p>
        <p>We're thrilled to have you on board!</p>
        <p>It gives us great pleasure to officially offer you the position of <b>${position}</b> in the <b>${
            department || "relevant"
          }</b> department at <b>${companyCtx.name}</b>.</p>
        {{signatureHtml}}
      </div>
    `.trim();

      if (finalHtml.includes("{{signatureHtml}}")) {
        finalHtml = finalHtml.replace(
          "{{signatureHtml}}",
          ctx.signatureHtml || signatureBlock
        );
      }
    }

    // Apply CSS enforcement for preview as well
    finalHtml = enforceImgCss(enforceComicSans(finalHtml));

    res.json({
      subject: finalSubject,
      html: finalHtml,
      context: ctx,
    });
  } catch (err) {
    console.error("Preview error:", err);
    res.status(500).json({ error: "Failed to generate preview" });
  }
}

module.exports = {
  sendOfferLetter,
  getSignature,
  previewOfferLetter,
};
