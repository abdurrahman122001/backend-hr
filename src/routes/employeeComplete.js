const express = require("express");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const Employee = require("../models/Employees");
const Signature = require("../models/Signature");
const sendEmail = require("../services/mailService").sendEmail;
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { removeSignatureParagraphMargins } = require("../utils/removeSignatureParagraphMargins");

// --- Company Info ---
const COMPANY_NAME = process.env.COMPANY_NAME || "Mavens Advisors";
const COMPANY_EMAIL = process.env.COMPANY_EMAIL || "HR@mavensadvisor.com";
const COMPANY_CONTACT = process.env.COMPANY_CONTACT || "+92 312 3850846";
const COMPANY_WEBSITE = process.env.COMPANY_WEBSITE || "www.mavensadvisor.com";

const FRONTEND_BASE_URL =
  process.env.FRONTEND_BASE_URL || "http://localhost:5173";
const APP_URL = process.env.APP_URL || "http://localhost:3000";

// --- Ensure upload folders exist ---
const ensureDir = (dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
};
const photosDir = path.join(__dirname, "../uploads/photos");
const cvDir = path.join(__dirname, "../uploads/cv");
const otherDir = path.join(__dirname, "../uploads/other");
ensureDir(photosDir);
ensureDir(cvDir);
ensureDir(otherDir);

// --- Multer storage setup ---
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (file.fieldname === "photograph") cb(null, photosDir);
    else if (file.fieldname === "cv") cb(null, cvDir);
    else cb(null, otherDir);
  },
  filename: (req, file, cb) => {
    cb(
      null,
      file.fieldname + "-" + Date.now() + path.extname(file.originalname)
    );
  },
});
const upload = multer({ storage });

// --- All Employee fields ---
const allFields = [
  "name",
  "email",
  "fatherOrHusbandName",
  "cnic",
  "dateOfBirth",
  "gender",
  "nationality",
  "maritalStatus",
  "religion",
  "cnicIssueDate",
  "cnicExpiryDate",
  "photographUrl",
  "cvUrl",
  "latestQualification",
  "fieldOfQualification",
  "phone",
  "companyEmail",
  "permanentAddress",
  "presentAddress",
  "bankName",
  "bankAccountNumber",
  "nomineeName",
  "nomineeCnic",
  "nomineeRelation",
  "nomineeNo",
  "emergencyContactName",
  "emergencyContactRelation",
  "emergencyContactNumber",
  "emergencyNo",
  "department",
  "designation",
  "joiningDate",
  "rt",
];

// --- Comic Sans everywhere except disclaimer block ---
function enforceComicSans(html) {
  const fontStyle = "font-family: Arial, Helvetica, sans-serif;";

  // For <p> tags — preserve existing styles, only inject font-family if not present
  html = html.replace(/<p\b([^>]*)>/gi, (match, attrs) => {
    if (/style\s*=/i.test(attrs)) {
      return match.replace(
        /style\s*=\s*["']([^"']*)["']/i,
        (_, existing) => `style="font-family:Arial,Helvetica,sans-serif; ${existing}"`
      );
    }
    return `<p style="font-family:Arial,Helvetica,sans-serif; font-size:15px; line-height:1.7;" ${attrs}>`;
  });

  // For other tags — same approach
  ["ul", "ol", "li", "div"].forEach(tag => {
    html = html.replace(new RegExp(`<${tag}\\b([^>]*)>`, "gi"), (match, attrs) => {
      if (/style\s*=/i.test(attrs)) {
        return match.replace(
          /style\s*=\s*["']([^"']*)["']/i,
          (_, existing) => `style="font-family:Arial,Helvetica,sans-serif; ${existing}"`
        );
      }
      return `<${tag} style="${fontStyle}" ${attrs}>`;
    });
  });

  return html;
}
// --- Enforce <img> CSS everywhere ---
function enforceImgCss(html) {
  html = html.replace(/<img([^>]*?)style="[^"]*"/g, `<img$1`);
  html = html.replace(
    /<img([^>]*?)\/?>/g,
    `<img$1 style="height:200px;width:200px;object-fit:contain;display:inline-block;vertical-align:middle;max-width:200px;max-height:200px;" />`
  );
  return html;
}

// --- ROUTER SETUP ---
const router = express.Router();

// --- GET: Fetch all fields ---
router.get("/:id/complete", async (req, res) => {
  try {
    const { id } = req.params;
    const selectFields = allFields.join(" ");
    const emp = await Employee.findById(id).select(selectFields);
    if (!emp)
      return res
        .status(404)
        .json({ success: false, error: "Employee not found" });
    const data = { _id: emp._id.toString() };
    allFields.forEach((field) => {
      data[field] =
        emp[field] !== undefined && emp[field] !== null ? emp[field] : "";
    });
    return res.json({ success: true, data });
  } catch (err) {
    console.error("❌ GET /api/employee/:id/complete error:", err);
    return res
      .status(500)
      .json({ success: false, error: err?.message || "Server error" });
  }
});

