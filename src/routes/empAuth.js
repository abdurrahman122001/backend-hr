const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const nodemailer = require("nodemailer");
const crypto = require("crypto");
const Employee = require("../models/Employees");
const User = require("../models/Users");
const Shift = require("../models/Shift");
const Attendance = require("../models/Attendance");
const AttendanceLog = require("../models/AttendanceLog");
const EmployeeSession = require("../models/EmployeeSession");
const PayrollPeriod = require("../models/PayrollPeriod");
const AttendanceConfig = require("../models/AttendanceConfig");
const requireAuth = require("../middleware/empAuth");
const authCtrl = require("../controllers/empAuthController");
const ClientInfo = require("../models/ClientInfo");
const EmployeeHierarchy = require("../models/EmployeeHierarchy");
const SpecificNonWorkingDay = require("../models/SpecificNonWorkingDay");
const moment = require("moment-timezone"); // Add this package: npm install moment-timezone
const { processIfLastDayOfPeriod, applyRealTimeLateDeduction, applyRealTimeHalfDayDeduction, reverseHalfDayDeduction, reverseLateDayDeduction, applyEarlyDepartureHoursDeduction, reverseEarlyDepartureHoursDeduction } = require("../utils/lateDeductions");
const { logAttendanceChange } = require("../utils/attendanceLogger");
const { isNonWorkingDayHelper } = require("../controllers/attendanceController");

// Import early departure bonus deduction from attendance controller
const { deductBonusForEarlyDeparture } = require("../controllers/attendanceController");

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
  NODE_ENV,
} = process.env;

// ---------------------
// Timezone Configuration
// ---------------------
const TIMEZONE = "Asia/Karachi";
const GRACE_PERIOD_MINUTES = 0;
const HALF_DAY_THRESHOLD_HOUR = 18; // 6:00 PM
const LOGIN_RESTRICTION_END_HOUR = 8; // 8:00 AM
const HALF_DAY_LOGOUT_THRESHOLD_HOUR = 21; // 9:00 PM
const TOKEN_EXPIRY_SECONDS = 16 * 60 * 60; // 16 hours

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
 * Check if a date is a non-working day by checking:
 * 1. Recurring non-working days from PayrollPeriod
 * 2. Specific non-working days from SpecificNonWorkingDay collection
 */
async function isNonWorkingDay(ownerId, date) {
  const ymd = (d) => d.toISOString().slice(0, 10);
  const attendanceDate = new Date(date);
  const dow = attendanceDate.getDay();

  // Get payroll period for recurring non-working days
  const payroll = await PayrollPeriod.findOne({ owner: ownerId }).lean();

  // Check recurring non-working days from payroll
  const dateSet = new Set();
  const weekdaySet = new Set();
  const nameToDay = {
    sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2,
    wed: 3, weds: 3, wednesday: 3, thu: 4, thur: 4, thurs: 4, thursday: 4,
    fri: 5, friday: 5, sat: 6, saturday: 6,
  };

  (payroll?.nonWorkingDays || []).forEach((raw) => {
    if (!raw) return;
    const s = String(raw).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return dateSet.add(s);
    if (/^[0-6]$/.test(s)) return weekdaySet.add(Number(s));
    const key = s.toLowerCase();
    if (key in nameToDay) return weekdaySet.add(nameToDay[key]);
    const nd = new Date(s);
    if (!isNaN(nd)) dateSet.add(ymd(nd));
  });

  const isRecurringNonWorkingDay =
    dateSet.has(ymd(attendanceDate)) || weekdaySet.has(dow);

  // Check specific non-working days
  const specificNwd = await SpecificNonWorkingDay.findOne({
    owner: new mongoose.Types.ObjectId(ownerId),
    date: ymd(attendanceDate),
  }).lean();

  return isRecurringNonWorkingDay || !!specificNwd;
}

/**
 * Helper to handle attendance creation or session restoration.
 * Used in both /login (for trusted devices) and /confirm-code.
 */
