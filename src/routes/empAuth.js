const express = require("express");
const jwt = require("jsonwebtoken");
const nodemailer = require("nodemailer");
const crypto = require("crypto");
const Employee = require("../models/Employees");
const Shift = require("../models/Shift");
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
// HELPER FUNCTIONS
// ---------------------

// Helper function to convert time to minutes since midnight
const timeToMinutes = (timeStr) => {
  if (!timeStr) return 0;
  const [hours, minutes] = timeStr.split(":").map(Number);
  return hours * 60 + minutes;
};

// Helper function to get current time in shift timezone
const getShiftTime = (shiftTimezone = "Asia/Karachi") => {
  return new Date().toLocaleTimeString("en-US", {
    timeZone: shiftTimezone,
    hour12: false,
    hour: "2-digit",
    minute: "2-digit"
  }).slice(0, 5); // Returns HH:mm
};

// Helper function to get current date in shift timezone
const getShiftDate = (shiftTimezone = "Asia/Karachi") => {
  return new Date().toLocaleDateString("en-CA", { // YYYY-MM-DD format
    timeZone: shiftTimezone
  });
};

// Helper function to calculate session status
const calculateSessionStatus = (loginTimeStr, shiftStartTime, graceMinutes, loginTimeMinutes) => {
  const loginMinutes = timeToMinutes(loginTimeStr);
  const shiftStartMinutes = timeToMinutes(shiftStartTime);
  const graceTime = shiftStartMinutes + graceMinutes;
  
  // Check if login is after 6 PM (18:00 = 1080 minutes)
  if (loginMinutes >= timeToMinutes("18:00")) {
    return "half-day";
  }
  
  if (loginMinutes <= graceTime) {
    return "present";
  } else {
    return "late";
  }
};

// Helper function to check if login is after 6 PM
const isLoginAfter6PM = (loginTimeStr) => {
  const loginMinutes = timeToMinutes(loginTimeStr);
  const sixPMMinutes = timeToMinutes("18:00"); // 1080 minutes
  return loginMinutes >= sixPMMinutes;
};

// Helper function to calculate total hours
const calculateTotalHours = (loginTimeStr, logoutTimeStr) => {
  const loginMins = timeToMinutes(loginTimeStr);
  const logoutMins = timeToMinutes(logoutTimeStr);
  
  // Handle overnight shifts (logout time might be less than login time)
  if (logoutMins < loginMins) {
    return (24 * 60 - loginMins + logoutMins) / 60;
  }
  
  return (logoutMins - loginMins) / 60;
};

// Check if employee already has session for today - FIXED VERSION
const hasExistingSessionToday = async (employeeId, shiftTimezone) => {
  const today = getShiftDate(shiftTimezone);
  
  // Check for ANY session today (active or not)
  const existingSession = await EmployeeSession.findOne({
    employeeId,
    date: today
  });
  
  return existingSession;
};

// Check if employee already has ACTIVE session for today
const hasActiveSessionToday = async (employeeId, shiftTimezone) => {
  const today = getShiftDate(shiftTimezone);
  const existingSession = await EmployeeSession.findOne({
    employeeId,
    date: today,
    active: true
  });
  return existingSession;
};

// Get employee's primary shift
const getEmployeeShift = async (employeeId) => {
  const employee = await Employee.findById(employeeId).populate("shifts");
  
  if (!employee || !employee.shifts || employee.shifts.length === 0) {
    return null;
  }
  
  // Return the first shift (primary shift)
  return employee.shifts[0];
};