// --- PUT: Update all fields, send Set Password email with offer letter layout ---
router.put(
  "/:id/complete",
  upload.fields([
    { name: "photograph", maxCount: 1 },
    { name: "photographFile", maxCount: 1 },
    { name: "cv", maxCount: 1 },
    { name: "resume", maxCount: 1 },
    { name: "resumeFile", maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      console.log("PUT /employee/:id/complete received files:", Object.keys(req.files || {}));
      const { id } = req.params;
      const emp = await Employee.findById(id);
      if (!emp)
        return res
          .status(404)
          .json({ success: false, error: "Employee not found" });

      // Assign uploaded files (if present)
      if (req.files?.photograph?.[0] || req.files?.photographFile?.[0]) {
        const photoFile = req.files.photograph?.[0] || req.files.photographFile?.[0];
        emp.photographUrl = `/uploads/photos/${photoFile.filename}`;
      }
      if (req.files?.cv?.[0] || req.files?.resume?.[0] || req.files?.resumeFile?.[0]) {
        const cvFile = req.files.cv?.[0] || req.files.resume?.[0] || req.files.resumeFile?.[0];
        emp.cvUrl = `/uploads/cv/${cvFile.filename}`;
      }

      // Parse and update all non-file fields (do NOT touch owner)
      const dateFields = [
        "dateOfBirth",
        "cnicIssueDate",
        "cnicExpiryDate",
        "joiningDate",
      ];
      allFields.forEach((field) => {
        if (field === "photographUrl" || field === "cvUrl") return; // handled above
        if (field === "owner") return; // ❌ don't update owner here
        if (req.body[field] !== undefined && req.body[field] !== null) {
          if (dateFields.includes(field) && req.body[field]) {
            emp[field] = req.body[field];
          } else {
            emp[field] = req.body[field];
          }
        }
      });

      await emp.save();

      // -- SEND SET PASSWORD EMAIL IF password is NOT set --
      if (!emp.password) {
        const token = crypto.randomBytes(32).toString("hex");
        const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
        emp.setPasswordToken = token;
        emp.setPasswordTokenExpires = expires;
        await emp.save();

        const setPasswordUrl = `${APP_URL}/set-password?token=${token}&id=${emp._id}`;

        // Use existing owner only; do NOT set or modify it
        const ownerId = Array.isArray(emp.owner) ? emp.owner[0] : emp.owner;

        let signatureBlock = "";
        if (ownerId) {
          const signatureDoc = await Signature.findOne({ owner: ownerId });
          if (signatureDoc) {
            const server = process.env.SERVER_URL || "";
            const imgHtml = signatureDoc.signatureImage
              ? `<img src="${server}${signatureDoc.signatureImage}" alt="Signature" style="height:70px;display:block;margin-bottom:6px;object-fit:contain;max-width:200px;" />`
              : "";
            signatureBlock = `
              <div style="margin-top:32px;margin-bottom:12px;">
                ${imgHtml}
                <div style="text-align:left; font-size:15px; line-height:1.7;">
                  ${removeSignatureParagraphMargins(signatureDoc.signatureText || "")}
                </div>
              </div>
            `;
          }
        }

        // --- PIXEL-PERFECT OFFER LETTER LAYOUT ---
        let html = `
          <div style="font-family:'Comic Sans MS',Comic Sans,cursive,Arial,sans-serif;font-size:16px;color:#22223B;background:#f9fafb;line-height:2.1;text-align:left;margin:0;padding:40px 30px 38px 30px;max-width:100%;border-radius:15px;border:1.5px solid #e0e0e0;">
            <p style="margin-bottom:20px; font-size:15px; line-height:1.7;">
              Dear <strong>${emp.name || "Employee"}</strong>,
            </p>
            <p style=" font-size:15px; line-height:1.7;">
              Thank you for completing your employee profile.<br/>
              To secure your account and access the HR portal, please set your password by clicking the link below.
            </p>
            <div style="margin:30px 0 24px 0;">
              <a href="${setPasswordUrl}"
                 style="background:#0057b7;color:#fff;text-decoration:none;font-weight:bold;padding:12px 30px;border-radius:7px;display:inline-block;font-size:14px;letter-spacing:.4px;box-shadow:0 2px 12px #0057b730;">
                Set My Password
              </a>
            </div>
            <p style=" font-size:15px; line-height:1.7;">
              This link will expire in <strong>7 days</strong> for your security.<br/>
              If you did not request this, you can safely ignore this message.
            </p>
            ${signatureBlock}
          </div>
        `;

        // Enforce Comic Sans and <img> styling
        html = enforceComicSans(html);
        html = enforceImgCss(html);

        await sendEmail({
          to: emp.email,
          subject: "Set Your Password – Mavens Advisors HR Portal",
          html,
        });
      }

      return res.json({ success: true, data: { _id: emp._id.toString() } });
    } catch (err) {
      console.error("❌ PUT /api/employee/:id/complete error:", err, err?.stack);
      return res
        .status(500)
        .json({ success: false, error: err?.message || "Server error" });
    }
  }
);
// --- PUBLIC PUT: Set Password ---
router.put("/set-password", async (req, res) => {
  try {
    const { id, token, password } = req.body;
    if (!id || !token || !password)
      return res.status(400).json({ error: "Missing required fields." });

    // Find employee by ID
    const emp = await Employee.findById(id);
    if (!emp) return res.status(404).json({ error: "Employee not found." });

    // Check token & expiry
    if (
      !emp.setPasswordToken ||
      !emp.setPasswordTokenExpires ||
      emp.setPasswordToken !== token ||
      new Date(emp.setPasswordTokenExpires) < new Date()
    ) {
      return res
        .status(400)
        .json({ error: "Invalid or expired set password link." });
    }

    // Hash password and update
    const hash = await bcrypt.hash(password, 10);
    emp.password = hash;
    emp.status = "review";   // <--- Added line
    // Clear the token for security
    emp.setPasswordToken = undefined;
    emp.setPasswordTokenExpires = undefined;
    await emp.save();

    return res.json({ success: true, message: "Password set successfully." });
  } catch (err) {
    console.error("Set password error:", err, err?.stack);
    res.status(500).json({ error: "Server error. Try again." });
  }
});

module.exports = router;
