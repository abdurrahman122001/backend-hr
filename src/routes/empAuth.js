const express = require("express");
const jwt = require("jsonwebtoken");
const nodemailer = require("nodemailer");
const crypto = require("crypto");
const Employee = require("../models/Employees");
const EmployeeSession = require("../models/EmployeeSession");
const requireAuth = require("../middleware/empAuth");
const authCtrl = require("../controllers/empAuthController");
const moment = require("moment-timezone"); // Add this package: npm install moment-timezone

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
  MAIL_ENCRYPTION,
} = process.env;

// ---------------------
// Timezone Configuration
// ---------------------
const TIMEZONE = "Asia/Karachi";
const OFFICE_START_HOUR = 15; // 3:00 PM in 24-hour format
const OFFICE_START_MINUTE = 0;
const GRACE_PERIOD_MINUTES = 15;
const HALF_DAY_THRESHOLD_HOUR = 18; // 6:00 PM
const LOGIN_RESTRICTION_END_HOUR = 8; // 8:00 AM
const HALF_DAY_LOGOUT_THRESHOLD_HOUR = 21; // 9:00 PM
const TOKEN_EXPIRY_SECONDS = 9 * 60 * 60; // 9 hours

// Helper function to get current time in Karachi
function getKarachiTime() {
  return moment().tz(TIMEZONE);
}

function formatTimeForDisplay(date) {
  return moment(date).tz(TIMEZONE).format("YYYY-MM-DD HH:mm:ss");
}

function formatTimeForStorage(date) {
  return moment(date).tz(TIMEZONE).format("YYYY-MM-DD HH:mm");
}

function getDateOnly(date) {
  return moment(date).tz(TIMEZONE).format("YYYY-MM-DD");
}


function secondsUntilMidnight() {
  const now = moment().tz(TIMEZONE);
  const midnight = moment().tz(TIMEZONE).endOf("day").add(1, "second");
  return Math.max(midnight.diff(now, "seconds"), 60);
}


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
  tls: { rejectUnauthorized: false },
});

async function sendMail({ to, subject, text, html }) {
  const from =
    MAIL_FROM_NAME && MAIL_FROM_ADDRESS
      ? `"${MAIL_FROM_NAME}" <${MAIL_FROM_ADDRESS}>`
      : MAIL_FROM_ADDRESS || MAIL_USERNAME;

  return transporter.sendMail({ from, to, subject, text, html });
}

const codes = new Map();

