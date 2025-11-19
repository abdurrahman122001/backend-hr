const express = require("express");
const jwt = require("jsonwebtoken");
const nodemailer = require("nodemailer");
const crypto = require("crypto");
const Employee = require("../models/Employees");
const EmployeeSession = require("../models/EmployeeSession"); // ✅ Session tracking
const requireAuth = require("../middleware/empAuth");
const authCtrl = require("../controllers/empAuthController");

const router = express.Router();

// ---------------------
// Environment Config
// ---------------------
const {
  JWT_SECRET,
  MAIL_HOST,
  MAIL_PORT,
  MAIL_USERNAME,
  MAIL_PASSWORD,
  MAIL_FROM_ADDRESS,
  MAIL_FROM_NAME,
  MAIL_ENCRYPTION, // "ssl" for 465 in env
} = process.env;

// ---------------------
// Email Transport Setup
// ---------------------
const secure =
  String(MAIL_ENCRYPTION).toLowerCase() === "ssl" || Number(MAIL_PORT) === 465;

const transporter = nodemailer.createTransport({
  host: MAIL_HOST,
  port: Number(MAIL_PORT),
  secure,
  auth: { user: MAIL_USERNAME, pass: MAIL_PASSWORD },
  tls: { rejectUnauthorized: false }, // Fix for Titan/Hostinger SSL
});

// Helper to send email
async function sendMail({ to, subject, text, html }) {
  const from =
    MAIL_FROM_NAME && MAIL_FROM_ADDRESS
      ? `"${MAIL_FROM_NAME}" <${MAIL_FROM_ADDRESS}>`
      : MAIL_FROM_ADDRESS || MAIL_USERNAME;

  return transporter.sendMail({ from, to, subject, text, html });
}

// ---------------------
// Temporary Code Store (for 2FA)
// ---------------------
const codes = new Map(); // codes.set(empId, { code, expires, deviceFingerprint })