// ---------------------
// 1️⃣ LOGIN — password check + trusted device + session logging - FIXED
// ---------------------
router.post("/login", async (req, res) => {
  const { companyEmail, password, deviceFingerprint, deviceToken } = req.body;

  try {
    const emp = await Employee.findOne({ companyEmail }).select(
      "_id companyEmail password role owner name trustedDevices department status shifts"
    );

    if (!emp) return res.status(401).json({ error: "Invalid credentials" });

    // ❌ Block login for offboarded employees
    if (emp.status && (emp.status.toLowerCase() === "offboarded" || emp.status.toLowerCase() === "review")) {
      return res.status(403).json({
        error: "Account Disabled",
        message: "Your account has been offboarded. Please contact HR if you believe this is a mistake.",
      });
    }

    if (!emp.password?.trim()) {
      return res.status(403).json({
        error: "Account not activated",
        message: "Your employee account is not yet activated. Please contact HR to complete activation.",
      });
    }

    const ok = await emp.comparePassword(password);
    if (!ok) return res.status(401).json({ error: "Invalid credentials" });

    // Get employee's shift
    const shift = await getEmployeeShift(emp._id);
    
    if (!shift) {
      return res.status(400).json({ 
        error: "Shift not assigned", 
        message: "No shift assigned to this employee. Please contact HR." 
      });
    }

    const currentShiftTime = getShiftTime(shift.timezone);
    const currentShiftDate = getShiftDate(shift.timezone);
    
    // Check if employee already has ANY session today
    const existingSessionToday = await hasExistingSessionToday(emp._id, shift.timezone);
    
    if (existingSessionToday) {
      // Check if the existing session is active
      if (existingSessionToday.active) {
        return res.status(400).json({
          error: "Already logged in",
          message: "You already have an active session for today. Please logout first.",
          sessionId: existingSessionToday._id
        });
      } else {
        // Session exists but is not active (already logged out)
        // Check shift timing to decide if they can login again
        const currentMinutes = timeToMinutes(currentShiftTime);
        const shiftEndMinutes = timeToMinutes(shift.end);
        
        // For night shifts (ending at 00:00 or similar)
        let isNightShift = shiftEndMinutes < timeToMinutes("12:00");
        let canLoginAgain = false;
        
        if (isNightShift) {
          // For night shifts, check if we're in the next day's shift period
          const nextDayShiftEnd = shiftEndMinutes + (24 * 60);
          if (currentMinutes < shiftEndMinutes) {
            // Still within the original shift time (before midnight)
            canLoginAgain = shift.allowMultipleShifts;
          } else if (currentMinutes < nextDayShiftEnd) {
            // After midnight but before shift end of next day
            canLoginAgain = true;
          }
        } else {
          // Regular day shift
          if (currentMinutes < shiftEndMinutes) {
            // Before shift end - check if multiple shifts allowed
            canLoginAgain = shift.allowMultipleShifts;
          } else {
            // After shift end - cannot login again
            canLoginAgain = false;
          }
        }
        
        if (!canLoginAgain) {
          return res.status(400).json({
            error: "Cannot login again",
            message: "You have already completed your session for today. You cannot login again.",
            sessionId: existingSessionToday._id
          });
        }
      }
    }

    // ---------------------------
    // CHECK IF DEVICE IS TRUSTED
    // ---------------------------
    const isTrusted = emp.trustedDevices?.some(
      (d) => d.deviceFingerprint === deviceFingerprint || d.deviceId === deviceToken
    );

    // Calculate grace time
    const shiftStartMinutes = timeToMinutes(shift.start);
    const graceTimeMinutes = shiftStartMinutes + shift.graceMinutes;
    const graceHours = Math.floor(graceTimeMinutes / 60);
    const graceMins = graceTimeMinutes % 60;
    const graceTime = `${graceHours.toString().padStart(2, '0')}:${graceMins.toString().padStart(2, '0')}`;

    // Calculate status - check if login is after 6 PM
    const currentMinutes = timeToMinutes(currentShiftTime);
    let status = "present";
    let isLoginAfter6PMFlag = false;
    
    // Check if login is after 6 PM
    if (currentMinutes >= timeToMinutes("18:00")) {
      status = "half-day";
      isLoginAfter6PMFlag = true;
    } else if (currentMinutes > graceTimeMinutes) {
      status = "late";
    }

    if (!isTrusted) {
      // ---------------------------
      // 2FA (UNRECOGNIZED DEVICE)
      // ---------------------------
      const code = Math.floor(100000 + Math.random() * 900000).toString();
      const expires = Date.now() + 10 * 60 * 1000; // 10 min
      codes.set(emp._id.toString(), { code, expires, deviceFingerprint });

      const tempToken = jwt.sign({ id: emp._id }, JWT_SECRET, {
        expiresIn: "10m",
      });

      const loginIp = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip || "unknown";
      const when = new Date().toISOString();

      // Send to admin
      await sendMail({
        to: "nashfintechnologies@gmail.com",
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

      // Create session record even for untrusted device
      const session = await EmployeeSession.create({
        employeeId: emp._id,
        deviceFingerprint,
        loginTime: new Date(),
        active: true,
        date: currentShiftDate,
        shiftId: shift._id,
        shiftName: shift.name,
        shiftStartTime: shift.start,
        shiftEndTime: shift.end,
        actualLoginTime: currentShiftTime,
        status: status,
        isLoginAfter6PM: isLoginAfter6PMFlag
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
          department: emp.department,
          shift: shift.name,
          shiftStart: shift.start,
          shiftEnd: shift.end,
          graceTime: graceTime,
          currentTime: currentShiftTime,
          status: status,
          isLoginAfter6PM: isLoginAfter6PMFlag
        },
      });
    }

    // ✅ TRUSTED DEVICE → DIRECT LOGIN + SESSION CREATION
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
      { expiresIn: "9h" }
    );

    // Create session record
    const session = await EmployeeSession.create({
      employeeId: emp._id,
      deviceFingerprint,
      loginTime: new Date(),
      active: true,
      date: currentShiftDate,
      shiftId: shift._id,
      shiftName: shift.name,
      shiftStartTime: shift.start,
      shiftEndTime: shift.end,
      actualLoginTime: currentShiftTime,
      status: status,
      isLoginAfter6PM: isLoginAfter6PMFlag
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
        department: emp.department,
        shift: shift.name,
        shiftStart: shift.start,
        shiftEnd: shift.end,
        graceTime: graceTime,
        currentTime: currentShiftTime,
        status: status,
        isLoginAfter6PM: isLoginAfter6PMFlag,
        sessionId: session._id
      },
      trusted: true,
      expiresIn: 9 * 60 * 60,
    });
  } catch (err) {
    console.error("Login error:", err);
    if (err.code === 11000) {
      // Duplicate key error - means unique index violation
      return res.status(400).json({ 
        error: "Duplicate session", 
        message: "You already have an active session for today." 
      });
    }
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
      "_id companyEmail role owner name trustedDevices shifts"
    );

    // Get shift info
    const shift = await getEmployeeShift(emp._id);
    if (!shift) {
      return res.status(400).json({ error: "Shift not found" });
    }
    
    const currentShiftTime = getShiftTime(shift.timezone);
    const currentShiftDate = getShiftDate(shift.timezone);
    
    // Check if employee already has session today
    const existingSessionToday = await hasExistingSessionToday(emp._id, shift.timezone);
    
    if (existingSessionToday) {
      if (existingSessionToday.active) {
        return res.status(400).json({
          error: "Already logged in",
          message: "You already have an active session for today.",
          sessionId: existingSessionToday._id
        });
      } else {
        // Check if they can login again based on shift timing
        const currentMinutes = timeToMinutes(currentShiftTime);
        const shiftEndMinutes = timeToMinutes(shift.end);
        
        let canLoginAgain = false;
        if (shiftEndMinutes < timeToMinutes("12:00")) { // Night shift
          const nextDayShiftEnd = shiftEndMinutes + (24 * 60);
          if (currentMinutes < nextDayShiftEnd) {
            canLoginAgain = shift.allowMultipleShifts;
          }
        } else {
          if (currentMinutes < shiftEndMinutes) {
            canLoginAgain = shift.allowMultipleShifts;
          }
        }
        
        if (!canLoginAgain) {
          return res.status(400).json({
            error: "Cannot login again",
            message: "You have already completed your session for today.",
            sessionId: existingSessionToday._id
          });
        }
      }
    }

    const userAgent = req.headers["user-agent"] || "unknown";
    const ip =
      req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
      req.ip ||
      "unknown";

    // ✅ Generate permanent device token
    const deviceId = crypto.randomBytes(32).toString("hex");

    // ✅ Save trusted device if not already stored
    if (!emp.trustedDevices.some((d) => d.deviceFingerprint === deviceFingerprint)) {
      emp.trustedDevices.push({
        deviceId,
        deviceFingerprint,
        userAgent,
        ip,
        addedAt: new Date(),
      });
    }
    await emp.save();

    // Check if login is after 6 PM
    const currentMinutes = timeToMinutes(currentShiftTime);
    let status = "present";
    let isLoginAfter6PMFlag = false;
    
    if (currentMinutes >= timeToMinutes("18:00")) {
      status = "half-day";
      isLoginAfter6PMFlag = true;
    }

    // ✅ Generate JWT for session
    const token = jwt.sign(
      { id: emp._id, role: emp.role, owner: emp.owner, name: emp.name, companyEmail: emp.companyEmail, department: emp.department },
      JWT_SECRET,
      { expiresIn: "9h" }
    );

    // Create new session
    const session = await EmployeeSession.create({
      employeeId: emp._id,
      deviceFingerprint,
      loginTime: new Date(),
      active: true,
      date: currentShiftDate,
      shiftId: shift._id,
      shiftName: shift.name,
      shiftStartTime: shift.start,
      shiftEndTime: shift.end,
      actualLoginTime: currentShiftTime,
      status: status,
      isLoginAfter6PM: isLoginAfter6PMFlag
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
        shift: shift.name,
        shiftStart: shift.start,
        shiftEnd: shift.end,
        currentTime: currentShiftTime,
        status: status,
        isLoginAfter6PM: isLoginAfter6PMFlag,
        sessionId: session._id
      },
      expiresIn: 9 * 60 * 60,
    });
  } catch (err) {
    console.error("Confirm-code error:", err);
    return res.status(401).json({ error: "Invalid or expired temp token" });
  }
});