router.post("/login", async (req, res) => {
  const { companyEmail, password, deviceFingerprint, deviceToken } = req.body;

  try {
    // Get current time in Karachi
    const nowKarachi = getKarachiTime();
    const hours = nowKarachi.hours();
    const minutes = nowKarachi.minutes();
    const currentTime = hours * 60 + minutes;
    
    // Get date in Karachi timezone
    const todayKarachi = getDateOnly(nowKarachi);
    
    // ⚠️ TIME RESTRICTION: No login between 12 AM - 8 AM Karachi time
    const isRestrictedTime = currentTime >= 0 && currentTime < (LOGIN_RESTRICTION_END_HOUR * 60);

    const emp = await Employee.findOne({ companyEmail }).select(
      "_id companyEmail password role owner name trustedDevices department status"
    );

    if (!emp) return res.status(401).json({ error: "Invalid credentials" });

    if (emp.status && (emp.status.toLowerCase() === "offboarded" || emp.status.toLowerCase() === "review")) {
      return res.status(403).json({
        error: "Account Disabled",
        message:
          "Your account has been offboarded. Please contact HR if you believe this is a mistake.",
      });
    }

    if (!emp.password?.trim()) {
      return res.status(403).json({
        error: "Account not activated",
        message:
          "Your employee account is not yet activated. Please contact HR to complete activation.",
      });
    }

    const ok = await emp.comparePassword(password);
    if (!ok) return res.status(401).json({ error: "Invalid credentials" });

    if (isRestrictedTime) {
      console.log(`[RESTRICTED TIME LOGIN] ${emp.companyEmail} logged in during 12 AM - 8 AM Karachi time. No session created.`);

      const token = jwt.sign(
        {
          id: emp._id,
          role: emp.role,
          owner: emp.owner,
          name: emp.name,
          companyEmail: emp.companyEmail,
          department: emp.department,
        },
        JWT_SECRET,
        { expiresIn: TOKEN_EXPIRY_SECONDS }
      );

      return res.json({
        message: "Login successful (Restricted hours: 12 AM - 8 AM Karachi time. No attendance recorded)",
        token,
        user: {
          id: emp._id,
          name: emp.name,
          companyEmail: emp.companyEmail,
          role: emp.role,
          owner: emp.owner,
          department: emp.department,
        },
        restrictedHours: true,
        expiresIn: 9 * 60 * 60,
      });
    }

    // CHECK FOR EXISTING SESSION TODAY (using Karachi date)
    const existingSession = await EmployeeSession.findOne({
      employeeId: emp._id,
      date: todayKarachi // Use Karachi date
    }).sort({ loginTime: -1 });

    let session;
    let sessionStatus = "on-time";
    let isLoginAfter6PM = false;

    // IF NO EXISTING SESSION → CREATE NEW ONE
    if (!existingSession) {
      // CALCULATE STATUS BASED ON KARACHI LOGIN TIME
      const loginTotalMinutes = currentTime;

      // Time thresholds in minutes since midnight (Karachi time)
      const officeStart = OFFICE_START_HOUR * 60 + OFFICE_START_MINUTE; // 3:00 PM
      const gracePeriodEnd = officeStart + GRACE_PERIOD_MINUTES; // 3:15 PM
      const halfDayThreshold = HALF_DAY_THRESHOLD_HOUR * 60; // 6:00 PM

      if (loginTotalMinutes < officeStart) {
        sessionStatus = "on-time";
      } else if (loginTotalMinutes <= gracePeriodEnd) {
        sessionStatus = "on-time";
      } else if (loginTotalMinutes < halfDayThreshold) {
        sessionStatus = "late";
      } else {
        sessionStatus = "half-day";
        isLoginAfter6PM = true;
      }

      // Store times in Karachi timezone
      const actualLoginTime = formatTimeForStorage(nowKarachi);
      const loginTimeUTC = nowKarachi.utc().toDate(); // Store UTC for consistent querying

      // ✅ CREATE NEW SESSION
      session = await EmployeeSession.create({
        employeeId: emp._id,
        deviceFingerprint,
        loginTime: loginTimeUTC, // Store as UTC but calculated from Karachi time
        date: todayKarachi, // Store Karachi date
        active: true,
        status: sessionStatus,
        isLoginAfter6PM: isLoginAfter6PM,
        actualLoginTime: actualLoginTime, // Store formatted Karachi time
        timezone: TIMEZONE // Store timezone for reference
      });
    } else {
      // ✅ SESSION ALREADY EXISTS
      session = existingSession;
      sessionStatus = existingSession.status;
    }

    // CHECK IF DEVICE IS TRUSTED
    const isTrusted = emp.trustedDevices?.some(
      (d) =>
        d.deviceFingerprint === deviceFingerprint || d.deviceId === deviceToken
    );

    if (isTrusted) {
      const token = jwt.sign(
        {
          id: emp._id,
          role: emp.role,
          owner: emp.owner,
          name: emp.name,
          companyEmail: emp.companyEmail,
          department: emp.department,
        },
        JWT_SECRET,
        { expiresIn: TOKEN_EXPIRY_SECONDS }
      );

      return res.json({
        message: existingSession ?
          "Login successful (session already exists)." :
          "Login successful (trusted device).",
        token,
        user: {
          id: emp._id,
          name: emp.name,
          companyEmail: emp.companyEmail,
          role: emp.role,
          owner: emp.owner,
          department: emp.department,
        },
        sessionId: session._id,
        sessionStatus: sessionStatus,
        sessionExists: !!existingSession,
        trusted: true,
        expiresIn: 9 * 60 * 60,
        localLoginTime: formatTimeForDisplay(nowKarachi), // Return local time for display
      });
    }

    // 2FA (UNRECOGNIZED DEVICE)
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expires = Date.now() + 10 * 60 * 1000;
    codes.set(emp._id.toString(), { code, expires, deviceFingerprint });

    const tempToken = jwt.sign({ id: emp._id }, JWT_SECRET, {
      expiresIn: "10m",
    });

    const loginIp =
      req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
      req.ip ||
      "unknown";
    const when = formatTimeForDisplay(nowKarachi);

    await sendMail({
      to: "nashfintechnologies@gmail.com",
      subject: "Employee login verification requested",
      text: `Employee: ${emp.companyEmail}\nTime (Karachi): ${when}\nIP: ${loginIp}\nCode: ${code}\nStatus: ${sessionStatus}`,
      html: `<p><b>New device login verification requested</b></p>
             <ul>
               <li><b>Employee:</b> ${emp.companyEmail}</li>
               <li><b>Time (Karachi):</b> ${when}</li>
               <li><b>IP:</b> ${loginIp}</li>
               <li><b>Login Status:</b> ${sessionStatus}</li>
               <li><b>Verification Code:</b> <code>${code}</code></li>
             </ul>`,
    });

    return res.json({
      message: "Verification code sent to admin email.",
      tempToken,
      sessionId: session._id,
      sessionStatus: sessionStatus,
      sessionExists: !!existingSession,
      user: {
        id: emp._id,
        name: emp.name,
        companyEmail: emp.companyEmail,
        role: emp.role,
        owner: emp.owner,
        department: emp.department,
      },
      localLoginTime: formatTimeForDisplay(nowKarachi),
    });
  } catch (err) {
    console.error("Login error:", err);

    if (err.code === 11000) {
      return res.status(400).json({
        error: "Session Conflict",
        message: "A session already exists for today."
      });
    }

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

    codes.delete(decoded.id);

    const emp = await Employee.findById(decoded.id).select(
      "_id companyEmail role owner name trustedDevices"
    );

    const userAgent = req.headers["user-agent"] || "unknown";
    const ip =
      req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
      req.ip ||
      "unknown";

    const deviceId = crypto.randomBytes(32).toString("hex");

    if (
      !emp.trustedDevices.some((d) => d.deviceFingerprint === deviceFingerprint)
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

    const token = jwt.sign(
      { id: emp._id, role: emp.role, owner: emp.owner },
      JWT_SECRET,
      { expiresIn: TOKEN_EXPIRY_SECONDS }
    );

    // Get Karachi time for session logging
    const nowKarachi = getKarachiTime();
    const loginTimeUTC = nowKarachi.utc().toDate();
    const todayKarachi = getDateOnly(nowKarachi);
    const actualLoginTime = formatTimeForStorage(nowKarachi);

    await EmployeeSession.create({
      employeeId: emp._id,
      deviceFingerprint,
      loginTime: loginTimeUTC,
      date: todayKarachi,
      actualLoginTime: actualLoginTime,
      active: true,
      timezone: TIMEZONE
    });

    return res.json({
      message: "Device verified and trusted. Login successful.",
      token,
      deviceToken: deviceId,
      user: {
        id: emp._id,
        companyEmail: emp.companyEmail,
        role: emp.role,
        owner: emp.owner,
        name: emp.name || "",
      },
      expiresIn: 9 * 60 * 60,
      localLoginTime: formatTimeForDisplay(nowKarachi),
    });
  } catch (err) {
    console.error("Confirm-code error:", err);
    return res.status(401).json({ error: "Invalid or expired temp token" });
  }
});

router.post("/logout", requireAuth, async (req, res) => {
  try {
    // Get current time in Karachi
    const nowKarachi = getKarachiTime();
    const logoutHour = nowKarachi.hours();
    const logoutMinute = nowKarachi.minutes();
    const logoutTotalMinutes = logoutHour * 60 + logoutMinute;
    
    const halfDayLogoutThreshold = HALF_DAY_LOGOUT_THRESHOLD_HOUR * 60; // 9:00 PM Karachi time

    const session = await EmployeeSession.findOne({
      employeeId: req.employee.id || req.employee._id,
      active: true
    });

    if (!session) {
      return res.status(400).json({
        error: "No active session found"
      });
    }

    let finalStatus = session.status;

    // If logged out before 9:00 PM Karachi time, change status to half-day
    if (logoutTotalMinutes < halfDayLogoutThreshold) {
      finalStatus = "half-day";
    }

    // Calculate total hours worked (convert loginTime from UTC to Karachi for calculation)
    const loginTimeKarachi = moment(session.loginTime).tz(TIMEZONE);
    const totalHours = nowKarachi.diff(loginTimeKarachi, 'hours', true);

    // Update the session with Karachi time
    const logoutTimeUTC = nowKarachi.utc().toDate();
    const actualLogoutTime = formatTimeForStorage(nowKarachi);

    const updated = await EmployeeSession.findByIdAndUpdate(
      session._id,
      {
        logoutTime: logoutTimeUTC,
        active: false,
        status: finalStatus,
        actualLogoutTime: actualLogoutTime,
        totalHours: parseFloat(totalHours.toFixed(2))
      },
      { new: true }
    );

    return res.json({
      status: "success",
      message: "Logged out successfully",
      logoutTime: formatTimeForDisplay(nowKarachi),
      sessionStatus: updated.status,
      totalHours: updated.totalHours
    });
  } catch (err) {
    console.error("Logout error:", err);
    return res.status(500).json({ error: "Server error during logout" });
  }
});

router.get("/me", requireAuth, authCtrl.getMe);

// ---------------------
// 4️⃣ Get Attendance Logs
// ---------------------
router.get("/sessions", requireAuth, async (req, res) => {
  try {
    const sessions = await EmployeeSession.find({
      employeeId: req.employee._id,
    })
      .sort({ loginTime: -1 })
      .limit(30);
    
    // Convert times to Karachi timezone for display
    const formattedSessions = sessions.map(session => ({
      ...session.toObject(),
      loginTimeLocal: moment(session.loginTime).tz(TIMEZONE).format("YYYY-MM-DD HH:mm:ss"),
      logoutTimeLocal: session.logoutTime ? 
        moment(session.logoutTime).tz(TIMEZONE).format("YYYY-MM-DD HH:mm:ss") : null,
      actualLoginTime: session.actualLoginTime,
      actualLogoutTime: session.actualLogoutTime,
    }));
    
    res.json({ sessions: formattedSessions });
  } catch (err) {
    console.error("Fetch sessions error:", err);
    res.status(500).json({ error: "Unable to fetch sessions" });
  }
});

router.get("/all-sessions", async (req, res) => {
  try {
    const sessions = await EmployeeSession.find()
      .populate("employeeId", "name companyEmail role")
      .sort({ loginTime: -1 });

    const formatted = sessions.map((s) => {
      const loginTimeLocal = moment(s.loginTime).tz(TIMEZONE).format("YYYY-MM-DD HH:mm:ss");
      const logoutTimeLocal = s.logoutTime ? 
        moment(s.logoutTime).tz(TIMEZONE).format("YYYY-MM-DD HH:mm:ss") : null;
      
      return {
        id: s._id,
        employeeName: s.employeeId?.name || "Unknown",
        employeeEmail: s.employeeId?.companyEmail || "N/A",
        role: s.employeeId?.role || "N/A",
        loginTime: loginTimeLocal,
        logoutTime: logoutTimeLocal,
        actualLoginTime: s.actualLoginTime,
        actualLogoutTime: s.actualLogoutTime,
        active: s.active,
        status: s.status,
        deviceFingerprint: s.deviceFingerprint,
        totalHours: s.totalHours,
        timezone: s.timezone || TIMEZONE,
      };
    });

    res.json({ sessions: formatted });
  } catch (err) {
    console.error("Error fetching sessions:", err);
    res.status(500).json({ error: "Server error while fetching sessions" });
  }
});

module.exports = router;