const mongoose = require("mongoose");
const EmployeeSession = require("../models/EmployeeSession");
const PayrollPeriod = require("../models/PayrollPeriod");
const Attendance = require("../models/Attendance");
const LeaveYearBalance = require("../models/LeaveYearBalance");
const LeaveTransaction = require("../models/LeaveTransaction");
const SalarySlip = require("../models/SalarySlip");
const Employee = require("../models/Employees");
const { decrypt, encrypt } = require("./encryption");
const { logAttendanceChange } = require("./attendanceLogger");

const TIMEZONE = "Asia/Karachi";

function getLeaveYear(attendanceDate) {
  const d = new Date(attendanceDate);
  const year = d.getFullYear();
  const month = d.getMonth(); // 0 = Jan
  const day = d.getDate();

  // If date is on or after 26 Dec → belongs to next leave year
  if (month === 11 && day >= 26) {
    return year + 1;
  }

  return year;
}

/**
 * Count late sessions for an employee in a payroll period
 * @param {ObjectId} employeeId - Employee ID
 * @param {Date} periodStart - Start date of payroll period
 * @param {Date} periodEnd - End date of payroll period
 * @returns {Promise<number>} - Count of late sessions
 */
async function countLateSessionsInPeriod(employeeId, periodStart, periodEnd) {
  try {
    const startStr = periodStart.toISOString().split('T')[0];
    const endStr = periodEnd.toISOString().split('T')[0];

    const lateSessions = await Attendance.countDocuments({
      employee: employeeId,
      status: "Late",
      date: {
        $gte: startStr,
        $lte: endStr,
      },
    });

    return lateSessions;
  } catch (err) {
    console.error("[LATE-DEDUCTION] Error counting late sessions:", err);
    return 0;
  }
}

/**
 * Check if late sessions have already been processed for this period
 * @param {ObjectId} employeeId - Employee ID
 * @param {Date} periodStart - Start date of payroll period
 * @param {Date} periodEnd - End date of payroll period
 * @returns {Promise<boolean>} - True if already processed
 */
async function isLateDeductionProcessed(employeeId, periodStart, periodEnd) {
  try {
    const startStr = periodStart.toISOString().split('T')[0];
    const endStr = periodEnd.toISOString().split('T')[0];

    // Check if there's an attendance record with lateDeductionApplied flag
    const processed = await Attendance.findOne({
      employee: employeeId,
      date: {
        $gte: startStr,
        $lte: endStr,
      },
      lateDeductionApplied: true,
    });

    return !!processed;
  } catch (err) {
    console.error("[LATE-DEDUCTION] Error checking if processed:", err);
    return false;
  }
}

/**
 * Process late deductions: 3 late sessions = 1 leave day deducted
 * @param {ObjectId} ownerId - Owner/Company ID
 * @param {ObjectId} employeeId - Employee ID
 * @param {ObjectId} userId - User who performed the action
 * @param {Date} periodStart - Start date of payroll period
 * @param {Date} periodEnd - End date of payroll period
 * @param {Shift} shift - Shift object for this employee
 * @returns {Promise<Object>} - { processed: boolean, lateCount: number, leavesDeducted: number, message: string }
 */