async function performAttendanceLogic(emp, nowKarachi, deviceFingerprint) {
  const todayKarachi = getDateOnly(nowKarachi);

  const config = await AttendanceConfig.findOne({ owner: emp.owner }).lean();
  console.log(`⚙️ [ATTENDANCE-LOGIC] Employee: ${emp.companyEmail}, attendanceMode: ${config?.attendanceMode || 'not-set'}`);

  if (config && config.attendanceMode === 'manual') {
    // Return existing attendance if any, but don't create or restore it
    const existing = await Attendance.findOne({ employee: emp._id, date: todayKarachi }).lean();
    console.log(`🔧 [ATTENDANCE-LOGIC] MANUAL MODE - returning existing: ${!!existing}`);
    return {
      attendance: existing || null,
      sessionStatus: existing ? existing.status : "Manual Mode",
      attendanceExists: !!existing,
      isManualMode: true
    };
  }

  // Check if today is a non-working day
  const isNWD = await isNonWorkingDay(emp.owner, todayKarachi);
  if (isNWD) {
    console.log(`📆 [ATTENDANCE-LOGIC] Non-working day detected`);
    return { attendance: null, sessionStatus: "Non-Working Day", attendanceExists: false, isNonWorkingDay: true };
  }

  const currentTime = nowKarachi.hours() * 60 + nowKarachi.minutes();

  let existingAttendance = await Attendance.findOne({
    employee: emp._id,
    date: todayKarachi
  });

  if (existingAttendance && (existingAttendance.checkOut || existingAttendance.logoutTime)) {
    let statusToRestore = existingAttendance.originalStatus;
    if (!statusToRestore) {
      if (!existingAttendance.checkOut && existingAttendance.status !== "Half Day") {
        statusToRestore = existingAttendance.status;
      } else {
        const checkInMinutes = timeToMinutes(existingAttendance.checkIn);
        const reportingTime = emp.rt ? timeToMinutes(emp.rt) : (await getReportingTimeFromShift(emp._id));
        const graceEnd = reportingTime + GRACE_PERIOD_MINUTES;
        const halfDayThreshold = HALF_DAY_THRESHOLD_HOUR * 60;

        if (checkInMinutes <= graceEnd) statusToRestore = "Present";
        else if (checkInMinutes < halfDayThreshold) statusToRestore = "Late";
        else statusToRestore = "Half Day";
      }
    }

    await Attendance.findByIdAndUpdate(existingAttendance._id, {
      $unset: { checkOut: 1, logoutTime: 1, originalStatus: 1, halfDayFromAutoLogout: 1 },
      $set: { status: statusToRestore, totalHours: 0 }
    });

    const previousStatusLower = (existingAttendance.status || "").toLowerCase().replace(/\s+/g, '-');
    const statusToRestoreLower = (statusToRestore || "").toLowerCase().replace(/\s+/g, '-');

    if (previousStatusLower === "half-day" && statusToRestoreLower !== "half-day") {
      try {
        await reverseHalfDayDeduction(emp._id, emp.owner, emp._id, todayKarachi);
      } catch (err) {
        console.error(`[RESTORE] Error reversing half-day deduction:`, err);
      }
    }

    // ✅ Reverse early departure hours deduction if it was previously applied
    try {
      await reverseEarlyDepartureHoursDeduction(emp._id, emp.owner, emp._id, todayKarachi);
    } catch (err) {
      console.error(`[RESTORE] Error reversing early departure deduction:`, err);
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

    // LOG SESSION RESTORE
    try {
      await logAttendanceChange({
        ownerId: emp.owner,
        performerId: emp._id,
        performerType: 'Employee',
        performerName: emp.name,
        employeeId: emp._id,
        attendanceDate: todayKarachi,
        oldStatus: existingAttendance.status,
        newStatus: statusToRestore,
        oldLeaveType: existingAttendance.leaveType,
        newLeaveType: existingAttendance.leaveType, // Keeping same leave type for restore
        outcome: "Session Restored",
        details: "Auto Login (Session Restore)"
      });
    } catch (err) { console.error("Restore log error:", err); }

    return { attendance: freshAttendance, sessionStatus: freshAttendance.status, attendanceExists: true };
  }

  // CREATE NEW ATTENDANCE
  if (!existingAttendance) {
    // Check if today is a non-working day
    const payroll = await PayrollPeriod.findOne({
      owner: emp.owner,
      shifts: { $in: [emp.shifts?.[0]] }
    }).lean() || await PayrollPeriod.findOne({ owner: emp.owner }).lean();

    const isNonWorkingDay = await isNonWorkingDayHelper(emp.owner, todayKarachi, payroll);
    if (isNonWorkingDay) {
      return { attendance: null, sessionStatus: null, attendanceExists: false, isNonWorkingDay: true };
    }

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

    // LOG NEW ATTENDANCE
    try {
      let outcome = "None";
      let adjDays = 0;
      if (sessionStatus === "Late") outcome = "Potential Late Deduction";
      else if (sessionStatus === "Half Day") {
        outcome = "Half Day Deduction";
        adjDays = 0.5;
      }

      await logAttendanceChange({
        ownerId: emp.owner,
        performerId: emp._id,
        performerType: 'Employee',
        performerName: emp.name,
        employeeId: emp._id,
        attendanceDate: todayKarachi,
        oldStatus: "None",
        newStatus: sessionStatus,
        oldLeaveType: "None",
        newLeaveType: "Unpaid", // Default for auto-login if not overridden by leave
        outcome: outcome,
        adjustedDays: adjDays,
        details: "Auto Login (New Session)"
      });
    } catch (err) { console.error("New login log error:", err); }

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
    }

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
      }
    }
  } catch (err) {
    console.error("[Supervision Sync Error]", err);
  }
}

  // --- Forgot Password ---
  router.post("/forgot-password", async (req, res) => {
    const { email } = req.body;
    try {
      const emp = await Employee.findOne({ companyEmail: email });
      if (!emp) {
        return res.status(404).json({ message: "No account with that email." });
      }

      // Generate token
      const token = crypto.randomBytes(32).toString("hex");
      const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

      // Save hashed token & expiry on employee
      emp.resetPasswordToken = tokenHash;
      emp.resetPasswordExpires = Date.now() + 3600000; // 1 hour

      await emp.save();

      // Compose reset link
      const frontendURL = process.env.FRONTEND_BASE_URL || process.env.APP_URL || "http://localhost:8080";
      const resetURL = `${frontendURL}/reset-password/${token}`;
      const appName = "Employee Portal";
      const primaryColor = "#2563eb";
      const html = `
    <!DOCTYPE html>
    <html lang="en" style="background: #f4f4ff;">
      <head>
        <meta charset="UTF-8" />
        <title>Password Reset</title>
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <style>
          @import url('https://fonts.googleapis.com/css2?family=Inter:wght@500;700;900&family=Montserrat:wght@600;800&display=swap');
          body {
            font-family: 'Inter', 'Montserrat', 'Segoe UI', Arial, sans-serif;
            background: linear-gradient(130deg, #f4f4ff 60%, #f9fafc 100%, #e0e7ff 0%) fixed;
            min-height: 100vh;
            margin: 0;
            padding: 0;
          }
          .container {
            max-width: 480px;
            margin: 44px auto;
            background: #fff;
            border-radius: 22px;
            box-shadow: 0 8px 40px 0 #0033ff15, 0 2px 8px 0 #1e40af12;
            padding: 34px 30px 30px 30px;
            text-align: center;
            position: relative;
            border: 1px solid #eef2ff;
            animation: pop-in 0.7s cubic-bezier(0.23,1,0.32,1);
          }
          @keyframes pop-in {
            0% { transform: translateY(30px) scale(0.97); opacity: 0.1; }
            100% { transform: none; opacity: 1; }
          }
          h1 {
            font-family: 'Montserrat', 'Inter', Arial, sans-serif;
            font-size: 2.1rem;
            color: ${primaryColor};
            font-weight: 800;
            margin-bottom: 10px;
            letter-spacing: -1px;
          }
          .subtitle {
            font-size: 1.13rem;
            color: #3d4266;
            margin-bottom: 30px;
            background: linear-gradient(90deg, #e0e7ff 30%, #fff 100%);
            padding: 8px 0 10px 0;
            border-radius: 10px;
            box-shadow: 0 2px 8px #2563eb08;
          }
          .btn {
            display: inline-block;
            background: #2563eb;
            color: #fff !important;
            font-family: 'Montserrat', 'Inter', Arial, sans-serif;
            font-size: 1.12rem;
            font-weight: 800;
            text-decoration: none;
            border-radius: 10px;
            padding: 16px 38px;
            letter-spacing: 0.04em;
            margin: 25px 0 14px 0;
            box-shadow: 0 4px 18px -3px #2563eb33;
            border: none;
            transition: background 0.2s, transform 0.13s;
          }
          .btn:hover {
            background: linear-gradient(90deg, #003ecf, #2563eb 70%);
            color: #fff !important;
            transform: translateY(-2px) scale(1.03);
            box-shadow: 0 8px 24px -6px #2563eb4a;
          }
          .info {
            font-size: 1.04rem;
            color: #61677c;
            margin: 22px 0 0 0;
          }
          .expire {
            font-size: 1rem;
            color: #d60000;
            margin-top: 8px;
            font-weight: 600;
            display: block;
          }
          .footer {
            color: #b4b9c6;
            font-size: 1rem;
            margin: 42px 0 0 0;
            text-align: center;
            letter-spacing: 0.01em;
            border-top: 1px solid #f4f4ff;
            padding-top: 17px;
          }
          .card-accent {
            width: 100%;
            height: 6px;
            background: linear-gradient(90deg, #4f46e5, #2563eb 60%, #22d3ee 100%);
            border-radius: 11px 11px 0 0;
            margin: -34px 0 26px 0;
          }
          @media (max-width: 540px) {
            .container { padding: 18px 4vw 22px 4vw; }
            h1 { font-size: 1.28rem; }
            .btn { padding: 14px 2vw; font-size: 1rem; }
            .card-accent { margin-top: -18px; }
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="card-accent"></div>
          <h1>Reset Your Password</h1>
          <div class="subtitle">
            Hi ${emp.name || "there"},<br/>
            You requested to reset your password for your <b>${appName}</b> account.
          </div>
          <a class="btn" href="${resetURL}" target="_blank">Reset Password</a>
          <div class="info">
            Didn’t request this? It’s safe to ignore this email.<br/>
            <span class="expire">This link will expire in 1 hour.</span>
          </div>
          <div class="footer">
            &copy; ${new Date().getFullYear()} ${appName} &mdash; All rights reserved.
          </div>
        </div>
      </body>
    </html>
    `;

      // Send email using local sendMail in empAuth.js
      await sendMail({
        to: emp.companyEmail,
        subject: "Password Reset Request",
        html,
      });

      res.json({ message: "Password reset link sent if email exists." });
    } catch (err) {
      console.error("[ForgotPassword Error]", err);
      res.status(500).json({ message: "Server error", error: err.message });
    }
  });

  // --- Reset Password ---
  router.post("/reset-password/:token", async (req, res) => {
    const { token } = req.params;
    const { password } = req.body;
    const bcrypt = require("bcrypt");

    try {
      const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

      const emp = await Employee.findOne({
        resetPasswordToken: tokenHash,
        resetPasswordExpires: { $gt: Date.now() },
      });

      if (!emp) {
        return res.status(400).json({ message: "Invalid or expired token." });
      }

      // Hash password and update
      const hash = await bcrypt.hash(password, 10);
      emp.password = hash;
      emp.resetPasswordToken = undefined;
      emp.resetPasswordExpires = undefined;

      await emp.save();

      res.json({ message: "Password has been reset. Please login." });
    } catch (err) {
      console.error("[ResetPassword Error]", err);
      res.status(500).json({ message: "Server error", error: err.message });
    }
  });

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

      // 1. Core Status Checks
      if (emp.status && emp.status.toLowerCase() === "offboarded") {
        return res.status(403).json({
          error: "Account Disabled",
          message:
            "Your account has been offboarded. Please contact HR if you believe this is a mistake.",
        });
      }

      if (emp.status && emp.status.toLowerCase() === "review") {
        return res.status(403).json({
          error: "Account Under Review",
          message:
            "Your account is currently under review. Please contact HR for further information.",
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

      // 2. Identify current/potential status (READ ONLY for email/verification context)
      let existingAttendance = await Attendance.findOne({
        employee: emp._id,
        date: todayKarachi
      });

      let sessionStatus = "Present";
      if (existingAttendance) {
        if (existingAttendance.checkOut) {
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
        const empShift = await getEmployeeShift(emp._id);
        const rtMinutes = emp.rt ? timeToMinutes(emp.rt) : (empShift?.start ? timeToMinutes(empShift.start) : (15 * 60 + 30));
        const graceEnd = rtMinutes + GRACE_PERIOD_MINUTES;
        const halfDayThreshold = HALF_DAY_THRESHOLD_HOUR * 60;
        if (currentTime <= graceEnd) sessionStatus = "Present";
        else if (currentTime < halfDayThreshold) sessionStatus = "Late";
        else sessionStatus = "Half Day";
      }

      // 3. SECURITY GATE: CHECK IF DEVICE IS TRUSTED
      // ✅ DEV MODE BYPASSED: User wants to test 2FA flow
      const devModeAutoTrust = false;

      const isTrusted = emp.trustedDevices?.some(
        (d) =>
          (deviceFingerprint && d.deviceFingerprint === deviceFingerprint) ||
          (deviceToken && d.deviceId === deviceToken)
      );

      // UNRECOGNIZED DEVICE (2FA flow)
      if (!isTrusted) {
        const code = Math.floor(100000 + Math.random() * 900000).toString();
        const expires = Date.now() + 10 * 60 * 1000;
        codes.set(emp._id.toString(), { code, expires, deviceFingerprint });

        const tempToken = jwt.sign({ id: emp._id }, JWT_SECRET, { expiresIn: "10m" });
        await syncSupervision(emp._id, emp.owner).catch(e => console.error("syncSupervision error (untrusted)", e));

        const loginIp = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip || "unknown";
        const when = formatTimeForDisplay(nowKarachi);

        // Fetch owner email dynamically
        const ownerUser = await User.findById(emp.owner).select("email").lean();
        const ownerEmail = ownerUser?.email || MAIL_FROM_ADDRESS;

        await sendMail({
          to: ownerEmail,
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
          attendanceId: null,
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
      }

      // 4. AUTHORIZED: HANDLING RESTRICTED HOURS (Trusted Device Path)
      if (isRestrictedTime) {
        const token = jwt.sign(
          { id: emp._id, role: emp.role, owner: emp.owner, name: emp.name, companyEmail: emp.companyEmail, department: emp.department },
          JWT_SECRET,
          { expiresIn: TOKEN_EXPIRY_SECONDS }
        );

        await syncSupervision(emp._id, emp.owner).catch(e => console.error("syncSupervision error (restricted)", e));

        return res.json({
          message: "Login successful (Restricted hours: 12 AM - 8 AM Karachi time. No attendance recorded)",
          token,
          user: { id: emp._id, name: emp.name, companyEmail: emp.companyEmail, role: emp.role, owner: emp.owner, department: emp.department },
          restrictedHours: true,
          expiresIn: TOKEN_EXPIRY_SECONDS,
        });
      }

      // 5. AUTHORIZED: NORMAL LOGIN (Create or Restore Attendance)

      // ✅ DEV MODE: Auto-register device as trusted on first login
      if (devModeAutoTrust && !isTrusted) {
        const deviceId = crypto.randomBytes(32).toString("hex");
        const userAgent = req.headers["user-agent"] || "unknown";
        const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip || "unknown";

        emp.trustedDevices.push({
          deviceId,
          deviceFingerprint,
          userAgent,
          ip,
          addedAt: new Date(),
        });
        await emp.save();
      }

      console.log(`🔐 [LOGIN] Employee: ${emp.companyEmail}, calling performAttendanceLogic...`);
      const attendanceResult = await performAttendanceLogic(emp, nowKarachi, deviceFingerprint);
      console.log(`📋 [LOGIN-ATTENDANCE] Employee: ${emp.companyEmail}, result: mode=${attendanceResult.isManualMode}, nonWD=${attendanceResult.isNonWorkingDay}, status=${attendanceResult.sessionStatus}, exists=${attendanceResult.attendanceExists}`);

      // Handle manual mode login
      if (attendanceResult.isManualMode) {
        const token = jwt.sign(
          { id: emp._id, role: emp.role, owner: emp.owner, name: emp.name, companyEmail: emp.companyEmail, department: emp.department },
          JWT_SECRET,
          { expiresIn: TOKEN_EXPIRY_SECONDS }
        );

        return res.json({
          message: "Login successful (Manual Marking mode - no auto-attendance).",
          token,
          user: { id: emp._id, name: emp.name, companyEmail: emp.companyEmail, role: emp.role, owner: emp.owner, department: emp.department },
          attendanceId: attendanceResult.attendance?._id || null,
          sessionStatus: attendanceResult.sessionStatus,
          attendanceExists: attendanceResult.attendanceExists,
          isManualMode: true,
          trusted: true,
          expiresIn: TOKEN_EXPIRY_SECONDS,
          localLoginTime: formatTimeForDisplay(nowKarachi),
        });
      }

      // Handle non-working day login
      if (attendanceResult.isNonWorkingDay) {
        const token = jwt.sign(
          { id: emp._id, role: emp.role, owner: emp.owner, name: emp.name, companyEmail: emp.companyEmail, department: emp.department },
          JWT_SECRET,
          { expiresIn: TOKEN_EXPIRY_SECONDS }
        );

        return res.json({
          message: "Login successful (non-working day - attendance not marked).",
          token,
          user: { id: emp._id, name: emp.name, companyEmail: emp.companyEmail, role: emp.role, owner: emp.owner, department: emp.department },
          attendanceId: null,
          sessionStatus: "Non-Working Day",
          attendanceExists: false,
          isNonWorkingDay: true,
          trusted: true,
          expiresIn: TOKEN_EXPIRY_SECONDS,
          localLoginTime: formatTimeForDisplay(nowKarachi),
        });
      }

      // ✅ RE-FETCH attendance to get updated status after restoration
      const freshAttendance = attendanceResult.attendance ? await Attendance.findById(attendanceResult.attendance._id).lean() : null;
      const attendance = freshAttendance || attendanceResult.attendance;
      sessionStatus = attendance?.status || attendanceResult.sessionStatus;

      const token = jwt.sign(
        { id: emp._id, role: emp.role, owner: emp.owner, name: emp.name, companyEmail: emp.companyEmail, department: emp.department },
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
        { active: true, isAutoLogout: false, loginTime: nowKarachi.toDate(), lastSeen: nowKarachi.toDate() },
        { upsert: true, new: true }
      );

      return res.json({
        message: attendanceResult.attendanceExists ? "Login successful (attendance already marked)." : "Login successful (trusted device).",
        token,
        user: { id: emp._id, name: emp.name, companyEmail: emp.companyEmail, role: emp.role, owner: emp.owner, department: emp.department },
        attendanceId: attendance?._id,
        sessionStatus: sessionStatus,
        attendanceExists: attendanceResult.attendanceExists,
        trusted: true,
        expiresIn: TOKEN_EXPIRY_SECONDS,
        localLoginTime: formatTimeForDisplay(nowKarachi),
      });
    } catch (err) {
      console.error("Login error:", err);
      if (err.code === 11000) {
        return res.status(400).json({ error: "Session Conflict", message: "A session already exists for today." });
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
      const currentTime = nowKarachi.hours() * 60 + nowKarachi.minutes();
      const isRestrictedTime = currentTime >= 0 && currentTime < (LOGIN_RESTRICTION_END_HOUR * 60);

      if (isRestrictedTime) {
        return res.json({
          message: "Device verified and trusted. Login successful (Restricted hours: No attendance recorded).",
          token,
          deviceToken: deviceId,
          user: { id: emp._id, companyEmail: emp.companyEmail, role: emp.role, owner: emp.owner, name: emp.name || "" },
          attendanceId: null,
          sessionStatus: "Restricted",
          restrictedHours: true,
          expiresIn: TOKEN_EXPIRY_SECONDS,
          localLoginTime: formatTimeForDisplay(nowKarachi),
        });
      }

      // PERFORM ATTENDANCE LOGIC (Create or Restore) on confirmation (Not restricted)
      const attendanceResult = await performAttendanceLogic(emp, nowKarachi, deviceFingerprint);

      // Handle manual mode login
      if (attendanceResult.isManualMode) {
        return res.json({
          message: "Device verified. Login successful (Manual Marking mode - no auto-attendance).",
          token,
          deviceToken: deviceId,
          user: { id: emp._id, companyEmail: emp.companyEmail, role: emp.role, owner: emp.owner, name: emp.name || "" },
          attendanceId: attendanceResult.attendance?._id || null,
          sessionStatus: attendanceResult.sessionStatus,
          attendanceExists: attendanceResult.attendanceExists,
          isManualMode: true,
          expiresIn: TOKEN_EXPIRY_SECONDS,
          localLoginTime: formatTimeForDisplay(nowKarachi),
        });
      }

      // Handle non-working day login
      if (attendanceResult.isNonWorkingDay) {
        return res.json({
          message: "Device verified and trusted. Login successful (non-working day - attendance not marked).",
          token,
          deviceToken: deviceId,
          user: {
            id: emp._id,
            companyEmail: emp.companyEmail,
            role: emp.role,
            owner: emp.owner,
            name: emp.name || "",
          },
          attendanceId: null,
          sessionStatus: "Non-Working Day",
          isNonWorkingDay: true,
          expiresIn: TOKEN_EXPIRY_SECONDS,
          localLoginTime: formatTimeForDisplay(nowKarachi),
        });
      }

      // ✅ RE-FETCH attendance to get updated status after restoration
      const freshAttendance = attendanceResult.attendance ? await Attendance.findById(attendanceResult.attendance._id).lean() : null;
      const attendance = freshAttendance || attendanceResult.attendance;
      const sessionStatus = attendance?.status || attendanceResult.sessionStatus;

      // ✅ Enterprise Cleanup: Deactivate any orphaned sessions before starting fresh
      await EmployeeSession.updateMany(
        { employeeId: emp._id, active: true },
        { active: false, isAutoLogout: true }
      );

      // ✅ Ensure an active EmployeeSession exists
      await EmployeeSession.findOneAndUpdate(
        { employeeId: emp._id, date: todayKarachi },
        { active: true, isAutoLogout: false, loginTime: nowKarachi.toDate(), lastSeen: nowKarachi.toDate() },
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
        expiresIn: TOKEN_EXPIRY_SECONDS,
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

      console.log(`\n🚪 [LOGOUT] Employee: ${employeeId}, isAutoLogout: ${isAutoLogout}`);
      console.log(`📋 [LOGOUT-DEBUG] Body: ${JSON.stringify(req.body)}, Query: ${JSON.stringify(req.query)}`);
      console.log(`🔑 [LOGOUT-DEBUG] Content-Type: ${req.headers['content-type']}`);

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
        console.warn(`⚠️ [LOGOUT] No attendance found for ${employeeId}`);
        return res.status(400).json({
          error: "No attendance record found to log out"
        });
      }

      console.log(`📊 [LOGOUT] Found attendance: ${attendance._id}, date: ${attendance.date}, status: ${attendance.status}, hasCheckout: ${!!attendance.checkOut}`);

      const attendanceDate = attendance.date; // The day they actually logged in (important)

      let finalStatus = attendance.status;
      const originalStatusBeforeLogout = attendance.status;

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
      let isShiftComplete = false;

      // 🔥 Universal Rule: If employee stays until 9:00 PM, they are NOT marked as Half Day
      const stayedUntil9PM = logoutTotalMinutes >= halfDayLogoutThreshold;

      if (shiftEndMinutes === null) {
        // No shift configured — use the 9:00 PM threshold
        isShiftComplete = stayedUntil9PM;
      } else if (shiftEndMinutes === 0) {
        isShiftComplete = isCrossMidnightLogout;
      } else {
        isShiftComplete = (logoutTotalMinutes >= shiftEndMinutes) || stayedUntil9PM;
      }

      // Calculate total hours worked
      const loginTimeKarachi = attendance.loginTime ? moment(attendance.loginTime).tz(TIMEZONE) : null;
      const totalHours = loginTimeKarachi ? nowKarachi.diff(loginTimeKarachi, 'hours', true) : 0;

      // Log attendance info
      const emp = await Employee.findById(employeeId).select("name").lean();
      const autoLogoutIndicator = isAutoLogout ? "🔴 [AUTO-LOGOUT] " : "[MANUAL-LOGOUT] ";
      const logoutTimeUTC = nowKarachi.utc().toDate();
      const actualLogoutTime = formatTimeOnly(nowKarachi);

      let updated = null;
      // Determine if this is an auto-logout half-day (page refresh) vs actual early logout
      const isAutoLogoutHalfDay = isAutoLogout && finalStatus === "Half Day" && originalStatusBeforeLogout !== "Half Day";

      // If this is a logout before 9:00 PM and shift is not complete,
      // mark the attendance as Half Day and apply real-time half-day deduction.
      // BUT: If already marked as Half Day from login (after 6 PM), don't apply deduction again
      const shouldMarkHalfDay = !isCrossMidnightLogout && !isShiftComplete && logoutTotalMinutes < (HALF_DAY_LOGOUT_THRESHOLD_HOUR * 60) && finalStatus !== "Half Day";

      if (shouldMarkHalfDay) {
        finalStatus = "Half Day";
        console.log(`📊 [LOGOUT] Marking as Half Day - logout at ${actualLogoutTime} (before 9 PM), shift not complete`);

        // Only apply deduction if this is a NEW Half Day (not from login)
        // If originalStatus was already "Half Day", deduction was already applied at login
        if (originalStatusBeforeLogout !== "Half Day") {
          try {
            await applyRealTimeHalfDayDeduction(employeeId, ownerId, userId, attendanceDate, attendance._id);
            console.log(`✅ [LOGOUT] Half-day deduction applied (logout-based Half Day)`);
          } catch (hdErr) {
            console.error("[HALF-DAY] Error applying half-day deduction:", hdErr);
          }
        } else {
          console.log(`ℹ️ [LOGOUT] Half Day status maintained (was already Half Day from login at/after 6 PM)`);
        }
      } else if (finalStatus === "Half Day" && originalStatusBeforeLogout === "Half Day") {
        // Employee logged in after 6 PM (already Half Day) and is now logging out
        console.log(`ℹ️ [LOGOUT] Maintaining Half Day status (login was at/after 6 PM)`);
      }
      try {
        updated = await Attendance.findByIdAndUpdate(
          attendance._id,
          {
            logoutTime: logoutTimeUTC,
            checkOut: actualLogoutTime,
            status: finalStatus,
            totalHours: parseFloat(totalHours.toFixed(2)),
            originalStatus: originalStatusBeforeLogout,
            // Flag to track if Half Day came from auto-logout (page refresh) - used to prevent incorrect deduction reversals
            halfDayFromAutoLogout: isAutoLogoutHalfDay
          },
          { new: true }
        );

        if (!updated) {
          console.error(
            `[ERROR-LOGOUT] Failed to update attendance record for ${employeeId}. Record not found after update.`
          );
          return res.status(500).json({ error: "Failed to save checkout time" });
        }

        // isAutoLogout is set only if the request signaled it (beacon from refresh/close).
        const sessionUpdate = {
          active: false,
          logoutTime: logoutTimeUTC
        };

        if (isAutoLogout) {
          sessionUpdate.isAutoLogout = true;
        }

        const sessionResult = await EmployeeSession.findOneAndUpdate(
          { employeeId, date: attendanceDate },
          sessionUpdate,
          { upsert: true, new: true }
        );

        console.log(`📊 [LOGOUT-SESSION] Updated session - status: ${finalStatus}, isAutoLogout: ${isAutoLogout}, sessionResult: ${JSON.stringify({ _id: sessionResult?._id, active: sessionResult?.active, isAutoLogout: sessionResult?.isAutoLogout })}`);
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

      // ✅ PROCESS EARLY DEPARTURE BONUS HOURS DEDUCTION
      // Only apply when: Employee stayed until 9 PM (stayedUntil9PM=true) BUT didn't complete shift
      let earlyDepartureResult = null;
      if (stayedUntil9PM && !isShiftComplete && shiftEndMinutes !== null && !isCrossMidnightLogout) {
        try {
          let minutesEarly = 0;

          // Handle midnight shifts specially (shiftEndMinutes === 0 means shift ends at 00:00 next day)
          if (shiftEndMinutes === 0) {
            // For midnight shift: if logout before midnight, they're early
            // Hours early = (24*60 - logoutTotalMinutes) / 60
            minutesEarly = (24 * 60) - logoutTotalMinutes;
          } else {
            // For regular shifts: normal calculation
            minutesEarly = Math.max(0, shiftEndMinutes - logoutTotalMinutes);
          }

          const hoursEarly = minutesEarly / 60;

          if (hoursEarly > 0) {

            earlyDepartureResult = await applyEarlyDepartureHoursDeduction(
              employeeId,
              ownerId,
              userId,
              attendanceDate,
              hoursEarly
            );
          }
        } catch (edErr) {
          console.error("[EARLY-DEPARTURE] Error processing early departure deduction:", edErr);
          earlyDepartureResult = { success: false, message: edErr.message };
        }
      }

      return res.json({
        status: "success",
        message: "Logged out successfully",
        logoutTime: formatTimeForDisplay(nowKarachi),
        sessionStatus: updated ? updated.status : finalStatus,
        totalHours: updated ? updated.totalHours : parseFloat(totalHours.toFixed(2)),
        lateDeductionResult: lateDeductionResult || null,
        earlyDepartureResult: earlyDepartureResult || null
      });
    } catch (err) {
      console.error("Logout error:", err);
      return res.status(500).json({ error: "Server error during logout" });
    }
  });

  router.post("/heartbeat", requireAuth, async (req, res) => {
    try {
      const employeeId = req.employee._id || req.employee.id;
      const nowKarachi = getKarachiTime();
      const todayKarachi = getDateOnly(nowKarachi);

      // Update lastSeen timestamp for the active session
      const result = await EmployeeSession.findOneAndUpdate(
        { employeeId, date: todayKarachi, active: true },
        { lastSeen: nowKarachi.toDate() },
        { new: true }
      );

      if (!result) {
        // No active session found - this shouldn't happen in normal flow
        console.warn(`⚠️ [HEARTBEAT] No active session found for ${employeeId} on ${todayKarachi}`);
        return res.status(404).json({ error: "No active session found" });
      }

      return res.json({ status: "success", lastSeen: result.lastSeen });
    } catch (err) {
      console.error("❌ [HEARTBEAT] Error:", err);
      return res.status(500).json({ error: "Server error during heartbeat" });
    }
  });

  router.post("/reactivate-session", requireAuth, async (req, res) => {
    try {
      const employeeId = req.employee._id || req.employee.id;
      const nowKarachi = getKarachiTime();
      const todayKarachi = getDateOnly(nowKarachi);

      console.info(`🔄 [REACTIVATE-SESSION] Attempting to reactivate session for ${employeeId}`);

      // 1. First, check for an existing active session for today.
      // If it's already active, that's fine - we still need to restore attendance status
      let session = await EmployeeSession.findOne({
        employeeId,
        date: todayKarachi,
        active: true
      });

      // 2. If no active session, look for any inactive session for today that can be reactivated.
      if (!session) {
        session = await EmployeeSession.findOne({
          employeeId,
          date: todayKarachi,
          active: false
        }).sort({ updatedAt: -1 });
      }

      // 3. Fallback: most recent inactive auto-logout session (no time limit)
      if (!session) {
        session = await EmployeeSession.findOne({
          employeeId,
          active: false,
          isAutoLogout: true
        }).sort({ updatedAt: -1 });

        if (!session) {
          console.info(`🔄 [REACTIVATE-SESSION] No recent session to reactivate for ${employeeId}. Creating fresh for today.`);

          await EmployeeSession.findOneAndUpdate(
            { employeeId, date: todayKarachi },
            { active: true, isAutoLogout: false, loginTime: nowKarachi.toDate(), lastSeen: nowKarachi.toDate() },
            { upsert: true, new: true }
          );
          return res.json({ status: "success", message: "New session created" });
        }
      }

      // ✅ ALWAYS RESTORE ATTENDANCE RECORD (whether session was already active or not)
      const attendanceDate = session?.date || todayKarachi;
      const attendance = await Attendance.findOne({
        employee: employeeId,
        date: attendanceDate
      });

      let wasRestored = false;

      if (attendance && (attendance.checkOut || attendance.logoutTime)) {
        wasRestored = true;
        const previousStatus = attendance.status;
        const statusToRestore = attendance.originalStatus || attendance.status;
        const isAutoLogoutHalfDay = attendance.halfDayFromAutoLogout === true;

        console.info(`🔄 [REACTIVATE-SESSION] Found attendance with logout - Restoring...`);
        console.info(`   📊 Previous Status: ${previousStatus}`);
        console.info(`   📊 Status to Restore: ${statusToRestore}`);
        console.info(`   🕐 CheckOut: ${attendance.checkOut}`);
        console.info(`   🕐 LogoutTime: ${attendance.logoutTime}`);

        await Attendance.findByIdAndUpdate(attendance._id, {
          $unset: { logoutTime: 1, checkOut: 1, originalStatus: 1, halfDayFromAutoLogout: 1 },
          $set: { status: statusToRestore, totalHours: 0 }
        });

        console.info(`✅ [REACTIVATE-SESSION] Attendance updated - logout times removed, status restored to ${statusToRestore}`);

        const previousStatusLower = (previousStatus || "").toLowerCase().replace(/\s+/g, '-');
        const statusToRestoreLower = (statusToRestore || "").toLowerCase().replace(/\s+/g, '-');

        // Only reverse half-day deduction if status is being restored from Half Day to something else
        if (previousStatusLower === "half-day" && statusToRestoreLower !== "half-day") {
          try {
            const emp = await Employee.findById(employeeId).select("owner").lean();
            if (emp) {
              await reverseHalfDayDeduction(employeeId, emp.owner, employeeId, attendanceDate);
              console.info(`✅ [REACTIVATE-SESSION] Half-day deduction reversed for ${employeeId} (after ${isAutoLogoutHalfDay ? 'auto' : 'manual'}-logout)`);
            }
          } catch (derr) {
            console.error("[REACTIVATE-SESSION] Error reversing half-day deduction:", derr);
          }
        }

        // ✅ Reverse early departure hours deduction if it was previously applied
        try {
          const emp = await Employee.findById(employeeId).select("owner").lean();
          if (emp) {
            await reverseEarlyDepartureHoursDeduction(employeeId, emp.owner, employeeId, attendanceDate);
          }
        } catch (err) {
          console.error("[REACTIVATE-SESSION] Error reversing early departure deduction:", err);
        }
      }

      // Re-activate session if it wasn't already active
      if (session && !session.active) {
        wasRestored = true;
        session.active = true;
        session.isAutoLogout = false;
        session.lastSeen = nowKarachi.toDate();
        await session.save();
        console.info(`✅ [REACTIVATE-SESSION] Session reactivated for ${employeeId}`);
      } else if (session && session.active) {
        // Update lastSeen even if already active
        session.lastSeen = nowKarachi.toDate();
        await session.save();
        console.info(`🔄 [REACTIVATE-SESSION] Session already active for ${employeeId} - status restored if needed`);
      }

      return res.json({ status: "success", message: "Session reactivated, attendance restored", wasRestored });
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
      // ✅ FETCH ALL ATTENDANCE RECORDS WITHOUT LIMIT
      const mongoose = require("mongoose");
      const attendanceRecords = await Attendance.find({
        employee: new mongoose.Types.ObjectId(req.employee._id),
      })
        .sort({ date: -1 });

      // Convert times to expected format for frontend
      const formattedSessions = attendanceRecords.map(record => {
        const recObj = record.toObject();
        return {
          ...recObj,
          date: record.date, // YYYY-MM-DD
          status: record.status, // Present, Late, Half Day, Absent, Leave
          actualLoginTime: record.checkIn, // HH:mm format
          actualLogoutTime: record.checkOut, // HH:mm format
          loginTime: record.loginTime, // UTC date
          logoutTime: record.logoutTime, // UTC date
          totalHours: record.totalHours || 0,
          active: record.active || false,
          loginTimeLocal: record.loginTime ? moment(record.loginTime).tz(TIMEZONE).format("YYYY-MM-DD HH:mm:ss") : null,
          logoutTimeLocal: record.logoutTime ?
            moment(record.logoutTime).tz(TIMEZONE).format("YYYY-MM-DD HH:mm:ss") : null,
        };
      });

      res.json({ sessions: formattedSessions });
    } catch (err) {
      console.error("Fetch attendance error:", err);
      res.status(500).json({ error: "Unable to fetch attendance records" });
    }
  });

  router.get("/all-sessions", async (req, res) => {
    try {
      const sessions = await EmployeeSession.find()
        .populate("employeeId", "name companyEmail role photographUrl")
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
          photographUrl: s.employeeId?.photographUrl,
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
