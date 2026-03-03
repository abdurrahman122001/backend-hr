const express = require("express");
const jwt = require("jsonwebtoken");
const nodemailer = require("nodemailer");
const crypto = require("crypto");
const Employee = require("../models/Employees");
const Shift = require("../models/Shift");
const Attendance = require("../models/Attendance");
const EmployeeSession = require("../models/EmployeeSession");
const requireAuth = require("../middleware/empAuth");
const authCtrl = require("../controllers/empAuthController");
const ClientInfo = require("../models/ClientInfo");
const EmployeeHierarchy = require("../models/EmployeeHierarchy");
const moment = require("moment-timezone"); // Add this package: npm install moment-timezone
const { processIfLastDayOfPeriod } = require("../utils/lateDeductions");

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
const GRACE_PERIOD_MINUTES = 15;
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
async function getReportingTimeFromShift(employeeId, defaultMinutes = 15 * 60 + 0) {
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
function getKarachiTime() {
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

    // CHECK FOR EXISTING ATTENDANCE TODAY (using Karachi date)
    let existingAttendance = await Attendance.findOne({
      employee: emp._id,
      date: todayKarachi // Use Karachi date
    });

    let attendance;
    let sessionStatus = "Present";
    let isLoginAfter6PM = false;

    // GET EMPLOYEE'S SHIFT AND REPORTING TIME
    const empShift = await getEmployeeShift(emp._id);
    // ✅ PRIORITY: Use Employee.rt field first, then fall back to shift.start
    const reportingTimeMinutes = emp.rt
      ? timeToMinutes(emp.rt)
      : (empShift && empShift.start
        ? timeToMinutes(empShift.start)
        : (15 * 60 + 30)); // Default 3:30 PM
    const shiftEndTimeMinutes = empShift && empShift.end
      ? timeToMinutes(empShift.end)
      : (0 * 60 + 0); // Default midnight

    // Store shift info for logging
    const shiftName = empShift?.name || "Default Shift";
    // ✅ Display reporting time from Employee.rt for consistency
    const reportingTimeStr = emp.rt || (empShift?.start || "15:30");
    const shiftStartTimeStr = empShift?.start || "15:30";
    const shiftEndTimeStr = empShift?.end || "00:00";

    // IF NO EXISTING ATTENDANCE → CREATE NEW ONE
    if (!existingAttendance) {
      // CALCULATE STATUS BASED ON KARACHI LOGIN TIME AND REPORTING TIME
      const loginTotalMinutes = currentTime;

      // Time thresholds in minutes since midnight (Karachi time)
      const officeStart = reportingTimeMinutes; // From employee's reporting time
      const gracePeriodEnd = officeStart + GRACE_PERIOD_MINUTES;
      const halfDayThreshold = HALF_DAY_THRESHOLD_HOUR * 60; // 6:00 PM (fixed)

      if (loginTotalMinutes <= gracePeriodEnd) {
        sessionStatus = "Present";
      } else if (loginTotalMinutes < halfDayThreshold) {
        sessionStatus = "Late";
      } else {
        sessionStatus = "Half Day";
        isLoginAfter6PM = true;
      }

      // Store times in Karachi timezone
      const actualLoginTime = formatTimeOnly(nowKarachi);
      const loginTimeUTC = nowKarachi.utc().toDate(); // Store UTC for consistent querying

      console.log(
        `[LOGIN] [${emp.name}] Status=${sessionStatus}, LoginTime=${actualLoginTime}, ReportingTime=${reportingTimeStr}, ShiftName=${shiftName}`
      );

      // ✅ CREATE NEW ATTENDANCE WITH CHECK-IN TIME
      attendance = await Attendance.create({
        employee: emp._id,
        owner: emp.owner,
        date: todayKarachi, // Store Karachi date YYYY-MM-DD
        status: sessionStatus, // Present, Late, Half Day
        checkIn: actualLoginTime, // Store formatted Karachi login time HH:mm
        loginTime: loginTimeUTC, // Store UTC for consistent querying
        deviceFingerprint,
        active: true,
        shiftId: empShift?._id || null,
        shiftName: shiftName,
        shiftStartTime: shiftStartTimeStr,
        shiftEndTime: shiftEndTimeStr,
        timezone: TIMEZONE, // Store timezone for reference
        isLoginAfter6PM: isLoginAfter6PM,
        markedByHR: false // System auto-marked
      });
    } else {
      // ✅ ATTENDANCE ALREADY EXISTS
      attendance = existingAttendance;
      sessionStatus = existingAttendance.status;
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

      // 🔥 Auto-enable supervision on login (trusted device)
      await syncSupervision(emp._id, emp.owner).catch(e => console.error("syncSupervision error (trusted)", e));

      return res.json({
        message: existingAttendance ?
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
        attendanceId: attendance._id,
        sessionStatus: sessionStatus,
        attendanceExists: !!existingAttendance,
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

    await syncSupervision(emp._id, emp.owner).catch(e => console.error("syncSupervision error (untrusted)", e));

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
      attendanceId: attendance?._id,
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

    // 🔥 Auto-enable supervision on code confirmation
    await syncSupervision(emp._id, emp.owner);

    // Get Karachi time for session logging
    const nowKarachi = getKarachiTime();
    const loginTimeUTC = nowKarachi.utc().toDate();
    const todayKarachi = getDateOnly(nowKarachi);
    const actualLoginTime = formatTimeOnly(nowKarachi);

    // Get employee's shift for this session
    const empShiftConfirm = await getEmployeeShift(emp._id);
    const shiftNameConfirm = empShiftConfirm?.name || "Default Shift";
    const shiftStartTimeStrConfirm = empShiftConfirm?.start || "15:00";
    const shiftEndTimeStrConfirm = empShiftConfirm?.end || "00:00";

    // Calculate status based on reporting time
    const reportingTimeMinutesConfirm = empShiftConfirm && empShiftConfirm.start
      ? timeToMinutes(empShiftConfirm.start)
      : (15 * 60 + 0);

    const currentHour = nowKarachi.hours();
    const currentMin = nowKarachi.minutes();
    const loginTotalMinutesConfirm = currentHour * 60 + currentMin;
    const gracePeriodEndConfirm = reportingTimeMinutesConfirm + GRACE_PERIOD_MINUTES;
    const halfDayThresholdConfirm = HALF_DAY_THRESHOLD_HOUR * 60;

    let statusConfirm = "Present";
    let isLoginAfter6PMConfirm = false;

    if (loginTotalMinutesConfirm > gracePeriodEndConfirm && loginTotalMinutesConfirm < halfDayThresholdConfirm) {
      statusConfirm = "Late";
    } else if (loginTotalMinutesConfirm >= halfDayThresholdConfirm) {
      statusConfirm = "Half Day";
      isLoginAfter6PMConfirm = true;
    }

    // Check for existing attendance to avoid duplicate key error
    let existingAttendanceConfirm = await Attendance.findOne({
      employee: emp._id,
      date: todayKarachi
    });

    if (!existingAttendanceConfirm) {
      await Attendance.create({
        employee: emp._id,
        owner: emp.owner,
        date: todayKarachi,
        status: statusConfirm,
        checkIn: actualLoginTime,
        loginTime: loginTimeUTC,
        deviceFingerprint,
        active: true,
        isLoginAfter6PM: isLoginAfter6PMConfirm,
        shiftId: empShiftConfirm?._id || null,
        shiftName: shiftNameConfirm,
        shiftStartTime: shiftStartTimeStrConfirm,
        shiftEndTime: shiftEndTimeStrConfirm,
        timezone: TIMEZONE,
        markedByHR: false
      });
    }

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
    const todayKarachi = getDateOnly(nowKarachi);

    const halfDayLogoutThreshold = HALF_DAY_LOGOUT_THRESHOLD_HOUR * 60; // 9:00 PM Karachi time

    // ✅ FIND ATTENDANCE RECORD FOR TODAY (try both active and non-active for robustness)
    let attendance = await Attendance.findOne({
      employee: req.employee.id || req.employee._id,
      date: todayKarachi,
      active: true
    });

    if (!attendance) {
      // Try without active filter to help debugging and recover stale records
      attendance = await Attendance.findOne({
        employee: req.employee.id || req.employee._id,
        date: todayKarachi,
      });
      if (!attendance) {
        return res.status(400).json({
          error: "No attendance record found for today"
        });
      }
    }

    let finalStatus = attendance.status;

    // If logged out before 9:00 PM Karachi time, change status to Half Day
    if (logoutTotalMinutes < halfDayLogoutThreshold) {
      finalStatus = "Half Day";
    }

    // Calculate total hours worked (convert loginTime from UTC to Karachi for calculation)
    const loginTimeKarachi = attendance.loginTime ? moment(attendance.loginTime).tz(TIMEZONE) : null;
    const totalHours = loginTimeKarachi ? nowKarachi.diff(loginTimeKarachi, 'hours', true) : 0;

    // Log attendance info
    const emp = await Employee.findById(req.employee._id || req.employee.id).select("name").lean();
    console.log(
      `[LOGOUT] [${emp?.name || 'Unknown'}] Status=${finalStatus}, CheckIn=${attendance.checkIn}, CheckOut=${formatTimeOnly(nowKarachi)}, TotalHours=${parseFloat(totalHours.toFixed(2))}, Shift=${attendance.shiftName}`
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
          checkOut: actualLogoutTime, // ✅ Store formatted Karachi logout time (HH:mm)
          active: false,
          status: finalStatus,
          totalHours: parseFloat(totalHours.toFixed(2)),
          isAutoLogout: req.body.isAutoLogout || false
        },
        { new: true }
      );
      console.log("[LOGOUT] Attendance updated:", { id: attendance._id, checkOut: actualLogoutTime, updatedId: updated?._id });
    } catch (uerr) {
      console.error("[LOGOUT] Error updating attendance record:", uerr);
      return res.status(500).json({ error: "Failed to update attendance on logout" });
    }

    // ✅ PROCESS LATE DEDUCTIONS (if last day of payroll period)
    const employeeId = req.employee._id || req.employee.id;
    const ownerId = req.employee.owner || req.employee.createdBy;
    const userId = req.user?._id || req.employee._id;

    let lateDeductionResult = null;
    try {
      lateDeductionResult = await processIfLastDayOfPeriod(
        new Date(todayKarachi),
        ownerId,
        employeeId,
        userId
      );
      if (lateDeductionResult && lateDeductionResult.processed) {
        console.log(`[LOGOUT] Late deduction processed:`, lateDeductionResult);
      }
    } catch (err) {
      console.error("[LOGOUT] Error processing late deductions:", err);
      // Continue with logout even if late deduction fails
    }

    return res.json({
      status: "success",
      message: "Logged out successfully",
      logoutTime: formatTimeForDisplay(nowKarachi),
      sessionStatus: updated ? updated.status : finalStatus,
      totalHours: updated ? updated.totalHours : parseFloat(totalHours.toFixed(2)),
      lateDeductionResult: lateDeductionResult || null
    });
  } catch (err) {
    console.error("Logout error:", err);
    return res.status(500).json({ error: "Server error during logout" });
  }
});

router.post("/reactivate-session", requireAuth, async (req, res) => {
  try {
    const employeeId = req.employee._id || req.employee.id;

    // Find the most recent session for this employee that was just closed via auto-logout
    const session = await EmployeeSession.findOne({
      employeeId,
      active: false,
      isAutoLogout: true
    }).sort({ updatedAt: -1 });

    if (!session) {
      return res.status(404).json({ error: "No recent auto-logout session to reactivate" });
    }

    // Only reactivate if it was closed very recently (e.g. the time it takes for a refresh)
    const diff = Date.now() - new Date(session.updatedAt).getTime();
    if (diff > 15000) { // 15 seconds should be plenty for any refresh
      return res.status(400).json({ error: "Reactivation window expired" });
    }

    // Re-activate
    session.active = true;
    session.logoutTime = undefined;
    session.actualLogoutTime = undefined;
    session.totalHours = 0;
    session.isAutoLogout = false;
    await session.save();

    return res.json({ status: "success", message: "Session reactivated" });
  } catch (err) {
    console.error("Reactivation error:", err);
    return res.status(500).json({ error: "Server error" });
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