async function processLateDeductionsForPeriod(
  ownerId,
  employeeId,
  userId,
  periodStart,
  periodEnd,
  shift
) {
  try {
    // Get employee info
    const employee = await Employee.findById(employeeId).select("name owner createdBy");
    if (!employee) {
      return {
        processed: false,
        lateCount: 0,
        leavesDeducted: 0,
        message: "Employee not found"
      };
    }

    const actualOwnerId = employee.owner || employee.createdBy || ownerId;

    // Get payroll for this employee to find the salary slip
    const allPayrolls = await PayrollPeriod.find({ owner: actualOwnerId }).lean();
    const shiftId = shift ? shift._id : employee.shifts?.[0];
    const payroll = allPayrolls.find(
      (p) =>
        Array.isArray(p.shifts) &&
        p.shifts.map(String).includes(String(shiftId))
    );

    if (!payroll) {
      console.log(`[LATE-DEDUCTION] No payroll found for employee ${employeeId}`);
      return {
        processed: false,
        lateCount: 0,
        leavesDeducted: 0,
        message: "Payroll period not found"
      };
    }

    // Check if already processed
    const alreadyProcessed = await isLateDeductionProcessed(employeeId, periodStart, periodEnd);
    if (alreadyProcessed) {
      console.log(`[LATE-DEDUCTION] Already processed for ${employee.name}`);
      return {
        processed: false,
        lateCount: 0,
        leavesDeducted: 0,
        message: "Late deductions already processed for this period"
      };
    }

    // Count late sessions in this period
    const lateCount = await countLateSessionsInPeriod(employeeId, periodStart, periodEnd);

    if (lateCount === 0) {
      console.log(`[LATE-DEDUCTION] [${employee.name}] No late sessions found`);
      return {
        processed: true,
        lateCount: 0,
        leavesDeducted: 0,
        message: "No late sessions to process"
      };
    }

    // Calculate leaves to deduct: 3 late = 1 day
    const leavesToDeduct = Math.floor(lateCount / 3);

    if (leavesToDeduct === 0) {
      console.log(`[LATE-DEDUCTION] [${employee.name}] ${lateCount} late(s) found but not enough for full day deduction`);
      return {
        processed: true,
        lateCount,
        leavesDeducted: 0,
        message: `${lateCount} late sessions found but need 3 for 1 day deduction`
      };
    }

    // Get leave year
    const leaveYear = getLeaveYear(periodStart);

    // Get or create leave balance
    let balance = await LeaveYearBalance.findOne({
      owner: actualOwnerId,
      employee: employeeId,
      year: leaveYear,
    });

    if (!balance) {
      balance = await LeaveYearBalance.create({
        owner: actualOwnerId,
        employee: employeeId,
        year: leaveYear,
        total: 0,
        bonus: 0,
        bonusHoursAccumulated: 0,
        usedPaid: 0,
        usedUnpaid: 0,
        remainingPaid: 0,
        lastRecalculatedAt: new Date(),
      });
    }

    const totalEntitled = Number(balance.total || 0) + Number(balance.bonus || 0);
    const usedPaid = Number(balance.usedPaid || 0);
    const availableBalance = totalEntitled - usedPaid;

    let paidDeducted = 0;
    let unpaidDeducted = 0;

    // Deduct from paid leave first, then unpaid
    if (availableBalance >= leavesToDeduct) {
      paidDeducted = leavesToDeduct;
    } else if (availableBalance > 0) {
      paidDeducted = availableBalance;
      unpaidDeducted = leavesToDeduct - availableBalance;
    } else {
      unpaidDeducted = leavesToDeduct;
    }

    // Create leave transactions
    if (paidDeducted > 0) {
      await LeaveTransaction.create({
        owner: actualOwnerId,
        employee: employeeId,
        leaveYearBalance: balance._id,
        year: leaveYear,
        date: new Date(periodEnd),
        type: "PAID_LEAVE_USED",
        value: paidDeducted,
        sourceModel: "EmployeeSession",
        reason: `Late Deduction: ${lateCount} late sessions (${Math.floor(lateCount / 3)} days)`,
        createdBy: userId,
      });

      balance.usedPaid = usedPaid + paidDeducted;
    }

    if (unpaidDeducted > 0) {
      await LeaveTransaction.create({
        owner: actualOwnerId,
        employee: employeeId,
        leaveYearBalance: balance._id,
        year: leaveYear,
        date: new Date(periodEnd),
        type: "UNPAID_LEAVE_USED",
        value: unpaidDeducted,
        sourceModel: "EmployeeSession",
        reason: `Late Deduction: ${lateCount} late sessions (${Math.floor(lateCount / 3)} days)`,
        createdBy: userId,
      });

      balance.usedUnpaid = Number(balance.usedUnpaid || 0) + unpaidDeducted;
    }

    await balance.save();

    // Get salary slip for this period and update leave deductions
    const periodStartStr = periodStart.toISOString().split('T')[0];
    const periodEndStr = periodEnd.toISOString().split('T')[0];

    let slip = await SalarySlip.findOne({
      owner: actualOwnerId,
      employee: employeeId,
      date: { $gte: periodStart, $lte: periodEnd },
    });

    if (!slip) {
      // Create salary slip if doesn't exist
      slip = await SalarySlip.create({
        owner: actualOwnerId,
        employee: employeeId,
        date: new Date(periodEnd),
        month: periodEnd.getMonth() + 1,
        year: periodEnd.getFullYear(),
        leaveDeductions: await encrypt("0"),
      });
    }

    // Calculate per-day salary
    const salaries = await require("./salaryRetrieval").getSalaries(
      actualOwnerId,
      employeeId
    );
    let grossSalary = 0;
    if (salaries && salaries.gross) {
      const gross = await decrypt(salaries.gross);
      grossSalary = Number(gross) || 0;
    }

    const totalWorkingDays = 22;
    const perDayDeduction = Math.round((grossSalary / totalWorkingDays) * (paidDeducted + unpaidDeducted));

    // Update salary slip
    let prevDeduction = 0;
    if (slip.leaveDeductions) {
      prevDeduction = Number(await decrypt(slip.leaveDeductions)) || 0;
    }
    const totalDeduction = prevDeduction + perDayDeduction;
    slip.leaveDeductions = await encrypt(String(totalDeduction));
    slip.lateDeductionApplied = true;
    slip.lateCount = lateCount;
    slip.leavesDeductedFromLate = leavesToDeduct;
    await slip.save();

    // Mark one attendance record in this period with lateDeductionApplied flag
    await Attendance.updateMany(
      {
        owner: actualOwnerId,
        employee: employeeId,
        date: {
          $gte: periodStartStr,
          $lte: periodEndStr,
        },
      },
      {
        $set: { lateDeductionApplied: true },
      }
    );

    console.log(
      `[LATE-DEDUCTION] [${employee.name}] LateCount=${lateCount}, LeavesDeducted=${leavesToDeduct}, Paid=${paidDeducted}, Unpaid=${unpaidDeducted}, SlipDeduction=${perDayDeduction}`
    );

    return {
      processed: true,
      lateCount,
      leavesDeducted: leavesToDeduct,
      paidDeducted,
      unpaidDeducted,
      salaryDeduction: perDayDeduction,
      message: `Deducted ${leavesToDeduct} day(s) from ${lateCount} late session(s)`,
    };
  } catch (err) {
    console.error("[LATE-DEDUCTION] Error processing late deductions:", err);
    return {
      processed: false,
      lateCount: 0,
      leavesDeducted: 0,
      message: `Error: ${err.message}`,
    };
  }
}

