const mongoose = require("mongoose");
const EmployeeSession = require("../models/EmployeeSession");
const PayrollPeriod = require("../models/PayrollPeriod");
const Attendance = require("../models/Attendance");
const LeaveYearBalance = require("../models/LeaveYearBalance");
const LeaveTransaction = require("../models/LeaveTransaction");
const SalarySlip = require("../models/SalarySlip");
const Employee = require("../models/Employees");
const { decrypt, encrypt } = require("./encryption");

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

module.exports = {
  countLateSessionsInPeriod,
  isLateDeductionProcessed,
  processLateDeductionsForPeriod,
  processIfLastDayOfPeriod,
  getLeaveYear,
};
