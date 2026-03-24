const express = require("express");
const jwt = require("jsonwebtoken");
const nodemailer = require("nodemailer");
const crypto = require("crypto");
const Employee = require("../models/Employees");
const Shift = require("../models/Shift");
const Attendance = require("../models/Attendance");
const AttendanceLog = require("../models/AttendanceLog");
const EmployeeSession = require("../models/EmployeeSession");
const requireAuth = require("../middleware/empAuth");
const authCtrl = require("../controllers/empAuthController");
const ClientInfo = require("../models/ClientInfo");
const EmployeeHierarchy = require("../models/EmployeeHierarchy");
const moment = require("moment-timezone"); // Add this package: npm install moment-timezone
const { processIfLastDayOfPeriod, applyRealTimeLateDeduction, applyRealTimeHalfDayDeduction, reverseHalfDayDeduction, reverseLateDayDeduction } = require("../utils/lateDeductions");
const { applyRealTimeLogoutBonus } = require("../utils/bonusService");

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
const GRACE_PERIOD_MINUTES = 0;
const HALF_DAY_THRESHOLD_HOUR = 18; // 6:00 PM
const LOGIN_RESTRICTION_END_HOUR = 8; // 8:00 AM
const HALF_DAY_LOGOUT_THRESHOLD_HOUR = 21; // 9:00 PM
const TOKEN_EXPIRY_SECONDS = 9 * 60 * 60; // 9 hours

/**
 * Convert time string HH:mm to total minutes since midnight
 */
function timeToMinutes(timeStr) {
  if (!timeStr) return null;
  const [h, m] = String(timeStr).trim().split(":").map(Number);
  if (isNaN(h) || isNaN(m)) return null;
  return h * 60 + m;
}

/**
 * Get reporting time from shift
 * Returns minutes since midnight, or fallback value
 */
async function getReportingTimeFromShift(employeeId, defaultMinutes = 15 * 60 + 30) {
  try {
    const emp = await Employee.findById(employeeId).select("shifts").lean();
    if (!emp || !emp.shifts || emp.shifts.length === 0) {
      return defaultMinutes;
    }

    const shift = await Shift.findById(emp.shifts[0]).select("start").lean();
    if (!shift || !shift.start) {
      return defaultMinutes;
    }

    const reportingTime = timeToMinutes(shift.start);
    return reportingTime !== null ? reportingTime : defaultMinutes;
  } catch (err) {
    console.error("[SHIFT-LOOKUP] Error getting reporting time:", err);
    return defaultMinutes;
  }
}

/**
 * Get shift details for employee
 */
async function getEmployeeShift(employeeId) {
  try {
    const emp = await Employee.findById(employeeId).select("shifts").lean();
    if (!emp || !emp.shifts || emp.shifts.length === 0) {
      return null;
    }

    return await Shift.findById(emp.shifts[0]).lean();
  } catch (err) {
    console.error("[SHIFT-LOOKUP] Error getting employee shift:", err);
    return null;
  }
}

// Helper function to get current time in Karachi
function getKarachiTime(dateStr = null) {
  if (dateStr) {
    // If a date string is provided (e.g. "2026-03-10"), use it as the base
    // but keep it in the Karachi timezone.
    return moment.tz(dateStr, TIMEZONE);
  }
  return moment().tz(TIMEZONE);
}

function formatTimeForDisplay(date) {
  return moment(date).tz(TIMEZONE).format("YYYY-MM-DD HH:mm:ss");
}

function formatTimeForStorage(date) {
  return moment(date).tz(TIMEZONE).format("YYYY-MM-DD HH:mm");
}

function formatTimeOnly(date) {
  return moment(date).tz(TIMEZONE).format("HH:mm");
}

function getDateOnly(date) {
  return moment(date).tz(TIMEZONE).format("YYYY-MM-DD");
}

/**
 * Calculate minutes between two time strings (HH:mm format)
 * Handles wrap-around at midnight (e.g., 23:00 to 02:00)
 */
function calculateMinutesBetween(startTimeStr, endTimeStr) {
  const startMinutes = timeToMinutes(startTimeStr);
  const endMinutes = timeToMinutes(endTimeStr);

  if (startMinutes === null || endMinutes === null) return 0;

  if (endMinutes >= startMinutes) {
    return endMinutes - startMinutes;
  } else {
    // Wrap around midnight (next day)
    return (24 * 60) - startMinutes + endMinutes;
  }
}

function secondsUntilMidnight() {
  const now = moment().tz(TIMEZONE);
  const midnight = moment().tz(TIMEZONE).endOf("day").add(1, "second");
  return Math.max(midnight.diff(now, "seconds"), 60);
}

