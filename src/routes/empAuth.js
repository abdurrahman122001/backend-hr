const express = require("express");
const jwt = require("jsonwebtoken");
const nodemailer = require("nodemailer");
const Employee = require("../models/Employees");
const requireAuth = require("../middleware/empAuth");
const authCtrl = require("../controllers/empAuthController");

const router = express.Router();

const {
  JWT_SECRET,
  MAIL_HOST,
  MAIL_PORT,
  MAIL_USERNAME,
  MAIL_PASSWORD,
  MAIL_FROM_ADDRESS,
  MAIL_FROM_NAME,
  MAIL_ENCRYPTION, // "ssl" for 465 in your env
} = process.env;

// ---------------------
// Email Transport
// ---------------------
const secure =
  String(MAIL_ENCRYPTION).toLowerCase() === "ssl" || Number(MAIL_PORT) === 465;

const transporter = nodemailer.createTransport({
  host: MAIL_HOST,
  port: Number(MAIL_PORT),
  secure,
  auth: {
    user: MAIL_USERNAME,
    pass: MAIL_PASSWORD,
  },
  tls: {
    rejectUnauthorized: false, // Titan SMTP fix
  },
});

// Helper: send email
async function sendMail({ to, subject, text, html }) {
  const from =
    MAIL_FROM_NAME && MAIL_FROM_ADDRESS
      ? `"${MAIL_FROM_NAME}" <${MAIL_FROM_ADDRESS}>`
      : MAIL_FROM_ADDRESS || MAIL_USERNAME;

  return transporter.sendMail({
    from,
    to,
    subject,
    text,
    html,
  });
}

// ---------------------
// Temporary code store
// ---------------------
const codes = new Map(); // codes.set(empId, { code, expires, deviceFingerprint })

// ---------------------
// LOGIN — verify password, check trusted device
// ---------------------
router.post("/login", async (req, res) => {
  const { companyEmail, password, deviceFingerprint } = req.body;

  try {
    const emp = await Employee.findOne({ companyEmail }).select(
      "_id companyEmail password role owner name trustedDevices"
    );
    if (!emp) return res.status(401).json({ error: "Invalid credentials" });

    if (
      !emp.password ||
      typeof emp.password !== "string" ||
      emp.password.trim() === ""
    ) {
      return res.status(403).json({
        error: "Account not activated",
        message:
          "Your employee account is not yet activated. Please contact HR to complete activation.",
      });
    }

    const ok = await emp.comparePassword(password);
    if (!ok) return res.status(401).json({ error: "Invalid credentials" });

    // ---------------------
    // 1️⃣ Check if device already trusted
    // ---------------------
    const isTrusted = emp.trustedDevices?.some(
      (d) => d.deviceFingerprint === deviceFingerprint
    );

    if (isTrusted) {
      // Already trusted → skip 2FA
      const token = jwt.sign(
        { id: emp._id, role: emp.role, owner: emp.owner },
        JWT_SECRET,
        { expiresIn: "2h" }
      );

      return res.json({
        message: "Login successful (trusted device).",
        token,
        user: {
          id: emp._id,
          companyEmail: emp.companyEmail,
          role: emp.role,
          owner: emp.owner,
          name: emp.name || "",
        },
        expiresIn: 7200,
      });
    }

    // ---------------------
    // 2️⃣ Unrecognized device → send code
    // ---------------------
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expires = Date.now() + 10 * 60 * 1000; // 10 min
    codes.set(emp._id.toString(), { code, expires, deviceFingerprint });

    const tempToken = jwt.sign({ id: emp._id }, JWT_SECRET, {
      expiresIn: "10m",
    });

    const loginIp =
      req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
      req.ip ||
      "unknown";
    const when = new Date().toISOString();

    const adminTo = "nashfintechnologies@gmail.com";
    const adminSubject = "Employee login verification requested";
    const adminText =
      `A login verification was requested.\n` +
      `Employee: ${emp.companyEmail}\n` +
      `Time (UTC): ${when}\n` +
      `IP: ${loginIp}\n` +
      `Code: ${code} (valid 10 min)\n`;

    await sendMail({
      to: adminTo,
      subject: adminSubject,
      text: adminText,
      html: `<p><b>New device login verification requested</b></p>
             <ul>
               <li><b>Employee:</b> ${emp.companyEmail}</li>
               <li><b>Time (UTC):</b> ${when}</li>
               <li><b>IP:</b> ${loginIp}</li>
               <li><b>Code:</b> <code>${code}</code> (valid 10 min)</li>
             </ul>`,
    });

    return res.json({
      message: "Verification code sent to admin email.",
      tempToken,
      user: {
        id: emp._id,
        companyEmail: emp.companyEmail,
        role: emp.role,
        owner: emp.owner,
        name: emp.name || "",
      },
    });
  } catch (err) {
    console.error("Login error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

router.post("/confirm-code", async (req, res) => {
  const { code, deviceFingerprint } = req.body;
  const tempToken = req.headers.authorization?.split(" ")[1];

  if (!tempToken)
    return res.status(401).json({ error: "No temp token provided" });

  try {
    const decoded = jwt.verify(tempToken, JWT_SECRET);
    const rec = codes.get(decoded.id);

    if (!rec || rec.code !== code) {
      return res.status(400).json({ error: "Invalid or expired code" });
    }

    if (rec.expires < Date.now()) {
      codes.delete(decoded.id);
      return res
        .status(400)
        .json({ error: "Code expired. Please login again." });
    }

    // success → delete code
    codes.delete(decoded.id);

    const emp = await Employee.findById(decoded.id).select(
      "_id companyEmail role owner name trustedDevices"
    );

    const userAgent = req.headers["user-agent"] || "unknown";
    const ip =
      req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
      req.ip ||
      "unknown";

    // ✅ Replace previous trusted device — only allow ONE trusted device at a time
    emp.trustedDevices = [
      {
        deviceFingerprint,
        userAgent,
        ip,
        addedAt: new Date(),
      },
    ];

    await emp.save();

    // Final login token
    const token = jwt.sign(
      { id: emp._id, role: emp.role, owner: emp.owner },
      JWT_SECRET,
      { expiresIn: "2h" }
    );

    return res.json({
      message: "Device verified and trusted (old devices replaced).",
      token,
      user: {
        id: emp._id,
        companyEmail: emp.companyEmail,
        role: emp.role,
        owner: emp.owner,
        name: emp.name || "",
      },
      expiresIn: 7200,
    });
  } catch (err) {
    console.error("Confirm-code error:", err);
    return res.status(401).json({ error: "Invalid or expired temp token" });
  }
});
// ---------------------
// GET current employee (protected)
// ---------------------
router.get("/me", requireAuth, authCtrl.getMe);

module.exports = router;