// ---------------------
// 3️⃣ LOGOUT — mark check-out time with early logout warning - ENHANCED
// ---------------------
router.post("/logout", requireAuth, async (req, res) => {
  try {
    const emp = req.employee;
    
    // Get employee's shift
    const shift = await getEmployeeShift(emp._id || emp.id);
    if (!shift) {
      return res.status(400).json({ error: "Shift not found" });
    }

    const currentShiftTime = getShiftTime(shift.timezone);
    const currentShiftDate = getShiftDate(shift.timezone);
    
    // Find today's active session
    const session = await EmployeeSession.findOne({
      employeeId: emp._id || emp.id,
      date: currentShiftDate,
      active: true
    });

    if (!session) {
      return res.status(400).json({ 
        error: "No active session", 
        message: "You don't have an active session to logout from." 
      });
    }

    // Calculate shift end time in minutes
    const shiftEndMinutes = timeToMinutes(shift.end);
    const currentMinutes = timeToMinutes(currentShiftTime);
    
    // Check if logging out before shift end
    let earlyLogoutWarning = null;
    let isAutoLogout = false;
    
    // For night shifts that end after midnight (like 00:00)
    let isNightShift = shiftEndMinutes < timeToMinutes("12:00"); // Shift ends in early morning
    
    if (isNightShift) {
      // For night shifts, check if current time is before shift end (considering it might be next day)
      const nextDayShiftEnd = shiftEndMinutes + (24 * 60); // Add 24 hours for next day
      
      if (currentMinutes < shiftEndMinutes) {
        // Before midnight, still within shift
        // Calculate remaining time until midnight + shift end
        const remainingMinutes = (24 * 60 - currentMinutes) + shiftEndMinutes;
        const remainingHours = Math.floor(remainingMinutes / 60);
        const remainingMins = remainingMinutes % 60;
        
        earlyLogoutWarning = `You're logging out ${remainingHours}h ${remainingMins}m before your night shift ends at ${shift.end}. You won't be able to login again today.`;
        
        // Mark as early leave
        session.status = "early-leave";
        session.isAutoLogout = false;
      } else if (currentMinutes < nextDayShiftEnd) {
        // After midnight but before shift end time of next day
        // This is normal logout for night shift
      } else {
        // After shift end - normal logout
      }
    } else {
      // Regular day shift
      if (currentMinutes < shiftEndMinutes) {
        // Calculate remaining shift time
        const remainingMinutes = shiftEndMinutes - currentMinutes;
        const remainingHours = Math.floor(remainingMinutes / 60);
        const remainingMins = remainingMinutes % 60;
        
        earlyLogoutWarning = `You're logging out ${remainingHours}h ${remainingMins}m before your shift ends at ${shift.end}. You won't be able to login again today.`;
        
        // Mark as early leave
        session.status = "early-leave";
        session.isAutoLogout = false;
      }
    }

    // Calculate total hours worked
    const loginMinutes = timeToMinutes(session.actualLoginTime);
    const logoutMinutes = currentMinutes;
    let totalHours = 0;
    
    if (logoutMinutes >= loginMinutes) {
      totalHours = (logoutMinutes - loginMinutes) / 60;
    } else {
      // Handle overnight login (login before midnight, logout after midnight)
      totalHours = (24 * 60 - loginMinutes + logoutMinutes) / 60;
    }

    // Update session
    session.logoutTime = new Date();
    session.active = false;
    session.actualLogoutTime = currentShiftTime;
    session.totalHours = parseFloat(totalHours.toFixed(2));
    
    // Check for half-day based on total hours OR if login was after 6 PM
    const expectedHours = shift.isHourly ? 8 : calculateTotalHours(shift.start, shift.end);
    
    // If login was after 6 PM or total hours less than half of expected
    if (session.isLoginAfter6PM || totalHours < (expectedHours / 2)) {
      session.status = "half-day";
    }
    
    await session.save();

    const response = {
      status: "success",
      message: "Logged out successfully",
      logoutTime: currentShiftTime,
      totalHours: parseFloat(totalHours.toFixed(2)),
      sessionId: session._id,
      attendanceStatus: session.status,
      isLoginAfter6PM: session.isLoginAfter6PM
    };

    if (earlyLogoutWarning) {
      response.warning = earlyLogoutWarning;
      response.canLoginAgain = false;
      response.earlyLogout = true;
    } else {
      response.canLoginAgain = shift.allowMultipleShifts;
      response.earlyLogout = false;
    }

    return res.json(response);
  } catch (err) {
    console.error("Logout error:", err);
    return res.status(500).json({ error: "Server error during logout" });
  }
});