/**
 * Helper to handle attendance creation or session restoration.
 * Used in both /login (for trusted devices) and /confirm-code.
 */
async function performAttendanceLogic(emp, nowKarachi, deviceFingerprint) {
  const todayKarachi = getDateOnly(nowKarachi);
  const currentTime = nowKarachi.hours() * 60 + nowKarachi.minutes();

  let existingAttendance = await Attendance.findOne({
    employee: emp._id,
    date: todayKarachi
  });

  // RESTORE SESSION (RE-LOGIN)
  if (existingAttendance && existingAttendance.checkOut) {
    console.log(`🔄 [RESTORE] ${emp.name} has existing checkout, restoring session...`);

    let statusToRestore = existingAttendance.originalStatus;
    if (!statusToRestore) {
      const checkInMinutes = timeToMinutes(existingAttendance.checkIn);
      const reportingTime = emp.rt ? timeToMinutes(emp.rt) : (await getReportingTimeFromShift(emp._id));
      const graceEnd = reportingTime + GRACE_PERIOD_MINUTES;
      const halfDayThreshold = HALF_DAY_THRESHOLD_HOUR * 60;

      if (checkInMinutes <= graceEnd) statusToRestore = "Present";
      else if (checkInMinutes < halfDayThreshold) statusToRestore = "Late";
      else statusToRestore = "Half Day";
    }

    await Attendance.findByIdAndUpdate(existingAttendance._id, {
      $unset: { checkOut: 1, logoutTime: 1, originalStatus: 1 },
      $set: { status: statusToRestore, totalHours: 0 }
    });

    if (existingAttendance.status === "Half Day" && statusToRestore !== "Half Day") {
      try {
        await reverseHalfDayDeduction(emp._id, emp.owner, emp._id, todayKarachi);
      } catch (err) {
        console.error(`[RESTORE] Error reversing half-day deduction:`, err);
      }
    }

    try {
      const empShiftForLog = await getEmployeeShift(emp._id);
      if (empShiftForLog) {
        await AttendanceLog.create({
          owner: emp.owner,
          employee: emp._id,
          date: todayKarachi,
          firstShiftId: existingAttendance.shiftId,
          firstShiftName: existingAttendance.shiftName,
          firstShiftStart: existingAttendance.shiftStartTime,
          firstShiftEnd: existingAttendance.shiftEndTime,
          firstCheckIn: existingAttendance.checkIn,
          firstCheckOut: existingAttendance.checkOut,
          firstLogoutTime: existingAttendance.logoutTime,
          secondShiftId: empShiftForLog._id,
          secondShiftName: empShiftForLog.name,
          secondShiftStart: empShiftForLog.start,
          secondCheckIn: formatTimeOnly(nowKarachi),
          secondLoginTime: nowKarachi.utc().toDate(),
          betweenShiftDuration: calculateMinutesBetween(existingAttendance.checkOut, formatTimeOnly(nowKarachi)),
          status: 'logged'
        });
      }
    } catch (logErr) {
      console.error(`[RESTORE] Error creating between-shift log:`, logErr);
    }

    const freshAttendance = await Attendance.findById(existingAttendance._id).lean();
    return { attendance: freshAttendance, sessionStatus: freshAttendance.status, attendanceExists: true };
  }

  // CREATE NEW ATTENDANCE
  if (!existingAttendance) {
    const empShift = await getEmployeeShift(emp._id);
    const reportingTimeMinutes = emp.rt
      ? timeToMinutes(emp.rt)
      : (empShift && empShift.start ? timeToMinutes(empShift.start) : (15 * 60 + 30));

    const gracePeriodEnd = reportingTimeMinutes + GRACE_PERIOD_MINUTES;
    const halfDayThreshold = HALF_DAY_THRESHOLD_HOUR * 60;

    let sessionStatus = "Present";
    let isLoginAfter6PM = false;

    if (currentTime <= gracePeriodEnd) {
      sessionStatus = "Present";
    } else if (currentTime < halfDayThreshold) {
      sessionStatus = "Late";
    } else {
      sessionStatus = "Half Day";
      isLoginAfter6PM = true;
    }

    const actualLoginTime = formatTimeOnly(nowKarachi);
    const loginTimeUTC = nowKarachi.utc().toDate();

    const attendance = await Attendance.create({
      employee: emp._id,
      owner: emp.owner,
      date: todayKarachi,
      status: sessionStatus,
      checkIn: actualLoginTime,
      loginTime: loginTimeUTC,
      deviceFingerprint,
      active: true,
      shiftId: empShift?._id || null,
      shiftName: empShift?.name || "Default Shift",
      shiftStartTime: empShift?.start || "15:30",
      shiftEndTime: empShift?.end || "00:00",
      timezone: TIMEZONE,
      isLoginAfter6PM,
      markedByHR: false
    });

    if (sessionStatus === "Late") {
      await applyRealTimeLateDeduction(emp._id, emp.owner, emp._id, todayKarachi);
    } else if (sessionStatus === "Half Day") {
      await applyRealTimeHalfDayDeduction(emp._id, emp.owner, emp._id, todayKarachi, attendance._id);
    }

    return { attendance, sessionStatus, attendanceExists: false };
  }

  return { attendance: existingAttendance, sessionStatus: existingAttendance.status, attendanceExists: true };
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

/**
 * Automatically ensures supervision for relevant clients.
 * 1. Current user supervises their juniors' clients.
 * 2. Seniors supervise current user's clients.
 */
async function syncSupervision(employeeId, ownerId) {
  try {
    const meId = employeeId;

    // if the user is a manager/team lead they automatically supervise every
    // client in the org; perform this before any other logic and then return.
    const meEmp = await Employee.findById(meId).select("role").lean();
    const roleStr = (meEmp?.role || "").toLowerCase();
    const isManager = roleStr === "manager";
    const isTeamLead = roleStr === "team lead" || roleStr === "team_lead";
    if (isManager || isTeamLead) {
      await ClientInfo.updateMany(
        { owner: ownerId },
        {
          $addToSet: { supervisedBy: meId },
          $set: { supervision: "needs_approval" }
        }
      );
      console.log(`[Supervision Sync] ${meId} is manager/teamlead; supervising all clients`);
      return;
    }

    // compute regex that matches any hierarchy link whose path contains meId
    const pathRegex = new RegExp(`(^|\\.)${meId}(\\.|$)`);

    // Part A1: Always supervise any clients assigned to *me* personally.
    // This makes the global "supervise all assigned clients" checkbox display
    // correctly on initial login even if the user has never toggled anything.
    await ClientInfo.updateMany(
      { owner: ownerId, assignedTo: meId },
      {
        $addToSet: { supervisedBy: meId },
        $set: { supervision: "needs_approval" }
      }
    );

    // Part A2: Me as senior → supervise clients of any descendant junior where
    // the link itself has supervisionEnabled=true.  We intentionally look at all
    // levels of the tree so senior users automatically gain control over every
    // subordinate's clients without having to toggle each intermediate branch.
    // grab all descendant links; seniors should supervise every client
    // in their subtree regardless of individual link flags
    const myJuniorsLinks = await EmployeeHierarchy.find({
      owner: ownerId,
      path: pathRegex
    }).select("junior");

    // collect ids from hierarchy
    let juniorIds = [...new Set(myJuniorsLinks.map(h => String(h.junior)))];

    // also pull direct reports from employees collection in case hierarchy isn't populated
    const directJuniors = await Employee.find({ owner: ownerId, supervisor: meId }).select("_id").lean();
    const directIds = directJuniors.map(e => String(e._id));
    juniorIds = [...new Set([...juniorIds, ...directIds])];

    if (juniorIds.length) {
      const juniorObjIds = juniorIds.map(id => new mongoose.Types.ObjectId(id));
      await ClientInfo.updateMany(
        { owner: ownerId, assignedTo: { $in: juniorObjIds } },
        {
          $addToSet: { supervisedBy: meId },
          $set: { supervision: "needs_approval" }
        }
      );
      console.log(
        `[Supervision Sync] Added me (${meId}) as supervisor for clients of juniors: ${juniorIds}`
      );
    }

    // Part B: My seniors (possibly multiple levels up) should supervise any
    // clients assigned to me.  We use a similar regex to grab all ancestor
    // links -- their senior field yields the supervisor ids.
    // only include ancestors for which supervisionEnabled flag is set
    const mySeniorLinks = await EmployeeHierarchy.find({
      owner: ownerId,
      path: pathRegex,
      supervisionEnabled: true
    }).select("senior");

    if (mySeniorLinks.length > 0) {
      const seniorIds = [...new Set(mySeniorLinks.map(h => String(h.senior)))];
      if (seniorIds.length) {
        await ClientInfo.updateMany(
          { owner: ownerId, assignedTo: meId },
          {
            $addToSet: { supervisedBy: { $each: seniorIds } },
            $set: { supervision: "needs_approval" }
          }
        );
        console.log(
          `[Supervision Sync] Added seniors (${seniorIds}) for my (${meId}) clients`
        );
      }
    }
  } catch (err) {
    console.error("[Supervision Sync Error]", err);
  }
}

const codes = new Map();

router.post("/login", async (req, res) => {
  const { companyEmail, password, deviceFingerprint, deviceToken, testDate } = req.body;

  try {
    // Get current time in Karachi (allow override for testing)
    const nowKarachi = getKarachiTime(testDate);
    const hours = nowKarachi.hours();
    const minutes = nowKarachi.minutes();
    const currentTime = hours * 60 + minutes;

    // Get date in Karachi timezone
    const todayKarachi = getDateOnly(nowKarachi);

    // ⚠️ TIME RESTRICTION: No login between 12 AM - 8 AM Karachi time
    const isRestrictedTime = currentTime >= 0 && currentTime < (LOGIN_RESTRICTION_END_HOUR * 60);

    const emp = await Employee.findOne({ companyEmail }).select(
      "_id companyEmail password role owner name trustedDevices department status rt shifts"
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

      // even during restricted hours we still want supervision metadata up-to-date
      await syncSupervision(emp._id, emp.owner).catch(e => console.error("syncSupervision error (restricted)", e));

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

    // ---------------------------------------------------------
    // 1. Identify current/potential status (READ ONLY)
    // ---------------------------------------------------------
    // We check this here to provide accurate info in the verification email
    // but we DO NOT commit any changes to the database yet if the device is untrusted.
    let existingAttendance = await Attendance.findOne({
      employee: emp._id,
      date: todayKarachi
    });

    let sessionStatus = "Present";
    if (existingAttendance) {
      if (existingAttendance.checkOut) {
        // Predicted restore status
        sessionStatus = existingAttendance.originalStatus;
        if (!sessionStatus) {
          const checkInMinutes = timeToMinutes(existingAttendance.checkIn);
          const reportingTime = emp.rt ? timeToMinutes(emp.rt) : (await getReportingTimeFromShift(emp._id));
          const graceEnd = reportingTime + GRACE_PERIOD_MINUTES;
          const halfDayThreshold = HALF_DAY_THRESHOLD_HOUR * 60;
          if (checkInMinutes <= graceEnd) sessionStatus = "Present";
          else if (checkInMinutes < halfDayThreshold) sessionStatus = "Late";
          else sessionStatus = "Half Day";
        }
      } else {
        sessionStatus = existingAttendance.status;
      }
    } else {
      // Calculate potential status for new attendance
      const empShift = await getEmployeeShift(emp._id);
      const rtMinutes = emp.rt ? timeToMinutes(emp.rt) : (empShift?.start ? timeToMinutes(empShift.start) : (15 * 60 + 30));
      const graceEnd = rtMinutes + GRACE_PERIOD_MINUTES;
      const halfDayThreshold = HALF_DAY_THRESHOLD_HOUR * 60;
      if (currentTime <= graceEnd) sessionStatus = "Present";
      else if (currentTime < halfDayThreshold) sessionStatus = "Late";
      else sessionStatus = "Half Day";
    }

    // CHECK IF DEVICE IS TRUSTED
    const isTrusted = emp.trustedDevices?.some(
      (d) =>
        deviceFingerprint &&
        deviceToken &&
        d.deviceFingerprint === deviceFingerprint &&
        d.deviceId === deviceToken
    );

    if (isTrusted) {
      // PERFORM ATTENDANCE LOGIC (Create or Restore)
      const attendanceResult = await performAttendanceLogic(emp, nowKarachi, deviceFingerprint);
      const attendance = attendanceResult.attendance;
      sessionStatus = attendanceResult.sessionStatus;

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

      // 🔥 Auto-enable supervision on login (trusted device)
      await syncSupervision(emp._id, emp.owner).catch(e => console.error("syncSupervision error (trusted)", e));

      // ✅ Enterprise Cleanup: Deactivate any orphaned sessions before starting fresh
      await EmployeeSession.updateMany(
        { employeeId: emp._id, active: true },
        { active: false, isAutoLogout: true }
      );

      // ✅ Ensure an active EmployeeSession exists
      await EmployeeSession.findOneAndUpdate(
        { employeeId: emp._id, date: todayKarachi },
        { active: true, isAutoLogout: false, loginTime: nowKarachi.toDate() },
        { upsert: true, new: true }
      );

      return res.json({
        message: attendanceResult.attendanceExists ?
          "Login successful (attendance already marked)." :
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
        attendanceId: attendance?._id,
        sessionStatus: sessionStatus,
        attendanceExists: attendanceResult.attendanceExists,
        trusted: true,
        expiresIn: 9 * 60 * 60,
        localLoginTime: formatTimeForDisplay(nowKarachi),
      });
    }

    // 2FA (UNRECOGNIZED DEVICE)
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expires = Date.now() + 10 * 60 * 1000;
    codes.set(emp._id.toString(), { code, expires, deviceFingerprint });

    const tempToken = jwt.sign({ id: emp._id }, JWT_SECRET, {
      expiresIn: "10m",
    });

    await syncSupervision(emp._id, emp.owner).catch(e => console.error("syncSupervision error (untrusted)", e));

    const loginIp =
      req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
      req.ip ||
      "unknown";
    const when = formatTimeForDisplay(nowKarachi);

    await sendMail({
      to: "abdullahahmedqureshint@gmail.com",
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
      attendanceId: null, // No attendance record yet for unrecognized devices
      sessionStatus: sessionStatus,
      attendanceExists: !!existingAttendance,
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
      "_id companyEmail role owner name trustedDevices rt shifts"
    );

    const userAgent = req.headers["user-agent"] || "unknown";
    const ip =
      req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
      req.ip ||
      "unknown";

    const deviceIndex = emp.trustedDevices.findIndex(
      (d) => d.deviceFingerprint === deviceFingerprint
    );

    let deviceId;
    if (deviceIndex > -1) {
      // ✅ Device fingerprint already known — KEEP the existing deviceId so the
      // browser cookie stays valid. Only refresh metadata (IP, userAgent).
      deviceId = emp.trustedDevices[deviceIndex].deviceId;
      emp.trustedDevices[deviceIndex].userAgent = userAgent;
      emp.trustedDevices[deviceIndex].ip = ip;
      emp.trustedDevices[deviceIndex].addedAt = new Date();
    } else {
      // 🆕 Brand new device — generate a fresh permanent token
      deviceId = crypto.randomBytes(32).toString("hex");
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

    // 🔥 Auto-enable supervision on code confirmation
    await syncSupervision(emp._id, emp.owner);

    // Get Karachi time for session logging
    const nowKarachi = getKarachiTime();
    const todayKarachi = getDateOnly(nowKarachi);

    // PERFORM ATTENDANCE LOGIC (Create or Restore) on confirmation
    const attendanceResult = await performAttendanceLogic(emp, nowKarachi, deviceFingerprint);
    const attendance = attendanceResult.attendance;

    // ✅ Enterprise Cleanup: Deactivate any orphaned sessions before starting fresh
    await EmployeeSession.updateMany(
      { employeeId: emp._id, active: true },
      { active: false, isAutoLogout: true }
    );

    // ✅ Ensure an active EmployeeSession exists
    await EmployeeSession.findOneAndUpdate(
      { employeeId: emp._id, date: todayKarachi },
      { active: true, isAutoLogout: false, loginTime: nowKarachi.toDate() },
      { upsert: true, new: true }
    );

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
      attendanceId: attendance?._id,
      sessionStatus: attendance?.status,
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
    const employeeId = req.employee._id || req.employee.id;
    const ownerId = req.employee.owner || req.employee.createdBy;
    const userId = req.user?._id || req.employee._id;

    const { testDate, isAutoLogout: bodyAutoLogout } = req.body;
    const { isAutoLogout: queryAutoLogout } = req.query;
    const isAutoLogout = bodyAutoLogout || queryAutoLogout === 'true' || queryAutoLogout === true;

    // Get current time in Karachi (allow override for testing)
    const nowKarachi = getKarachiTime(testDate);
    const logoutHour = nowKarachi.hours();
    const logoutMinute = nowKarachi.minutes();
    const logoutTotalMinutes = logoutHour * 60 + logoutMinute;
    const todayKarachi = getDateOnly(nowKarachi);

    const halfDayLogoutThreshold = HALF_DAY_LOGOUT_THRESHOLD_HOUR * 60; // 9:00 PM Karachi time

    // ✅ FIND ATTENDANCE RECORD - Most recent if today not found (cross-midnight fix)
    let attendance = await Attendance.findOne({
      employee: employeeId,
      date: todayKarachi
    });

    if (!attendance) {
      // Look for the most recent check-in that doesn't have a check-out yet
      attendance = await Attendance.findOne({
        employee: employeeId,
        checkOut: { $exists: false }
      }).sort({ createdAt: -1 });
    }

    if (!attendance) {
      // Fallback: Just get the last record even if it has a checkout (for manual re-logouts)
      attendance = await Attendance.findOne({
        employee: employeeId
      }).sort({ createdAt: -1 });
    }

    if (!attendance) {
      console.warn(`[LOGOUT] No attendance found for ${employeeId}`);
      return res.status(400).json({
        error: "No attendance record found to log out"
      });
    }

    const attendanceDate = attendance.date; // The day they actually logged in (important)

    let finalStatus = attendance.status;
    // Save a snapshot of the current status before we potentially change it.
    // This is used by /reactivate-session to restore the correct status on refresh.
    const originalStatusBeforeLogout = attendance.status;

    // ─────────────────────────────────────────────────────────────────────────
    // HALF-DAY RULE:
    // Only mark as Half Day if the employee left early (before shift end) AND
    // the logout is on the SAME calendar date as the attendance date.
    //
    // Cases where we KEEP the original status (no Half Day):
    //   1. Logout date ≠ attendance date  → employee worked past midnight (night shift)
    //   2. Logout time ≥ shift end time   → employee completed their shift
    // ─────────────────────────────────────────────────────────────────────────

    // Get shift end time for this employee (to determine if shift is complete)
    let shiftEndMinutes = null;
    try {
      const empForShift = await Employee.findById(employeeId).select("shifts").lean();
      if (empForShift && empForShift.shifts && empForShift.shifts.length > 0) {
        const shiftDoc = await Shift.findById(empForShift.shifts[0]).select("end").lean();
        if (shiftDoc && shiftDoc.end) {
          shiftEndMinutes = timeToMinutes(shiftDoc.end);
        }
      }
    } catch (shiftErr) {
      console.error("[LOGOUT] Error fetching shift end time:", shiftErr);
    }

    // Case 1: Cross-midnight logout — logout date is different from check-in date
    const isCrossMidnightLogout = todayKarachi !== attendanceDate;

    // Case 2: Logout at/after shift end time (shift completed) OR after 9:00 PM Karachi time
    // If shiftEndMinutes is 0 or null (midnight/unset), treat midnight logout as shift complete
    let isShiftComplete = false;

    // 🔥 Universal Rule: If employee stays until 9:00 PM, they are NOT marked as Half Day
    const stayedUntil9PM = logoutTotalMinutes >= halfDayLogoutThreshold;

    if (shiftEndMinutes === null) {
      // No shift configured — use the 9:00 PM threshold
      isShiftComplete = stayedUntil9PM;
    } else if (shiftEndMinutes === 0) {
      // Shift ends at midnight (00:00)
      // Safe if: Cross-midnight OR exactly midnight OR stayed until 9 PM
      isShiftComplete = isCrossMidnightLogout || logoutTotalMinutes === 0 || stayedUntil9PM;
    } else {
      // Normal shift end: logout >= shift end time OR stayed until 9 PM
      isShiftComplete = (logoutTotalMinutes >= shiftEndMinutes) || stayedUntil9PM;
    }

    if (isCrossMidnightLogout) {
      // Employee worked past midnight into the next day — keep original status
      console.log(`[LOGOUT] Cross-midnight logout detected (attendance: ${attendanceDate}, logout date: ${todayKarachi}). Keeping original status: ${finalStatus}`);
    } else if (isShiftComplete) {
      // Logout is at or after shift end time (or after 9 PM threshold) — shift was completed
      console.log(`[LOGOUT] Shift completed or stayed until 9 PM (logoutTime=${logoutTotalMinutes}min, shiftEnd=${shiftEndMinutes ?? halfDayLogoutThreshold}min). Keeping status: ${finalStatus}`);
    } else {
      // Employee left early on the same day AND before 9 PM — apply Half Day rule
      finalStatus = "Half Day";
      console.log(`[LOGOUT] Early logout before 9 PM (logoutTime=${logoutTotalMinutes}min, shiftEnd=${shiftEndMinutes ?? halfDayLogoutThreshold}min). Status → Half Day`);
    }

    // Calculate total hours worked
    const loginTimeKarachi = attendance.loginTime ? moment(attendance.loginTime).tz(TIMEZONE) : null;
    const totalHours = loginTimeKarachi ? nowKarachi.diff(loginTimeKarachi, 'hours', true) : 0;

    // Log attendance info
    const emp = await Employee.findById(employeeId).select("name").lean();
    const autoLogoutIndicator = isAutoLogout ? "🔴 [AUTO-LOGOUT] " : "[MANUAL-LOGOUT] ";
    console.log(
      `${autoLogoutIndicator}[${emp?.name || 'Unknown'}] Status=${finalStatus}, CheckIn=${attendance.checkIn}, CheckOut=${formatTimeOnly(nowKarachi)}, TotalHours=${parseFloat(totalHours.toFixed(2))}`
    );

    // Update attendance with check-out time
    const logoutTimeUTC = nowKarachi.utc().toDate();
    const actualLogoutTime = formatTimeOnly(nowKarachi);

    let updated = null;
    try {
      updated = await Attendance.findByIdAndUpdate(
        attendance._id,
        {
          logoutTime: logoutTimeUTC,
          checkOut: actualLogoutTime,
          status: finalStatus,
          totalHours: parseFloat(totalHours.toFixed(2)),
          // ✅ Store the status that was set BEFORE the logout status calculation.
          // Reactivation uses this to restore the correct status on page refresh.
          originalStatus: originalStatusBeforeLogout
        },
        { new: true }
      );

      if (!updated) {
        console.error(
          `[ERROR-LOGOUT] Failed to update attendance record for ${employeeId}. Record not found after update.`
        );
        return res.status(500).json({ error: "Failed to save checkout time" });
      }

      console.log(
        `✅ [LOGOUT-SUCCESS] Attendance updated - ID: ${updated._id}, CheckOut: ${updated.checkOut}`
      );

      // Apply Half-Day deduction whenever status changes to Half Day on logout.
      // This includes browser close (isAutoLogout=true). If it turns out the user
      // was just refreshing, the /reactivate-session endpoint will reverse it.
      if (finalStatus === "Half Day" && attendance.status !== "Half Day") {
        console.log(`[LOGOUT-DEDUCTION] Triggering Real-time Half-Day deduction for ${employeeId} (AutoLogout: ${isAutoLogout})`);
        try {
          // ✅ Skip real-time deduction if it's an auto-logout (beacon).
          // This avoids deducting on refresh/close. It will be handled by cron or reactivation.
          if (!isAutoLogout) {
            // Use attendanceDate (login date) — not todayKarachi — for cross-midnight correctness
            await applyRealTimeHalfDayDeduction(employeeId, ownerId, userId, attendanceDate, attendance._id);
            console.log(`✅ [LOGOUT-DEDUCTION] Manual half-day deduction applied for ${employeeId} on ${attendanceDate}`);
          } else {
            console.log(`ℹ️ [LOGOUT-DEDUCTION] Skipping immediate deduction for auto-logout; will resolve on refresh/re-login or midnight.`);
          }
        } catch (derr) {
          console.error("[LOGOUT-DEDUCTION] Error applying half-day deduction:", derr);
        }
      }

      // isAutoLogout is set only if the request signaled it (beacon from refresh/close).
      const sessionUpdate = {
        active: false,
        logoutTime: logoutTimeUTC
      };

      if (isAutoLogout) {
        sessionUpdate.isAutoLogout = true;
      }

      await EmployeeSession.findOneAndUpdate(
        { employeeId, date: attendanceDate },
        sessionUpdate,
        { upsert: true, new: true }
      );
    } catch (uerr) {
      console.error("[LOGOUT-ERROR] Error updating attendance record:", uerr);
      return res.status(500).json({ error: "Failed to update attendance on logout" });
    }

    // ✅ PROCESS LATE DEDUCTIONS
    let lateDeductionResult = null;
    // ✅ SKIP for auto-logouts
    if (!isAutoLogout) {
      try {
        // Use attendanceDate so cross-midnight logouts process deductions for the login date
        lateDeductionResult = await processIfLastDayOfPeriod(
          new Date(attendanceDate),
          ownerId,
          employeeId,
          userId
        );
      } catch (err) {
        console.error("[LOGOUT] Error processing late deductions:", err);
      }
    }

    // ✅ PROCESS BONUS (Early Bird or Non-Working Day)
    let bonusResult = null;
    // ✅ SKIP for auto-logouts
    if (!isAutoLogout) {
      try {
        // Use attendanceDate so cross-midnight logouts credit bonus against the login date
        bonusResult = await applyRealTimeLogoutBonus(
          employeeId,
          ownerId,
          updated._id,
          attendanceDate
        );
      } catch (berr) {
        console.error("[LOGOUT] Error processing bonuses:", berr);
      }
    }

    return res.json({
      status: "success",
      message: "Logged out successfully",
      logoutTime: formatTimeForDisplay(nowKarachi),
      sessionStatus: updated ? updated.status : finalStatus,
      totalHours: updated ? updated.totalHours : parseFloat(totalHours.toFixed(2)),
      lateDeductionResult: lateDeductionResult || null,
      bonusResult: bonusResult || null
    });
  } catch (err) {
    console.error("Logout error:", err);
    return res.status(500).json({ error: "Server error during logout" });
  }
});

router.post("/reactivate-session", requireAuth, async (req, res) => {
  try {
    const employeeId = req.employee._id || req.employee.id;
    const nowKarachi = getKarachiTime();
    const todayKarachi = getDateOnly(nowKarachi);

    console.info(`🔄 [REACTIVATE-SESSION] Attempting to reactivate session for ${employeeId}`);

    // 1. First, check for an existing active session for today.
    // If it's already active, no need to do anything.
    let session = await EmployeeSession.findOne({
      employeeId,
      date: todayKarachi,
      active: true
    });

    if (session) {
      console.info(`🔄 [REACTIVATE-SESSION] Session already active for ${employeeId}`);
      return res.json({ status: "success", message: "Session already active" });
    }

    // 2. Look for any inactive session for today that can be reactivated.
    session = await EmployeeSession.findOne({
      employeeId,
      date: todayKarachi,
      active: false
    }).sort({ updatedAt: -1 });

    // 3. Fallback: most recent inactive session (any date) within 30s window
    if (!session) {
      session = await EmployeeSession.findOne({
        employeeId,
        active: false,
        isAutoLogout: true
      }).sort({ updatedAt: -1 });

      const diff = session ? (Date.now() - new Date(session.updatedAt).getTime()) : Infinity;
      if (!session || diff > 30000) {
        console.info(`🔄 [REACTIVATE-SESSION] No recent session to reactivate for ${employeeId}. Creating fresh for today.`);

        await EmployeeSession.findOneAndUpdate(
          { employeeId, date: todayKarachi },
          { active: true, isAutoLogout: false, loginTime: nowKarachi.toDate() },
          { upsert: true, new: true }
        );
        return res.json({ status: "success", message: "New session created" });
      }
    }

    console.info(`✅ [REACTIVATE-SESSION] Reactivating session for ${employeeId}`);

    // ✅ RESTORE ATTENDANCE RECORD
    const attendance = await Attendance.findOne({
      employee: employeeId,
      date: session.date || todayKarachi
    });

    if (attendance && attendance.checkOut) {
      const previousStatus = attendance.status;
      const statusToRestore = attendance.originalStatus || attendance.status;

      await Attendance.findByIdAndUpdate(attendance._id, {
        $unset: { logoutTime: 1, checkOut: 1, originalStatus: 1 },
        $set: { status: statusToRestore, totalHours: 0 }
      });

      const previousStatusLower = (previousStatus || "").toLowerCase().replace(/\s+/g, '-');
      const statusToRestoreLower = (statusToRestore || "").toLowerCase().replace(/\s+/g, '-');

      if (previousStatusLower === "half-day" && statusToRestoreLower !== "half-day") {
        try {
          const emp = await Employee.findById(employeeId).select("owner").lean();
          if (emp) {
            await reverseHalfDayDeduction(employeeId, emp.owner, employeeId, session.date || todayKarachi);
            console.info(`🔄 [REACTIVATE-SESSION] Half-day deduction reversed for ${employeeId}`);
          }
        } catch (derr) {
          console.error("[REACTIVATE-SESSION] Error reversing half-day deduction:", derr);
        }
      }

      console.info(`🔄 [REACTIVATE-SESSION] Attendance restored for ${employeeId}. Status: ${previousStatus} → ${statusToRestore}`);
    }

    // Re-activate session tracker
    session.active = true;
    session.isAutoLogout = false;
    await session.save();

    console.info(`✅ [REACTIVATE-SESSION] Session successfully reactivated for ${employeeId}`);
    return res.json({ status: "success", message: "Session reactivated" });
  } catch (err) {
    console.error("❌ [REACTIVATE-SESSION] Error:", err);
    return res.status(500).json({ error: "Server error during reactivation" });
  }
});

router.get("/me", requireAuth, authCtrl.getMe);

// ---------------------
// 4️⃣ Get Attendance Logs
// ---------------------
router.get("/sessions", requireAuth, async (req, res) => {
  try {
    // ✅ FETCH FROM ATTENDANCE INSTEAD OF EMPLOYEE SESSION
    const attendanceRecords = await Attendance.find({
      employee: req.employee._id,
    })
      .sort({ date: -1 })
      .limit(30);

    // Convert times to expected format for frontend
    const formattedSessions = attendanceRecords.map(record => ({
      ...record.toObject(),
      date: record.date, // YYYY-MM-DD
      status: record.status, // on-time, late, half-day, absent, leave
      actualLoginTime: record.checkIn, // HH:mm format
      actualLogoutTime: record.checkOut, // HH:mm format
      loginTime: record.loginTime, // UTC date
      logoutTime: record.logoutTime, // UTC date
      totalHours: record.totalHours || 0,
      active: record.active || false,
      loginTimeLocal: record.loginTime ? moment(record.loginTime).tz(TIMEZONE).format("YYYY-MM-DD HH:mm:ss") : null,
      logoutTimeLocal: record.logoutTime ?
        moment(record.logoutTime).tz(TIMEZONE).format("YYYY-MM-DD HH:mm:ss") : null,
    }));

    res.json({ sessions: formattedSessions });
  } catch (err) {
    console.error("Fetch attendance error:", err);
    res.status(500).json({ error: "Unable to fetch attendance records" });
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