/**
 * Check if it's last day of payroll period and process deductions
 * @param {Date} currentDate - Current date
 * @param {ObjectId} ownerId - Owner/Company ID
 * @param {ObjectId} employeeId - Employee ID
 * @param {ObjectId} userId - User ID
 * @returns {Promise<Object>} - Deduction result
 */
async function processIfLastDayOfPeriod(currentDate, ownerId, employeeId, userId) {
  // Get payroll period
  const allPayrolls = await PayrollPeriod.find({ owner: ownerId }).lean();
  if (!allPayrolls || allPayrolls.length === 0) {
    return { processed: false, message: "No payroll period found" };
  }

  let matchingPayroll = null;
  let periodStart = null;
  let periodEnd = null;

  for (const payroll of allPayrolls) {
    const shift = await require("../models/Shift").findById(
      payroll.shifts?.[0]
    );

    // Calculate period dates
    const anchor = new Date(payroll.payrollPeriodStartDay);
    let pStart, pEnd;

    if (payroll.payrollPeriodType === "monthly") {
      const anchorDay = anchor.getDate();
      const thisMonthStart = new Date(
        currentDate.getFullYear(),
        currentDate.getMonth(),
        anchorDay
      );

      if (currentDate >= thisMonthStart) {
        pStart = thisMonthStart;
      } else {
        pStart = new Date(
          currentDate.getFullYear(),
          currentDate.getMonth() - 1,
          anchorDay
        );
      }

      pEnd = new Date(
        pStart.getFullYear(),
        pStart.getMonth() + 1,
        pStart.getDate()
      );
      pEnd.setDate(pEnd.getDate() - 1);
    } else {
      let length = payroll.payrollPeriodLength;
      if (payroll.payrollPeriodType === "weekly") length = 7;
      if (payroll.payrollPeriodType === "bimonthly") length = 15;
      if (payroll.payrollPeriodType === "10-days") length = 10;

      const diff = Math.floor(
        (currentDate - anchor) / (1000 * 60 * 60 * 24)
      );
      const cycles = Math.floor(diff / length);

      pStart = new Date(anchor.getTime() + cycles * length * 1000 * 60 * 60 * 24);
      pEnd = new Date(
        pStart.getTime() + length * 1000 * 60 * 60 * 24 - 1000
      );
    }

    // Check if current date is last day of period
    if (
      currentDate.toISOString().split('T')[0] === pEnd.toISOString().split('T')[0]
    ) {
      matchingPayroll = payroll;
      periodStart = pStart;
      periodEnd = pEnd;
      break;
    }
  }

  if (!matchingPayroll) {
    return { processed: false, message: "Not last day of payroll period" };
  }

  // Process late deductions
  return await processLateDeductionsForPeriod(
    ownerId,
    employeeId,
    userId,
    periodStart,
    periodEnd,
    null
  );
}

/**
 * Apply real-time late deduction if count reaches multiple of 3
 */
