const cron = require("node-cron");
const mongoose = require("mongoose");
const moment = require("moment-timezone");
const Leave = require("../models/ApplyLeave");
const Attendance = require("../models/Attendance");
const EmployeeSession = require("../models/EmployeeSession");
const Employee = require("../models/Employees");
const LeaveYearBalance = require("../models/LeaveYearBalance");
const LeaveTransaction = require("../models/LeaveTransaction");
const { getLeaveYear } = require("../utils/leaveEntitlement");

const TIMEZONE = "Asia/Karachi";

/**
 * Scheduled to run at 23:45 (11:45 PM) Asia/Karachi time daily.
 * This runs at the end of the day to check if employees who had approved 
 * leaves actually showed up or not. If they didn't show up, it marks 
 * their attendance and deducts from their leave balance.
 */
cron.schedule("45 23 * * *", async () => {
    try {
        console.log("=== Leave Sync Cron Started ===", new Date());
        const todayStr = moment().tz(TIMEZONE).format("YYYY-MM-DD");

        // Find all approved leaves that include today
        const startOfToday = moment().tz(TIMEZONE).startOf("day").toDate();
        const endOfToday = moment().tz(TIMEZONE).endOf("day").toDate();

        const activeLeaves = await Leave.find({
            status: "approved",
            "dates.date": { $gte: startOfToday, $lte: endOfToday }
        }).populate("employee");

        console.log(`Found ${activeLeaves.length} approved leave requests covering today (${todayStr})`);

        for (const leave of activeLeaves) {
            try {
                const employeeId = leave.employee._id;
                const ownerId = leave.employee.owner;

                // Find the specific date entry for today in this leave
                const dateEntry = leave.dates.find(d =>
                    moment(d.date).tz(TIMEZONE).format("YYYY-MM-DD") === todayStr
                );

                if (!dateEntry) continue;

                // Check if employee has already marked attendance for today
                const existingAttendance = await Attendance.findOne({
                    employee: employeeId,
                    date: todayStr
                });

                // Check if the employee "made it up" (Active statuses marked by employee)
                // If they checked in personally, the status will be Present or Late
                if (existingAttendance && (existingAttendance.status === "Present" || existingAttendance.status === "Late")) {
                    console.log(`[LeaveSync] Employee ${employeeId} present on leave day ${todayStr}. Skipping deduction.`);
                    continue;
                }

                // Skip if already processed by approveLeave (status is Leave and markedByHR)
                if (existingAttendance && existingAttendance.status === "Leave" && existingAttendance.markedByHR) {
                    console.log(`[LeaveSync] Employee ${employeeId} already processed for ${todayStr} (approved via leave request). Skipping.`);
                    continue;
                }

                // Logic for deduction and marking
                let daysToDeduct = (dateEntry.type === "half") ? 0.5 : 1;
                let attendanceStatus = "Leave";
                let sessionStatus = "leave";
                let finalIsPaid = leave.isPaid;

                if (dateEntry.type === "half") {
                    attendanceStatus = "Half Day";
                    sessionStatus = "half-day";
                } else if (dateEntry.type === "late" || dateEntry.type === "early_leave") {
                    // These are normally warning types, but we mark as requested
                    attendanceStatus = "Late";
                    sessionStatus = "late";
                }

                // Check balance if leave is supposed to be paid
                if (finalIsPaid) {
                    const leaveYear = getLeaveYear(todayStr);
                    const balance = await LeaveYearBalance.findOne({
                        owner: ownerId,
                        employee: employeeId,
                        year: leaveYear
                    });

                    const totalEntitled = (balance?.total || 0) + (balance?.bonus || 0);
                    const usedPaid = balance?.usedPaid || 0;
                    const available = totalEntitled - usedPaid;

                    if (available < daysToDeduct) {
                        // Not enough leave balance - Mark as Absent as per user request
                        attendanceStatus = "Absent";
                        sessionStatus = "absent";
                        finalIsPaid = false;
                        console.log(`[LeaveSync] Employee ${employeeId} has insufficient balance (${available}). Marking as Absent.`);
                    }
                }

                // --- Perform Updates ---

                // 1. Upsert Attendance
                await Attendance.findOneAndUpdate(
                    { owner: ownerId, employee: employeeId, date: todayStr },
                    {
                        $set: {
                            owner: ownerId,
                            employee: employeeId,
                            date: todayStr,
                            status: attendanceStatus,
                            leaveType: finalIsPaid ? "Paid" : "Unpaid",
                            markedByHR: true,
                            notes: (leave.approvalNotes || "Auto-sync leave") + (dateEntry.type !== "full" ? ` (${dateEntry.type})` : ""),
                            createdBy: leave.approvedBy || ownerId,
                        }
                    },
                    { upsert: true, new: true, setDefaultsOnInsert: true }
                );

                // 2. Upsert EmployeeSession
                await EmployeeSession.findOneAndUpdate(
                    { employeeId: employeeId, date: todayStr },
                    {
                        $set: {
                            employeeId: employeeId,
                            date: todayStr,
                            status: sessionStatus,
                            active: false,
                            totalHours: (dateEntry.type === "half") ? 4 : (dateEntry.type === "full" ? 0 : 8),
                            notes: leave.approvalNotes || "Auto-sync leave",
                            actualLoginTime: null,
                            actualLogoutTime: null,
                            loginTime: moment(dateEntry.date).tz(TIMEZONE).startOf("day").toDate(),
                            logoutTime: moment(dateEntry.date).tz(TIMEZONE).endOf("day").toDate(),
                        }
                    },
                    { upsert: true, new: true, setDefaultsOnInsert: true }
                );

                // 3. Update Leave Balances and Transactions
                const leaveYearForDeduction = getLeaveYear(todayStr);
                if (finalIsPaid) {
                    // Increment usedPaid in Employee model
                    await Employee.findByIdAndUpdate(employeeId, {
                        $inc: { "leaveEntitlement.usedPaid": daysToDeduct },
                    });

                    // Update LeaveYearBalance
                    const balance = await LeaveYearBalance.findOneAndUpdate(
                        { employee: employeeId, year: leaveYearForDeduction },
                        {
                            $inc: { usedPaid: daysToDeduct },
                            $set: { owner: ownerId }
                        },
                        { upsert: true, new: true }
                    );

                    // Create Transaction
                    await LeaveTransaction.create({
                        owner: ownerId,
                        employee: employeeId,
                        leaveYearBalance: balance._id,
                        year: leaveYearForDeduction,
                        date: todayStr,
                        type: "PAID_LEAVE_USED",
                        value: daysToDeduct,
                        sourceModel: "ApplyLeave",
                        sourceId: leave._id,
                        createdBy: leave.approvedBy || ownerId
                    });
                } else {
                    // Increment usedUnpaid in Employee model
                    await Employee.findByIdAndUpdate(employeeId, {
                        $inc: { "leaveEntitlement.usedUnpaid": daysToDeduct },
                    });

                    // Update LeaveYearBalance
                    const balance = await LeaveYearBalance.findOneAndUpdate(
                        { employee: employeeId, year: leaveYearForDeduction },
                        {
                            $inc: { usedUnpaid: daysToDeduct },
                            $set: { owner: ownerId }
                        },
                        { upsert: true, new: true }
                    );

                    // Create Transaction
                    await LeaveTransaction.create({
                        owner: ownerId,
                        employee: employeeId,
                        leaveYearBalance: balance._id,
                        year: leaveYearForDeduction,
                        date: todayStr,
                        type: "UNPAID_LEAVE_USED",
                        value: daysToDeduct,
                        sourceModel: "ApplyLeave",
                        sourceId: leave._id,
                        createdBy: leave.approvedBy || ownerId
                    });
                }

                console.log(`[LeaveSync] Successfully processed today's leave for Employee ${employeeId}`);

            } catch (innerErr) {
                console.error(`[LeaveSync] Error processing leave ${leave._id}:`, innerErr);
            }
        }

        console.log("=== Leave Sync Cron Completed ===", new Date());
    } catch (err) {
        console.error("Critical Error in Leave Sync Cron:", err);
    }
}, {
    timezone: TIMEZONE
});
