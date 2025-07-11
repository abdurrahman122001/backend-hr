const express = require("express");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const Employee = require("../models/Employees");
const sendEmail = require("../services/mailService").sendEmail;
const multer = require("multer");
const path = require("path");
const fs = require("fs");

const router = express.Router();

const FRONTEND_BASE_URL =
  process.env.FRONTEND_BASE_URL || "http://localhost:5173"; // or your deployed URL

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

// --- PUT: Update all fields, send "Set Password" email if needed ---
router.put(
  "/:id/complete",
  upload.fields([
    { name: "photograph", maxCount: 1 },
    { name: "cv", maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      const { id } = req.params;
      const emp = await Employee.findById(id);
      if (!emp)
        return res
          .status(404)
          .json({ success: false, error: "Employee not found" });

      // Assign uploaded files (if present)
      if (req.files?.photograph?.[0]) {
        emp.photographUrl = `/uploads/photos/${req.files.photograph[0].filename}`;
      }
      if (req.files?.cv?.[0]) {
        emp.cvUrl = `/uploads/cv/${req.files.cv[0].filename}`;
      }

      // Parse date fields and update fields
      const dateFields = [
        "dateOfBirth",
        "cnicIssueDate",
        "cnicExpiryDate",
        "joiningDate",
      ];
      allFields.forEach((field) => {
        if (req.body[field] !== undefined && req.body[field] !== null) {
          if (dateFields.includes(field) && req.body[field]) {
            emp[field] = req.body[field]; // Save as string to match your schema
          } else {
            emp[field] = req.body[field];
          }
        }
      });

      // Ensure owner is an array (match your schema)
      if (!emp.owner) emp.owner = ["6838b0b708e8629ffab534ee"];

      await emp.save();

      // -- SEND SET PASSWORD EMAIL IF password is NOT set --
      if (!emp.password) {
        const token = crypto.randomBytes(32).toString("hex");
        const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
        emp.setPasswordToken = token;
        emp.setPasswordTokenExpires = expires;
        await emp.save();

        const setPasswordUrl = `${FRONTEND_BASE_URL}/set-password?token=${token}&id=${emp._id}`;
        const html = `
          <div style="font-family:'Comic Sans MS',Comic Sans,cursive,Arial,sans-serif;max-width:600px;margin:0 auto;color:#222;font-size:17px;line-height:1.75;">
            <p>Dear <strong>${emp.name || "Employee"}</strong>,</p>
            <p>
              Thank you for completing your employee profile.<br>
              To secure your account and access the HR portal, please set your password by clicking the link below.
            </p>
            <p style="margin:28px 0;">
              <a href="${setPasswordUrl}" style="background:#0057b7;color:#fff;text-decoration:none;font-weight:bold;padding:14px 30px;border-radius:6px;display:inline-block;font-size:18px;letter-spacing:.3px;">
                Set My Password
              </a>
            </p>
            <p>
              This link will expire in <strong>2 hours</strong> for your security.<br>
              If you did not request this, you can safely ignore this message.
            </p>
            <br>
            <div style="margin-top:18px;font-size:15px;">
              Kind regards,<br>
              <span style="font-weight:bold;">Your HR AI Agent 🤖</span><br>
              <span style="font-style:italic;font-size:15px;">Mavens Advisors</span>
            </div>
            <div style="background:#f4f4f4;border-radius:7px;font-family:monospace;font-size:13px;color:#333;white-space:pre;padding:18px 12px;margin-top:28px;overflow-x:auto;">
*********************************************************************************
The information contained in this email (including any attachments) is intended only for the personal and confidential use of the recipient(s) named above. If you are not an intended recipient, please notify the sender by replying and then delete this message from your system. Any use, dissemination, or reproduction of this message by unintended recipients is not authorized and may be unlawful.
*********************************************************************************
            </div>
          </div>
        `;

        await sendEmail({
          to: emp.email,
          subject: "Set Your Password – Mavens Advisors HR Portal",
          html,
        });
      }

      return res.json({ success: true, data: { _id: emp._id.toString() } });
    } catch (err) {
      console.error(
        "❌ PUT /api/employee/:id/complete error:",
        err,
        err?.stack
      );
      return res
        .status(500)
        .json({ success: false, error: err?.message || "Server error" });
    }
  }
);

// --- PUBLIC POST: Set Password ---
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
