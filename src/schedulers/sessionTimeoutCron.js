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

        // Calculate logout time and status
        const logoutHour = now.hours();
        const logoutMinute = now.minutes();
        const logoutTotalMinutes = logoutHour * 60 + logoutMinute;
        const actualLogoutTime = now.format("HH:mm");
        const logoutTimeUTC = now.utc().toDate();

        // Calculate total hours worked
        const loginTimeKarachi = attendance.loginTime ? moment(attendance.loginTime).tz(TIMEZONE) : null;
        const totalHours = loginTimeKarachi ? now.diff(loginTimeKarachi, 'hours', true) : 0;

        let finalStatus = attendance.status;
        const originalStatusBeforeLogout = attendance.status;

        // Check if today is different from attendance date (cross-midnight)
        const todayKarachi = now.format("YYYY-MM-DD");
        const isCrossMidnightLogout = todayKarachi !== attendanceDate;

        // Determine if shift is complete
        const halfDayLogoutThreshold = 21 * 60; // 9:00 PM
        const stayedUntil9PM = logoutTotalMinutes >= halfDayLogoutThreshold;

        let isShiftComplete = false;
        if (shiftEndMinutes === null) {
          isShiftComplete = stayedUntil9PM;
        } else if (shiftEndMinutes === 0) {
          isShiftComplete = isCrossMidnightLogout;
        } else {
          isShiftComplete = (logoutTotalMinutes >= shiftEndMinutes) || stayedUntil9PM;
        }

        // Determine if should mark as Half Day (using halfDayLogoutThreshold from above)
        const shouldMarkHalfDay = !isShiftComplete && logoutTotalMinutes < halfDayLogoutThreshold && finalStatus !== "Half Day";

        if (shouldMarkHalfDay) {
          finalStatus = "Half Day";
          console.log(`📊 [SESSION-TIMEOUT-CRON] Marking ${employeeName} as Half Day (logout at ${actualLogoutTime}, before 9 PM)`);

          // Only apply deduction if this is a NEW Half Day (not from login)
          // If originalStatus was already "Half Day", deduction was already applied at login
          if (originalStatusBeforeLogout !== "Half Day") {
            try {
              const { applyRealTimeHalfDayDeduction } = require("../utils/lateDeductions");
              await applyRealTimeHalfDayDeduction(employeeId, ownerId, employeeId, attendanceDate, attendance._id);
              console.log(`✅ [SESSION-TIMEOUT-CRON] Half-day deduction applied for ${employeeName} (logout-based Half Day)`);
            } catch (hdErr) {
              console.error(`❌ [SESSION-TIMEOUT-CRON] Error applying half-day deduction for ${employeeName}:`, hdErr);
            }
          } else {
            console.log(`ℹ️ [SESSION-TIMEOUT-CRON] ${employeeName} was already Half Day from login (at/after 6 PM), no additional deduction`);
          }
        } else if (finalStatus === "Half Day" && originalStatusBeforeLogout === "Half Day") {
          console.log(`ℹ️ [SESSION-TIMEOUT-CRON] ${employeeName} maintaining Half Day status (login was at/after 6 PM)`);
        }

        // Apply early departure hours deduction if stayed until 9 PM but didn't complete shift
        if (stayedUntil9PM && !isShiftComplete && shiftEndMinutes !== null && !isCrossMidnightLogout) {
          try {
            let minutesEarly = 0;

            if (shiftEndMinutes === 0) {
              // Midnight shift: if logout before midnight, they're early
              minutesEarly = (24 * 60) - logoutTotalMinutes;
            } else {
              // Regular shift
              minutesEarly = Math.max(0, shiftEndMinutes - logoutTotalMinutes);
            }

            const hoursEarly = minutesEarly / 60;

            if (hoursEarly > 0) {
              console.log(`📊 [SESSION-TIMEOUT-CRON] ${employeeName} left ${hoursEarly.toFixed(2)} hours early`);

              const { applyEarlyDepartureHoursDeduction } = require("../utils/lateDeductions");
              await applyEarlyDepartureHoursDeduction(
                employeeId,
                ownerId,
                employeeId,
                attendanceDate,
                hoursEarly
              );
              console.log(`✅ [SESSION-TIMEOUT-CRON] Early departure deduction applied for ${employeeName}`);
            }
          } catch (edErr) {
            console.error(`❌ [SESSION-TIMEOUT-CRON] Error applying early departure deduction for ${employeeName}:`, edErr);
          }
        }

        // Update attendance record
        const updatedAttendance = await Attendance.findByIdAndUpdate(
          attendance._id,
          {
            logoutTime: logoutTimeUTC,
            checkOut: actualLogoutTime,
            status: finalStatus,
            totalHours: parseFloat(totalHours.toFixed(2)),
            originalStatus: originalStatusBeforeLogout,
            halfDayFromAutoLogout: shouldMarkHalfDay
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