// ---------------------
// 1️⃣ LOGIN — password check + trusted device + session logging
// ---------------------
router.post("/login", async (req, res) => {
  const { companyEmail, password, deviceFingerprint, deviceToken } = req.body;

  try {
    const emp = await Employee.findOne({ companyEmail }).select(
      "_id companyEmail password role owner name trustedDevices department"
    );

    if (!emp) return res.status(401).json({ error: "Invalid credentials" });

    if (!emp.password?.trim()) {
      return res.status(403).json({
        error: "Account not activated",
        message:
          "Your employee account is not yet activated. Please contact HR to complete activation.",
      });
    }

    const ok = await emp.comparePassword(password);
    if (!ok) return res.status(401).json({ error: "Invalid credentials" });

    // ---------------------------
    // CHECK IF DEVICE IS TRUSTED
    // ---------------------------
    const isTrusted = emp.trustedDevices?.some(
      (d) =>
        d.deviceFingerprint === deviceFingerprint || d.deviceId === deviceToken
    );

    if (isTrusted) {
      // ✅ TRUSTED DEVICE → DIRECT LOGIN
      const token = jwt.sign(
        {
          id: emp._id,
          role: emp.role,
          owner: emp.owner,
          name: emp.name,
          companyEmail: emp.companyEmail,
          department: emp.department, // ⭐ ADD THIS
        },
        JWT_SECRET,
        { expiresIn: "9h" }
      );

      // Log session
      await EmployeeSession.create({
        employeeId: emp._id,
        deviceFingerprint,
        loginTime: new Date(),
        active: true,
      });

      return res.json({
        message: "Login successful (trusted device).",
        token,
        user: {
          id: emp._id,
          name: emp.name,
          companyEmail: emp.companyEmail,
          role: emp.role,
          owner: emp.owner,
          department: emp.department, // ⭐ ALSO ADD HERE
        },
        trusted: true,
        expiresIn: 9 * 60 * 60,
      });
    }

    // ---------------------------
    // 2FA (UNRECOGNIZED DEVICE)
    // ---------------------------
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

    // Send to admin
    await sendMail({
      to: "qaziabdurrahman12@gmail.com",
      subject: "Employee login verification requested",
      text: `Employee: ${emp.companyEmail}\nTime: ${when}\nIP: ${loginIp}\nCode: ${code}`,
      html: `<p><b>New device login verification requested</b></p>
             <ul>
               <li><b>Employee:</b> ${emp.companyEmail}</li>
               <li><b>Time:</b> ${when}</li>
               <li><b>IP:</b> ${loginIp}</li>
               <li><b>Code:</b> <code>${code}</code></li>
             </ul>`,
    });

    return res.json({
      message: "Verification code sent to admin email.",
      tempToken,
      user: {
        id: emp._id,
        name: emp.name,
        companyEmail: emp.companyEmail,
        role: emp.role,
        owner: emp.owner,
        department: emp.department, // ⭐ ADD THIS HERE TOO
      },
    });
  } catch (err) {
    console.error("Login error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ---------------------
// 2️⃣ CONFIRM CODE — trust new device + create session + return permanent token
// ---------------------
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

    // ✅ Success → delete code
    codes.delete(decoded.id);

    const emp = await Employee.findById(decoded.id).select(
      "_id companyEmail role owner name trustedDevices"
    );

    const userAgent = req.headers["user-agent"] || "unknown";
    const ip =
      req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
      req.ip ||
      "unknown";

    // ✅ Generate permanent device token
    const deviceId = crypto.randomBytes(32).toString("hex");

    // ✅ Save trusted device if not already stored
    if (
      !emp.trustedDevices.some(
        (d) => d.deviceFingerprint === deviceFingerprint
      )
    ) {
      emp.trustedDevices.push({
        deviceId,
        deviceFingerprint,
        userAgent,
        ip,
        addedAt: new Date(),
      });
    }
    await emp.save();

    // ✅ Generate JWT for session
    const token = jwt.sign(
      { id: emp._id, role: emp.role, owner: emp.owner },
      JWT_SECRET,
      { expiresIn: "9h" }
    );

    // ✅ Log check-in session
    await EmployeeSession.create({
      employeeId: emp._id,
      deviceFingerprint,
      loginTime: new Date(),
      active: true,
    });

    return res.json({
      message: "Device verified and trusted. Login successful.",
      token,
      deviceToken: deviceId, // ✅ new field for frontend
      user: {
        id: emp._id,
        companyEmail: emp.companyEmail,
        role: emp.role,
        owner: emp.owner,
        name: emp.name || "",
      },
      expiresIn: 9 * 60 * 60,
    });
  } catch (err) {
    console.error("Confirm-code error:", err);
    return res.status(401).json({ error: "Invalid or expired temp token" });
  }
});

// ---------------------
// 3️⃣ LOGOUT — mark check-out time
// ---------------------
router.post("/logout", requireAuth, async (req, res) => {
  try {
    await EmployeeSession.findOneAndUpdate(
      { employeeId: req.employee._id, active: true },
      { logoutTime: new Date(), active: false }
    );
    return res.json({ status: "success", message: "Logged out successfully" });
  } catch (err) {
    console.error("Logout error:", err);
    return res.status(500).json({ error: "Server error during logout" });
  }
});

router.get("/me", requireAuth, authCtrl.getMe);

// ---------------------
// 4️⃣ Get Attendance Logs (Optional Admin Endpoint)
// ---------------------
router.get("/sessions", requireAuth, async (req, res) => {
  try {
    const sessions = await EmployeeSession.find({
      employeeId: req.employee._id,
    })
      .sort({ loginTime: -1 })
      .limit(30);
    res.json({ sessions });
  } catch (err) {
    console.error("Fetch sessions error:", err);
    res.status(500).json({ error: "Unable to fetch sessions" });
  }
});

router.get("/all-sessions", async (req, res) => {
  try {
    const sessions = await EmployeeSession.find()
      .populate("employeeId", "name companyEmail role")
      .sort({ loginTime: -1 })
      .limit(100);

    const formatted = sessions.map((s) => ({
      id: s._id,
      employeeName: s.employeeId?.name || "Unknown",
      employeeEmail: s.employeeId?.companyEmail || "N/A",
      role: s.employeeId?.role || "N/A",
      loginTime: s.loginTime,
      logoutTime: s.logoutTime,
      active: s.active,
      deviceFingerprint: s.deviceFingerprint,
    }));

    res.json({ sessions: formatted });
  } catch (err) {
    console.error("Error fetching sessions:", err);
    res.status(500).json({ error: "Server error while fetching sessions" });
  }
});

module.exports = router;