async function applyRealTimeLateDeduction(employeeId, ownerId, userId, attendanceDate) {
  try {
    const employee = await Employee.findById(employeeId).lean();
    if (!employee) return;

    // 1. Find payroll period dates for the attendanceDate
    const allPayrolls = await PayrollPeriod.find({ owner: ownerId }).lean();
    const shiftId = employee.shifts?.[0];
    const payroll = allPayrolls.find(p =>
      Array.isArray(p.shifts) && p.shifts.map(String).includes(String(shiftId))
    );
    if (!payroll) return;

    // Calculate period dates (logic from attendanceController)
    const anchor = new Date(payroll.payrollPeriodStartDay);
    let pStart, pEnd;
    const d = new Date(attendanceDate);

    if (payroll.payrollPeriodType === "monthly") {
      const anchorDay = anchor.getDate();
      const thisMonthStart = new Date(d.getFullYear(), d.getMonth(), anchorDay);
      pStart = d >= thisMonthStart ? thisMonthStart : new Date(d.getFullYear(), d.getMonth() - 1, anchorDay);
      pEnd = new Date(pStart.getFullYear(), pStart.getMonth() + 1, pStart.getDate());
      pEnd.setDate(pEnd.getDate() - 1);
    } else {
      let length = payroll.payrollPeriodLength || 30; // fallback
      if (payroll.payrollPeriodType === "weekly") length = 7;
      const diff = Math.floor((d - anchor) / (1000 * 60 * 60 * 24));
      const cycles = Math.floor(diff / length);
      pStart = new Date(anchor.getTime() + cycles * length * 80000000); // approximate
      pStart = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() + cycles * length);
      pEnd = new Date(pStart);
      pEnd.setDate(pEnd.getDate() + length - 1);
    }

    const startStr = pStart.toISOString().slice(0, 10);
    const endStr = pEnd.toISOString().slice(0, 10);

    // 2. Count Lates in this period (including the one just created)
    const lateCount = await Attendance.countDocuments({
      employee: employeeId,
      status: "Late",
      date: { $gte: startStr, $lte: endStr }
    });

    if (lateCount === 0 || lateCount % 3 !== 0) return; // Only process on multiples of 3

    // 3. Find/Create Salary Slip for this period
    const payrollMonth = pEnd.toLocaleString("en-US", { month: "long" });
    const payrollYear = String(pEnd.getFullYear());

    let slip = await SalarySlip.findOne({
      owner: ownerId,
      employee: employeeId,
      month: payrollMonth,
      year: payrollYear
    });

    if (!slip) {
      // Minimal slip creation logic
      slip = await SalarySlip.create({
        owner: ownerId, employee: employeeId,
        month: payrollMonth, year: payrollYear,
        lateDeductionDaysCredited: 0,
        createdBy: userId
      });
    }

    const lateDeductionDays = Math.floor(lateCount / 3);
    const previouslyCredited = slip.lateDeductionDaysCredited || 0;
    const newDeductionDays = lateDeductionDays - previouslyCredited;

    if (newDeductionDays <= 0) return;

    // 4. Perform Deduction (Check Balance first)
    const leaveYear = getLeaveYear(attendanceDate);
    let balance = await LeaveYearBalance.findOne({ owner: ownerId, employee: employeeId, year: leaveYear });

    if (balance) {
      const totalEntitled = Number(balance.total || 0) + Number(balance.bonus || 0);
      const usedPaid = Number(balance.usedPaid || 0);
      const entitlementLeft = totalEntitled - usedPaid;

      if (entitlementLeft >= newDeductionDays) {
        // Use paid leaves
        balance.usedPaid += newDeductionDays;
        await LeaveTransaction.create({
          owner: ownerId, employee: employeeId, leaveYearBalance: balance._id,
          year: leaveYear, date: new Date(), type: "PAID_LEAVE_USED", value: newDeductionDays,
          reason: `Late Deduction (${lateCount} lates)`
        });
        console.log(`[LATE-DEDUCT] ${employee.name}: Used ${newDeductionDays} paid leaves`);
      } else {
        // Deduct Salary
        const Salaries = require("../models/Salaries");
        const salaryDoc = await Salaries.findOne({ employee: employeeId, owner: ownerId });
        if (salaryDoc) {
          const gross = Number(await decrypt(salaryDoc.basic)) + Number(await decrypt(salaryDoc.conveyanceAllowance || await encrypt("0"))) + Number(await decrypt(salaryDoc.medicalAllowance || await encrypt("0")));
          const perDay = gross / 22;
          const amount = Math.round(perDay * newDeductionDays);

          let prev = 0;
          if (slip.lateDeductions) prev = Number(await decrypt(slip.lateDeductions)) || 0;
          slip.lateDeductions = await encrypt(String(prev + amount));
          console.log(`[LATE-DEDUCT] ${employee.name}: Deducted ${amount} from salary`);
        }
      }
      slip.lateDeductionDaysCredited = lateDeductionDays;
      await balance.save();
      await slip.save();

      // LOG THE LATE RULE APPLICATION
      try {
        await logAttendanceChange({
          ownerId: ownerId,
          performerId: employeeId,
          performerType: 'System',
          performerName: "Late Rule Processor",
          employeeId: employeeId,
          attendanceDate: attendanceDate,
          oldStatus: "Late (accumulated)",
          newStatus: "Late Deduction Applied",
          oldLeaveType: "None",
          newLeaveType: "Late Deduction",
          outcome: `3-Day Late Rule Applied: ${newDeductionDays} day(s) deducted`,
          adjustedDays: newDeductionDays,
          details: `3-Day Late Rule Application (Total Lates: ${lateCount})`
        });
      } catch (logErr) { console.error("Late rule log error:", logErr); }
    }
  } catch (err) {
    console.error("[REALTIME-LATE-DEDUCTION] Error:", err);
  }
}

