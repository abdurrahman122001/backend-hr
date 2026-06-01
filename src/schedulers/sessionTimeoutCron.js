const cron = require("node-cron");
const mongoose = require("mongoose");
const EmployeeSession = require("../models/EmployeeSession");
const Attendance = require("../models/Attendance");
const Employee = require("../models/Employees");
const moment = require("moment-timezone");

const TIMEZONE = "Asia/Karachi";
const SESSION_TIMEOUT_MINUTES = 3; // Auto-logout if no heartbeat for 3 minutes

/**
 * Session Timeout Cron Job
 * 
 * Runs every 10 seconds (for testing) and checks for active sessions where lastSeen is older than 3 minutes.
 * For those sessions, triggers auto-logout by calling the existing logout logic.
 */
cron.schedule("*/10 * * * * *", async () => {
  try {
    console.log("🕐 [SESSION-TIMEOUT-CRON] Starting session timeout check...");

    const now = moment().tz(TIMEZONE);
    const timeoutThreshold = moment(now).subtract(SESSION_TIMEOUT_MINUTES, "minutes").toDate();

    // Find all active sessions where lastSeen is older than threshold
    const staleSessions = await EmployeeSession.find({
      active: true,
      lastSeen: { $lt: timeoutThreshold }
    }).populate("employeeId", "name companyEmail owner");

    if (staleSessions.length === 0) {
      console.log("✅ [SESSION-TIMEOUT-CRON] No stale sessions found");
      return;
    }

    console.log(`⚠️ [SESSION-TIMEOUT-CRON] Found ${staleSessions.length} stale session(s)`);

    // Process each stale session
    for (const session of staleSessions) {
      try {
        const employeeId = session.employeeId._id;
        const employeeName = session.employeeId.name || "Unknown";
        const ownerId = session.employeeId.owner;
        const attendanceDate = session.date;

        console.log(`🔴 [SESSION-TIMEOUT-CRON] Auto-logging out ${employeeName} (${employeeId}) - lastSeen: ${moment(session.lastSeen).tz(TIMEZONE).format("YYYY-MM-DD HH:mm:ss")}`);

        // Find the attendance record for this session
        const attendance = await Attendance.findOne({
          employee: employeeId,
          date: attendanceDate
        });

        if (!attendance) {
          console.warn(`⚠️ [SESSION-TIMEOUT-CRON] No attendance found for ${employeeName} on ${attendanceDate}`);

          // Still mark session as inactive
          session.active = false;
          session.isAutoLogout = true;
          session.logoutTime = now.toDate();
          await session.save();
          continue;
        }

        // Skip if already logged out
        if (attendance.checkOut || attendance.logoutTime) {
          console.log(`ℹ️ [SESSION-TIMEOUT-CRON] ${employeeName} already logged out, marking session inactive`);
          session.active = false;
          session.isAutoLogout = true;
          await session.save();
          continue;
        }

        // Get shift information for proper status calculation
        const Shift = require("../models/Shift");
        let shiftEndMinutes = null;
        try {
          const empForShift = await Employee.findById(employeeId).select("shifts").lean();
          if (empForShift && empForShift.shifts && empForShift.shifts.length > 0) {
            const shiftDoc = await Shift.findById(empForShift.shifts[0]).select("end").lean();
            if (shiftDoc && shiftDoc.end) {
              const [h, m] = String(shiftDoc.end).trim().split(":").map(Number);
              if (!isNaN(h) && !isNaN(m)) {
                shiftEndMinutes = h * 60 + m;
              }
            }
          }
        } catch (shiftErr) {
          console.error(`[SESSION-TIMEOUT-CRON] Error fetching shift for ${employeeName}:`, shiftErr);
        }

        // Use lastSeen as the actual logout time — this is the last moment the
        // employee was genuinely active (heartbeat). Using `now` (cron run time)
        // would record when the timeout was *detected*, not when the browser closed.
        const lastSeenKarachi = moment(session.lastSeen).tz(TIMEZONE);
        const actualLogoutTime = lastSeenKarachi.format("HH:mm");
        const logoutTimeUTC = lastSeenKarachi.utc().toDate();
        const logoutHour = lastSeenKarachi.hours();
        const logoutMinute = lastSeenKarachi.minutes();
        const logoutTotalMinutes = logoutHour * 60 + logoutMinute;

        // Calculate total hours worked using lastSeen as the end time
        const loginTimeKarachi = attendance.loginTime ? moment(attendance.loginTime).tz(TIMEZONE) : null;
        const totalHours = loginTimeKarachi ? lastSeenKarachi.diff(loginTimeKarachi, 'hours', true) : 0;

        let finalStatus = attendance.status;
        const originalStatusBeforeLogout = attendance.status;

        // Cross-midnight check 1: lastSeen is after midnight (employee worked into next day)
        const lastSeenDate = lastSeenKarachi.format("YYYY-MM-DD");
        const isCrossMidnightLogout = lastSeenDate !== attendanceDate;

        // Cross-midnight check 2: cron is running on a DIFFERENT day than the attendance date.
        // This catches the case where the employee's last heartbeat was before midnight (e.g. 8:45 PM)
        // but the cron only runs after midnight — both lastSeenDate and attendanceDate are the same
        // previous day, so check 1 passes, but applying half-day retroactively after midnight is wrong.
        const nowDate = now.format("YYYY-MM-DD");
        const isRetroactiveProcessing = nowDate !== attendanceDate;

        // ✅ Mark as Half Day ONLY IF: same-day session, cron ran on the same date, and before 9 PM
        const halfDayLogoutThreshold = 21 * 60; // 9:00 PM
        const shouldMarkHalfDay =
          !isCrossMidnightLogout &&
          !isRetroactiveProcessing &&
          logoutTotalMinutes < halfDayLogoutThreshold &&
          finalStatus !== "Half Day";

        if (shouldMarkHalfDay) {
          finalStatus = "Half Day";
          console.log(`📊 [SESSION-TIMEOUT-CRON] Marking ${employeeName} as Half Day (timeout at ${actualLogoutTime}, before 9 PM, same day)`);

          // Apply deduction only if this is a NEW Half Day (not from login after 6 PM)
          if (originalStatusBeforeLogout !== "Half Day") {
            try {
              const { applyRealTimeHalfDayDeduction } = require("../utils/lateDeductions");
              await applyRealTimeHalfDayDeduction(employeeId, ownerId, employeeId, attendanceDate, attendance._id);
              console.log(`✅ [SESSION-TIMEOUT-CRON] Half-day deduction applied for ${employeeName} (timeout-based Half Day)`);
            } catch (hdErr) {
              console.error(`❌ [SESSION-TIMEOUT-CRON] Error applying half-day deduction for ${employeeName}:`, hdErr);
            }
          } else {
            console.log(`ℹ️ [SESSION-TIMEOUT-CRON] ${employeeName} was already Half Day from login (after 6 PM), no additional deduction`);
          }
        } else if (isRetroactiveProcessing) {
          // Cron ran after midnight on a different date — status stays exactly as it was
          console.log(`ℹ️ [SESSION-TIMEOUT-CRON] ${employeeName} — attendance date (${attendanceDate}) is before today (${nowDate}), keeping status as "${finalStatus}"`);
        } else if (finalStatus === "Half Day" && originalStatusBeforeLogout === "Half Day") {
          console.log(`ℹ️ [SESSION-TIMEOUT-CRON] ${employeeName} maintaining Half Day status (login was after 6 PM)`);
        }

        // Update attendance record
        const updatedAttendance = await Attendance.findByIdAndUpdate(
          attendance._id,
          {
            logoutTime: logoutTimeUTC,
            checkOut: actualLogoutTime,
            status: finalStatus,
            totalHours: parseFloat(totalHours.toFixed(2)),
            originalStatus: originalStatusBeforeLogout
          },
          { new: true }
        );

        if (!updatedAttendance) {
          console.error(`❌ [SESSION-TIMEOUT-CRON] Failed to update attendance for ${employeeName}`);
          continue;
        }

        // Update session
        session.active = false;
        session.isAutoLogout = true;
        session.logoutTime = logoutTimeUTC;
        await session.save();

        console.log(`✅ [SESSION-TIMEOUT-CRON] Auto-logged out ${employeeName}`);
        console.log(`   📊 Status: ${originalStatusBeforeLogout} → ${finalStatus}`);
        console.log(`   ⏱️  Total Hours: ${totalHours.toFixed(2)}`);
        console.log(`   🕐 Logout Time: ${actualLogoutTime}`);

      } catch (sessionErr) {
        console.error(`❌ [SESSION-TIMEOUT-CRON] Error processing session for ${session.employeeId?.name || 'Unknown'}:`, sessionErr);
      }
    }

    console.log("✅ [SESSION-TIMEOUT-CRON] Session timeout check completed");

  } catch (err) {
    console.error("❌ [SESSION-TIMEOUT-CRON] Error in session timeout cron:", err);
  }
});

console.log("🕐 [SESSION-TIMEOUT-CRON] Session timeout cron job initialized (runs every 10 seconds for testing)");
