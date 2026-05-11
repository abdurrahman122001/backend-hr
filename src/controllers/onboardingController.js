// controllers/onboardingController.js
require("dotenv").config();
const Employee = require("../models/Employees");
const Salaries = require("../models/Salaries");
const CompanyProfile = require("../models/CompanyProfile"); // <-- fetch company name from here
const { sendEmail } = require("../services/mailService");
const { encrypt } = require("../utils/encryption");
const Signature = require("../models/Signature");
const { removeSignatureParagraphMargins } = require("../utils/removeSignatureParagraphMargins");

// ENV fallbacks (used only if CompanyProfile has no name)
const COMPANY_NAME_FALLBACK = process.env.COMPANY_NAME || "Mavens Advisors";
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
  "overtimeComp", // keep in sync with the rest of backend
  "dislocationAllowance",
  "leaveEncashment",
  "bonus",
  "arrears",
  "autoAllowance",
  "incentive",
  "fuelAllowance",
  "othersAllowances",
];

// Normalize a time string to HH:mm (zero-padded 24h)
function normalizeTime(timeStr) {
  if (!timeStr || typeof timeStr !== "string") return "";
  const [hRaw = "", mRaw = ""] = timeStr.split(":");
  const h = String(hRaw).padStart(2, "0");
  const m = String(mRaw).padStart(2, "0");
  return `${h}:${m}`;
}

// --- Helper: Force Comic Sans + margin:0 on <p style="font-size: 15px;line-height: 18px;"> (safe, no duplicate style attrs) ---
function enforceComicSans(html) {
  const family =
    "font-family: Arial, Helvetica, sans-serif;";
  const pRequired = `margin:0 !important; ${family}`;

  // 1) <p style="font-size: 15px;line-height: 18px;"> tags — ensure margin:0 !important + Comic Sans, without duplicate style=""
  html = html.replace(/<p\b([^>]*)>/gi, (full, attrs) => {
    if (/style\s*=/.test(attrs)) {
      // rewrite existing style: remove margin* and font-family, then prepend ours
      const newAttrs = attrs.replace(/style\s*=\s*"([^"]*)"/i, (_m, style) => {
        let cleaned = style
          .replace(/(^|;)\s*margin[^;]*;?/gi, "")
          .replace(/(^|;)\s*font-family\s*:[^;]*;?/gi, "")
          .replace(/;;+/g, ";")
          .replace(/^\s*;|;\s*$/g, "");
        return `style="${pRequired}${cleaned ? "; " + cleaned : ""}"`;
      });
      return `<p${newAttrs}>`;
    }
    // no style attribute -> inject one
    return `<p style="${pRequired}"${attrs}>`;
  });

  // 2) Other blocks (ul/ol/li/div) — apply Comic Sans, keep their margins intact
  const tags = ["ul", "ol", "li", "div"];
  for (const tag of tags) {
    // if style exists: strip any font-family and prepend ours
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
    // if no style exists: add one
    html = html.replace(
      new RegExp(`<${tag}\\b(?![^>]*\\bstyle=)([^>]*)>`, "gi"),
      `<${tag} style="${family}"$1>`
    );
  }

  return html;
}

// --- Helper: Enforce <img> CSS everywhere ---
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