/**
 * Apply real-time half-day deduction (0.5 leave or salary)
 * @param {ObjectId} attendanceId - The ID of the attendance record (optional)
 */
async function applyRealTimeHalfDayDeduction(employeeId, ownerId, userId, attendanceDate, attendanceId = null, forceUnpaid = false) {
  try {
    const employee = await Employee.findById(employeeId).lean();
    if (!employee) return;

    // 1. Find payroll period (to get the right Salary Slip)
    const allPayrolls = await PayrollPeriod.find({ owner: ownerId }).lean();
    const shiftId = employee.shifts?.[0];
    const payroll = allPayrolls.find(p =>
      Array.isArray(p.shifts) && p.shifts.map(String).includes(String(shiftId))
    );
    if (!payroll) return;

    const anchor = new Date(payroll.payrollPeriodStartDay);
    const d = new Date(attendanceDate);
    let pEnd;

    if (payroll.payrollPeriodType === "monthly") {
      const anchorDay = anchor.getDate();
      const thisMonthStart = new Date(d.getFullYear(), d.getMonth(), anchorDay);
      pEnd = new Date(thisMonthStart.getFullYear(), thisMonthStart.getMonth() + 1, thisMonthStart.getDate());
      if (d < thisMonthStart) pEnd = new Date(thisMonthStart);
      pEnd.setDate(pEnd.getDate() - 1);
    } else {
      let length = payroll.payrollPeriodLength || 30;
      if (payroll.payrollPeriodType === "weekly") length = 7;
      const diff = Math.floor((d - anchor) / (1000 * 60 * 60 * 24));
      const cycles = Math.floor(diff / length);
      pEnd = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() + cycles * length + length - 1);
    }

    const payrollMonth = pEnd.toLocaleString("en-US", { month: "long" });
    const payrollYear = String(pEnd.getFullYear());

    // 2. Check Leave Balance
    const leaveYear = getLeaveYear(attendanceDate);
    let balance = await LeaveYearBalance.findOne({ owner: ownerId, employee: employeeId, year: leaveYear });

    if (!balance) return;

    const totalEntitled = Number(balance.total || 0) + Number(balance.bonus || 0);
    const usedPaid = Number(balance.usedPaid || 0);
    const entitlementLeft = totalEntitled - usedPaid;

    let slip = await SalarySlip.findOne({ owner: ownerId, employee: employeeId, month: payrollMonth, year: payrollYear });
    if (!slip) {
      slip = await SalarySlip.create({ owner: ownerId, employee: employeeId, month: payrollMonth, year: payrollYear, createdBy: userId });
    }

    // PREVENT DOUBLE DEDUCTION: Check if an ACTIVE deduction transaction exists (not reversed)
    // Look for PAID_LEAVE_USED or UNPAID_LEAVE_USED that hasn't been reversed yet
    // Get the most recent one to check its status
    const existingDeduction = await LeaveTransaction.findOne({
      employee: employeeId,
      date: new Date(attendanceDate),
      type: { $in: ["PAID_LEAVE_USED", "UNPAID_LEAVE_USED"] },
      reason: { $regex: /^Half Day/i }
    }).sort({ _id: -1 });

    if (existingDeduction) {
      // Check if this specific deduction has already been reversed
      const existingReversal = await LeaveTransaction.findOne({
        employee: employeeId,
        sourceId: existingDeduction._id,
        type: { $in: ["PAID_LEAVE_REVERSED", "UNPAID_LEAVE_REVERSED"] }
      });

      if (!existingReversal) {
        // Deduction exists and hasn't been reversed - skip creating new one
        console.log(`[HALF-DAY] Active deduction exists for ${employeeId} on ${attendanceDate}. Skipping duplicate.`);
        return;
      }
      // If reversal exists, we can create a new deduction (deduction was reversed, so we need new one)
      console.log(`[HALF-DAY] Previous deduction was reversed for ${employeeId} on ${attendanceDate}. Creating new deduction.`);
    }

    // Logic: Use paid leave only if NOT forced unpaid AND balance exists
    if (!forceUnpaid && entitlementLeft >= 0.5) {
      // Consume 0.5 paid leaves
      balance.usedPaid += 0.5;
      await LeaveTransaction.create({
        owner: ownerId, employee: employeeId, leaveYearBalance: balance._id,
        year: leaveYear, date: new Date(attendanceDate), type: "PAID_LEAVE_USED", value: 0.5,
        reason: "Half Day Login",
        sourceModel: "Attendance",
        sourceId: attendanceId,
        createdBy: userId
      });
      await Attendance.updateOne({ owner: ownerId, employee: employeeId, date: attendanceDate }, { $set: { leaveType: "Paid" } });
      console.log(`[HALF-DAY] ${employee.name}: Used 0.5 paid leaves`);
    } else {
      // Salary Deduction for 0.5 day
      const Salaries = require("../models/Salaries");
      const salaryDoc = await Salaries.findOne({ employee: employeeId, owner: ownerId });
      if (salaryDoc) {
        const gross = Number(await decrypt(salaryDoc.basic)) + (Number(await decrypt(salaryDoc.conveyanceAllowance || await encrypt("0"))) || 0) + (Number(await decrypt(salaryDoc.medicalAllowance || await encrypt("0"))) || 0);
        const perHalfDay = (gross / 22) * 0.5;

        let prev = 0;
        if (slip.leaveDeductions) prev = Number(await decrypt(slip.leaveDeductions)) || 0;
        slip.leaveDeductions = await encrypt(String(prev + Math.round(perHalfDay)));

        balance.usedUnpaid = (balance.usedUnpaid || 0) + 0.5;
        await LeaveTransaction.create({
          owner: ownerId, employee: employeeId, leaveYearBalance: balance._id,
          year: leaveYear, date: new Date(attendanceDate), type: "UNPAID_LEAVE_USED", value: 0.5,
          reason: forceUnpaid ? "Unpaid Half Day (Forced)" : "Half Day Login (No leave balance)",
          sourceModel: "System",
          sourceId: attendanceId,
          createdBy: userId
        });
      }
      await Attendance.updateOne({ owner: ownerId, employee: employeeId, date: attendanceDate }, { $set: { leaveType: "Unpaid" } });
      console.log(`[HALF-DAY] ${employee.name}: Deducted 0.5 day salary${forceUnpaid ? ' (FORCED UNPAID)' : ''}`);
    }
    await balance.save();
    await slip.save();
  } catch (err) {
    console.error("[REALTIME-HALF-DAY-DEDUCTION] Error:", err);
  }
}