// ---------------------
// 4️⃣ GET TODAY'S SESSION STATUS
// ---------------------
router.get("/session/today", requireAuth, async (req, res) => {
  try {
    const emp = req.employee;
    const shift = await getEmployeeShift(emp._id || emp.id);
    
    if (!shift) {
      return res.status(400).json({ error: "Shift not found" });
    }

    const today = getShiftDate(shift.timezone);
    const session = await EmployeeSession.findOne({
      employeeId: emp._id || emp.id,
      date: today
    });

    if (!session) {
      return res.json({ 
        hasSession: false, 
        message: "No session for today" 
      });
    }

    return res.json({
      hasSession: true,
      session: {
        id: session._id,
        loginTime: session.loginTime,
        logoutTime: session.logoutTime,
        actualLoginTime: session.actualLoginTime,
        actualLogoutTime: session.actualLogoutTime,
        status: session.status,
        totalHours: session.totalHours,
        active: session.active,
        shiftName: session.shiftName,
        shiftStart: session.shiftStartTime,
        shiftEnd: session.shiftEndTime,
        isAutoLogout: session.isAutoLogout,
        isLoginAfter6PM: session.isLoginAfter6PM
      }
    });
  } catch (err) {
    console.error("Get session error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ---------------------
// 5️⃣ GET EMPLOYEE PROFILE
// ---------------------
router.get("/me", requireAuth, authCtrl.getMe);

// ---------------------
// 6️⃣ Get Employee's Attendance Logs
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

// ---------------------
// 7️⃣ Get All Sessions (Admin Endpoint)
// ---------------------
router.get("/all-sessions", async (req, res) => {
  try {
    const sessions = await EmployeeSession.find()
      .populate("employeeId", "name companyEmail role")
      .populate("shiftId", "name start end")
      .sort({ loginTime: -1 });

    const formatted = sessions.map((s) => ({
      id: s._id,
      employeeName: s.employeeId?.name || "Unknown",
      employeeEmail: s.employeeId?.companyEmail || "N/A",
      role: s.employeeId?.role || "N/A",
      loginTime: s.loginTime,
      logoutTime: s.logoutTime,
      active: s.active,
      deviceFingerprint: s.deviceFingerprint,
      date: s.date,
      shiftName: s.shiftId?.name || "N/A",
      shiftTime: s.shiftId ? `${s.shiftId.start} - ${s.shiftId.end}` : "N/A",
      actualLoginTime: s.actualLoginTime,
      actualLogoutTime: s.actualLogoutTime,
      totalHours: s.totalHours,
      status: s.status,
      isAutoLogout: s.isAutoLogout,
      isLoginAfter6PM: s.isLoginAfter6PM
    }));

    res.json({ sessions: formatted });
  } catch (err) {
    console.error("Error fetching sessions:", err);
    res.status(500).json({ error: "Server error while fetching sessions" });
  }
});

// ---------------------
// 8️⃣ FORCE LOGOUT (for admin or when user has duplicate session)
// ---------------------
router.post("/force-logout", requireAuth, async (req, res) => {
  try {
    const emp = req.employee;
    const { sessionId } = req.body;
    
    const session = await EmployeeSession.findOne({
      _id: sessionId,
      employeeId: emp._id || emp.id
    });

    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }

    session.logoutTime = new Date();
    session.active = false;
    session.isAutoLogout = true;
    await session.save();

    return res.json({
      status: "success",
      message: "Session force logged out successfully"
    });
  } catch (err) {
    console.error("Force logout error:", err);
    return res.status(500).json({ error: "Server error during force logout" });
  }
});

// ---------------------
// 9️⃣ CHECK IF CAN LOGIN AGAIN (Frontend can call this)
// ---------------------
router.get("/can-login-again", requireAuth, async (req, res) => {
  try {
    const emp = req.employee;
    const shift = await getEmployeeShift(emp._id || emp.id);
    
    if (!shift) {
      return res.status(400).json({ error: "Shift not found" });
    }

    const currentShiftTime = getShiftTime(shift.timezone);
    const currentShiftDate = getShiftDate(shift.timezone);
    
    // Check if employee has any session today
    const existingSession = await EmployeeSession.findOne({
      employeeId: emp._id || emp.id,
      date: currentShiftDate
    });

    let canLoginAgain = true;
    let reason = "";
    
    if (existingSession) {
      if (existingSession.active) {
        canLoginAgain = false;
        reason = "You already have an active session. Please logout first.";
      } else {
        // Check shift timing
        const currentMinutes = timeToMinutes(currentShiftTime);
        const shiftEndMinutes = timeToMinutes(shift.end);
        
        if (shiftEndMinutes < timeToMinutes("12:00")) { // Night shift
          const nextDayShiftEnd = shiftEndMinutes + (24 * 60);
          if (currentMinutes < nextDayShiftEnd) {
            canLoginAgain = shift.allowMultipleShifts;
            if (!canLoginAgain) {
              reason = "Multiple shifts not allowed for night shift.";
            }
          } else {
            canLoginAgain = true; // Shift has ended, can login for next day
          }
        } else {
          // Regular day shift
          if (currentMinutes < shiftEndMinutes) {
            canLoginAgain = shift.allowMultipleShifts;
            if (!canLoginAgain) {
              reason = "Multiple shifts not allowed for this shift.";
            }
          } else {
            canLoginAgain = true; // Shift has ended
          }
        }
      }
    }

    return res.json({
      canLoginAgain,
      reason: reason || (canLoginAgain ? "You can login." : "Cannot login."),
      shiftEnd: shift.end,
      currentTime: currentShiftTime,
      allowMultipleShifts: shift.allowMultipleShifts
    });
  } catch (err) {
    console.error("Check login error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;