module.exports = {
  async requestCnicAndCv(req, res) {
    try {
      const {
        candidateName,
        candidateEmail,
        position,
        department,
        startDate,
        reportingTime,
        salaryBreakup = {},
        shift,      // may be a string (single shift id)
        shifts = [], // may be array (future)
      } = req.body;

      if (
        !candidateName ||
        !candidateEmail ||
        !position ||
        !department ||
        !startDate ||
        !reportingTime
      ) {
        return res.status(400).json({ error: "Missing required fields." });
      }

      if (!req.user || !req.user._id) {
        return res.status(401).json({ error: "Unauthorized: owner not found" });
      }
      const ownerId = req.user._id;

      // Pull company name from CompanyProfile (fallback to env)
      const companyDoc = await CompanyProfile
        .findOne({ owner: ownerId }, { name: 1 })
        .lean();
      const COMPANY_NAME = (companyDoc?.name || "").trim() || COMPANY_NAME_FALLBACK;

      // ---- SHIFT HANDLING: always use an array ----
      let shiftArr = [];
      if (shift && typeof shift === "string" && shift.trim() !== "") {
        shiftArr = [shift];
      } else if (Array.isArray(shifts) && shifts.length > 0) {
        shiftArr = shifts;
      } else {
        shiftArr = ["6849ac46fa83715da425e2b5"];
      }

      // Normalize reporting time (store as HH:mm) and map to Employee.rt
      const normalizedRT = normalizeTime(reportingTime);

      // --- Encrypt salary fields ---
      const encryptedSalary = {};
      for (let field of SALARY_COMPONENTS) {
        const value = salaryBreakup[field] || 0;
        encryptedSalary[field] = await encrypt(String(value));
      }

      // Calculate gross salary and encrypt
      let grossSalaryRaw = 0;
      for (let field of SALARY_COMPONENTS) {
        const val = salaryBreakup[field] || 0;
        grossSalaryRaw += Number(val || 0);
      }
      const encryptedGrossSalary = await encrypt(String(grossSalaryRaw));

      // Save/update employee
      const employee = await Employee.findOneAndUpdate(
        { email: candidateEmail },
        {
          owner: ownerId,                 // schema expects a single ObjectId
          name: candidateName,
          email: candidateEmail,
          designation: position,
          department,
          joiningDate: startDate,
          rt: normalizedRT,               // <-- SAVE TO 'rt' FIELD HERE
          salaryBreakup: salaryBreakup,   // (if you store this ad-hoc view)
          shifts: shiftArr,
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );

      // Month/Year for salary entry
      const baseDate = startDate ? new Date(startDate) : new Date();
      const monthName = baseDate.toLocaleString("en-US", { month: "long" });
      const year = baseDate.getFullYear().toString();

      // Create salary record
      const slipData = {
        employee: employee._id,
        candidateName: await encrypt(candidateName),
        candidateEmail: await encrypt(candidateEmail),
        position: await encrypt(position),
        department: await encrypt(department),
        startDate: await encrypt(startDate),
        reportingTime: await encrypt(normalizedRT), // store normalized time
        shifts: shiftArr,
        ...encryptedSalary,
        grossSalary: encryptedGrossSalary,
        month: monthName,
        year,
        owner: ownerId,
        createdBy: ownerId,
      };
      await Salaries.create(slipData);

      // Signature (if available)
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
              ${removeSignatureParagraphMargins(signature.signatureText || "")}
            </div>
          </div>
        `;
      }

      // --- EMAIL HTML ---
      const subject =
        "Hello from Your New HR AI Agent – Let's Get You Officially Onboarded!";

      let html = `
        <div style="font-family: Arial, Helvetica, sans-serif; font-size: 15px; color: #212121; text-align: left; margin:0; padding:0">
          <p style="font-size: 15px;line-height: 18px;">Dear <strong>${candidateName}</strong>,</p>
          <br>
          <p style="font-size: 15px;line-height: 18px;">Welcome to the beginning of something amazing!</p>
          <br>
          <p style="font-size: 15px;line-height: 18px;">I'm your new HR AI Agent here to make your onboarding experience smooth, seamless, and just a little more exciting!</p>
          <br>
          <p style="font-size: 15px;line-height: 18px;">While I might be powered by algorithms and data, my goal is simple: to help you feel connected, supported, and ready to thrive at <strong>${COMPANY_NAME}</strong>.</p>
          <br>
          <p style="font-size: 15px;line-height: 18px;">As the first step to complete your profile, please reply with the following documents:</p>
          <ul style="margin:2em 0;padding:0;">
            <li style="margin-bottom:4px;"><strong>Copy of your CNIC</strong> (front & back, JPG or PNG format)</li>
            <li style="margin-bottom:4px;"><strong>Your latest CV/Resume</strong> (PDF)</li>
          </ul>
          <p style="font-size: 15px;line-height: 18px;"><em>Your data is safe with me – always encrypted, confidential, and used only to make your experience better.</em></p>
          <br>
          <p style="font-size: 15px;line-height: 18px;">The sooner I get your info, the sooner I can start helping you settle in, track your progress, and celebrate your milestones!</p>
          <br>
          <p style="font-size: 15px;line-height: 18px;">If you have any questions or feel stuck, I'm just a message away.</p>
          <br>
          <p style="font-size: 15px;line-height: 18px;">Can't wait to be part of your journey at <strong>${COMPANY_NAME}</strong>!</p>
          ${signatureBlock}
        </div>
      `;

      // Enforce styles
      html = enforceComicSans(html);
      html = enforceImgCss(html);

      // Send email with explicit From header
      await sendEmail({
        from: `"${process.env.MAIL_FROM_NAME}" <${process.env.MAIL_FROM_ADDRESS}>`,
        to: candidateEmail,
        subject,
        html,
      });

      return res.json({
        success: true,
        message: "Request sent for CNIC and CV.",
      });
    } catch (err) {
      console.error("Error requesting CNIC & CV:", err);
      return res.status(500).json({ error: "Failed to send CNIC/CV request." });
    }
  },
};