/**
 * REVERSE half-day deductions when employee logs in again between shifts
 * Restores leave balance or salary deduction that was applied
 * Keeps original deduction transaction and creates reversal with sourceId reference
 */
async function reverseHalfDayDeduction(employeeId, ownerId, userId, attendanceDate) {
  try {
    const employee = await Employee.findById(employeeId).lean();
    if (!employee) return;

    // 1. Find payroll period
    const allPayrolls = await PayrollPeriod.find({ owner: ownerId }).lean();
    const shiftId = employee.shifts?.[0];
    const payroll = allPayrolls.find(p =>
      Array.isArray(p.shifts) && p.shifts.map(String).includes(String(shiftId))
    );
    if (!payroll) return;

    const anchor = new Date(payroll.payrollPeriodStartDay);
    const d = new Date(attendanceDate);
    let pEnd;

    if (payroll.payrollPeriodType === "monthly") {
      const anchorDay = anchor.getDate();
      const thisMonthStart = new Date(d.getFullYear(), d.getMonth(), anchorDay);
      pEnd = new Date(thisMonthStart.getFullYear(), thisMonthStart.getMonth() + 1, thisMonthStart.getDate());
      if (d < thisMonthStart) pEnd = new Date(thisMonthStart);
      pEnd.setDate(pEnd.getDate() - 1);
    } else {
      let length = payroll.payrollPeriodLength || 30;
      if (payroll.payrollPeriodType === "weekly") length = 7;
      const diff = Math.floor((d - anchor) / (1000 * 60 * 60 * 24));
      const cycles = Math.floor(diff / length);
      pEnd = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() + cycles * length + length - 1);
    }

    const payrollMonth = pEnd.toLocaleString("en-US", { month: "long" });
    const payrollYear = String(pEnd.getFullYear());

    // 2. Check Leave Balance
    const leaveYear = getLeaveYear(attendanceDate);
    let balance = await LeaveYearBalance.findOne({ owner: ownerId, employee: employeeId, year: leaveYear });

    if (!balance) return;

    const totalEntitled = Number(balance.total || 0) + Number(balance.bonus || 0);
    const usedPaid = Number(balance.usedPaid || 0);
    const entitlementLeft = totalEntitled - usedPaid;

    let slip = await SalarySlip.findOne({ owner: ownerId, employee: employeeId, month: payrollMonth, year: payrollYear });
    if (!slip) return;
    
    const leaveTransaction = await LeaveTransaction.findOne({
      owner: ownerId,
      employee: employeeId,
      date: new Date(attendanceDate),
      reason: { $regex: /^Half Day/i },
      type: { $in: ["PAID_LEAVE_USED", "UNPAID_LEAVE_USED"] }
    }).sort({ _id: -1 });

    if (!leaveTransaction) {
      console.log(`[REVERSAL] No half-day deduction transaction found for ${employee.name} on ${attendanceDate}`);
      return;
    }

    // Check if THIS SPECIFIC deduction has already been reversed
    const existingReversal = await LeaveTransaction.findOne({
      owner: ownerId,
      employee: employeeId,
      sourceId: leaveTransaction._id,
      type: { $in: ["PAID_LEAVE_REVERSED", "UNPAID_LEAVE_REVERSED"] }
    });

    if (existingReversal) {
      console.log(`[REVERSAL] Half-day already reversed for ${employee.name} on ${attendanceDate}. Skipping duplicate.`);
      return;
    }

    const reversalValue = leaveTransaction.value; // Should be 0.5

    if (leaveTransaction.type === "PAID_LEAVE_USED") {
      // Restore the paid leave
      balance.usedPaid = Math.max(0, Number(balance.usedPaid || 0) - reversalValue);

      // Create a reversal transaction with sourceId pointing to original deduction
      await LeaveTransaction.create({
        owner: ownerId,
        employee: employeeId,
        leaveYearBalance: balance._id,
        year: leaveYear,
        date: new Date(attendanceDate),
        type: "PAID_LEAVE_REVERSED",
        value: reversalValue,
        sourceModel: "LeaveTransaction",
        sourceId: leaveTransaction._id, // Reference to original deduction
        reason: "Half Day Reversal (Session Reactivated)"
      });

      console.log(`[REVERSAL] ${employee.name}: Restored ${reversalValue} paid leaves (Between-shift login)`);
    } else if (leaveTransaction.type === "UNPAID_LEAVE_USED") {
      // Restore unpaid leave count
      balance.usedUnpaid = Math.max(0, Number(balance.usedUnpaid || 0) - reversalValue);

      // Reverse the salary deduction from slip
      if (slip.leaveDeductions) {
        const Salaries = require("../models/Salaries");
        const salaryDoc = await Salaries.findOne({ employee: employeeId, owner: ownerId });
        if (salaryDoc) {
          const gross = Number(await decrypt(salaryDoc.basic)) + (Number(await decrypt(salaryDoc.conveyanceAllowance || await encrypt("0"))) || 0) + (Number(await decrypt(salaryDoc.medicalAllowance || await encrypt("0"))) || 0);
          const perHalfDay = (gross / 22) * 0.5;

          let currentDeduction = Number(await decrypt(slip.leaveDeductions)) || 0;
          const reversedDeduction = Math.max(0, currentDeduction - Math.round(perHalfDay));
          slip.leaveDeductions = await encrypt(String(reversedDeduction));
        }
      }

      // Create a reversal transaction with sourceId pointing to original deduction
      await LeaveTransaction.create({
        owner: ownerId,
        employee: employeeId,
        leaveYearBalance: balance._id,
        year: leaveYear,
        date: new Date(attendanceDate),
        type: "UNPAID_LEAVE_REVERSED",
        value: reversalValue,
        sourceModel: "LeaveTransaction",
        sourceId: leaveTransaction._id, // Reference to original deduction
        reason: "Half Day Reversal (Session Reactivated)"
      });

      console.log(`[REVERSAL] ${employee.name}: Reversed salary deduction (Between-shift login)`);
    }

    // DO NOT delete the original transaction - it stays as historical record
    // The reversal transaction references it via sourceId

    // Clear the leaveType from attendance
    await Attendance.updateOne(
      { owner: ownerId, employee: employeeId, date: attendanceDate },
      { $unset: { leaveType: 1 } }
    );

    await balance.save();
    await slip.save();
  } catch (err) {
    console.error("[REVERSE-HALF-DAY-DEDUCTION] Error:", err);
  }
}

/**
 * REVERSE late deductions when employee logs in again between shifts
 * Restores leave balance or salary deduction that was applied for being late
 * Keeps original deduction transaction and creates reversal with sourceId reference
 */
async function reverseLateDayDeduction(employeeId, ownerId, userId, attendanceDate) {
  try {
    const employee = await Employee.findById(employeeId).lean();
    if (!employee) return;

    // 1. Find payroll period
    const allPayrolls = await PayrollPeriod.find({ owner: ownerId }).lean();
    const shiftId = employee.shifts?.[0];
    const payroll = allPayrolls.find(p =>
      Array.isArray(p.shifts) && p.shifts.map(String).includes(String(shiftId))
    );
    if (!payroll) return;

    const anchor = new Date(payroll.payrollPeriodStartDay);
    const d = new Date(attendanceDate);
    let pEnd;

    if (payroll.payrollPeriodType === "monthly") {
      const anchorDay = anchor.getDate();
      const thisMonthStart = new Date(d.getFullYear(), d.getMonth(), anchorDay);
      pEnd = new Date(thisMonthStart.getFullYear(), thisMonthStart.getMonth() + 1, thisMonthStart.getDate());
      if (d < thisMonthStart) pEnd = new Date(thisMonthStart);
      pEnd.setDate(pEnd.getDate() - 1);
    } else {
      let length = payroll.payrollPeriodLength || 30;
      if (payroll.payrollPeriodType === "weekly") length = 7;
      const diff = Math.floor((d - anchor) / (1000 * 60 * 60 * 24));
      const cycles = Math.floor(diff / length);
      pEnd = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() + cycles * length + length - 1);
    }

    const payrollMonth = pEnd.toLocaleString("en-US", { month: "long" });
    const payrollYear = String(pEnd.getFullYear());

    // 2. Check Leave Balance
    const leaveYear = getLeaveYear(attendanceDate);
    let balance = await LeaveYearBalance.findOne({ owner: ownerId, employee: employeeId, year: leaveYear });

    if (!balance) return;

    let slip = await SalarySlip.findOne({ owner: ownerId, employee: employeeId, month: payrollMonth, year: payrollYear });
    if (!slip) return;

    // Find the LeaveTransaction created for late deduction
    const leaveTransaction = await LeaveTransaction.findOne({
      owner: ownerId,
      employee: employeeId,
      date: { $gte: new Date(attendanceDate + 'T00:00:00'), $lte: new Date(attendanceDate + 'T23:59:59') },
      reason: new RegExp("Late Deduction")
    });

    if (!leaveTransaction) {
      console.log(`[REVERSAL] No late deduction transaction found for ${employee.name} on ${attendanceDate}`);
      return;
    }

    // Check if reversal already exists for this deduction (prevent duplicates)
    const existingReversal = await LeaveTransaction.findOne({
      owner: ownerId,
      employee: employeeId,
      date: new Date(attendanceDate),
      sourceId: leaveTransaction._id,
      type: { $in: ["PAID_LEAVE_REVERSED", "UNPAID_LEAVE_REVERSED"] }
    });

    if (existingReversal) {
      console.log(`[REVERSAL] Late deduction already reversed for ${employee.name} on ${attendanceDate}. Skipping duplicate.`);
      return;
    }

    const reversalValue = leaveTransaction.value;

    if (leaveTransaction.type === "PAID_LEAVE_USED") {
      // Restore the paid leave
      balance.usedPaid = Math.max(0, Number(balance.usedPaid || 0) - reversalValue);

      // Create a reversal transaction with sourceId pointing to original deduction
      await LeaveTransaction.create({
        owner: ownerId,
        employee: employeeId,
        leaveYearBalance: balance._id,
        year: leaveYear,
        date: new Date(attendanceDate),
        type: "PAID_LEAVE_REVERSED",
        value: reversalValue,
        sourceModel: "LeaveTransaction",
        sourceId: leaveTransaction._id, // Reference to original deduction
        reason: "Between-Shift Login - Late Deduction Reversal"
      });

      console.log(`[REVERSAL] ${employee.name}: Restored ${reversalValue} paid leaves (Late reversal)`);
    } else if (leaveTransaction.type === "UNPAID_LEAVE_USED") {
      // Restore unpaid leave count
      balance.usedUnpaid = Math.max(0, Number(balance.usedUnpaid || 0) - reversalValue);

      // Reverse the salary deduction from slip
      if (slip.lateDeductions) {
        const Salaries = require("../models/Salaries");
        const salaryDoc = await Salaries.findOne({ employee: employeeId, owner: ownerId });
        if (salaryDoc) {
          const gross = Number(await decrypt(salaryDoc.basic)) + (Number(await decrypt(salaryDoc.conveyanceAllowance || await encrypt("0"))) || 0) + (Number(await decrypt(salaryDoc.medicalAllowance || await encrypt("0"))) || 0);
          const perDay = gross / 22;
          const deductionAmount = Math.round(perDay * reversalValue);

          let currentDeduction = Number(await decrypt(slip.lateDeductions)) || 0;
          const reversedDeduction = Math.max(0, currentDeduction - deductionAmount);
          slip.lateDeductions = await encrypt(String(reversedDeduction));
        }
      }

      // Create a reversal transaction with sourceId pointing to original deduction
      await LeaveTransaction.create({
        owner: ownerId,
        employee: employeeId,
        leaveYearBalance: balance._id,
        year: leaveYear,
        date: new Date(attendanceDate),
        type: "UNPAID_LEAVE_REVERSED",
        value: reversalValue,
        sourceModel: "LeaveTransaction",
        sourceId: leaveTransaction._id, // Reference to original deduction
        reason: "Between-Shift Login - Late Deduction Reversal"
      });

      console.log(`[REVERSAL] ${employee.name}: Reversed salary deduction for late (Between-shift login)`);
    }

    // DO NOT delete the original transaction - it stays as historical record
    // The reversal transaction references it via sourceId

    await balance.save();
    await slip.save();
  } catch (err) {
    console.error("[REVERSE-LATE-DEDUCTION] Error:", err);
  }
}

module.exports = {
  countLateSessionsInPeriod,
  isLateDeductionProcessed,
  processLateDeductionsForPeriod,
  processIfLastDayOfPeriod,
  getLeaveYear,
  applyRealTimeLateDeduction,
  applyRealTimeHalfDayDeduction,
  reverseHalfDayDeduction,
  reverseLateDayDeduction,
};