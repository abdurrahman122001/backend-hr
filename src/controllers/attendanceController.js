// backend/src/controllers/attendanceController.js
const mongoose = require("mongoose");
const Employee = require("../models/Employees");
const PayrollPeriod = require("../models/PayrollPeriod");
const Shift = require("../models/Shift");
const Attendance = require("../models/Attendance");
const { decrypt, encrypt } = require("../utils/encryption");

const {
  updateLeaveEntitlementForEmployee,
  getLeaveYear,
} = require("../utils/leaveEntitlement");
const LoanDetail = require("../models/LoanDetail");
const LeaveYearBalance = require("../models/LeaveYearBalance");
const LeaveTransaction = require("../models/LeaveTransaction");
const AttendanceChangeLog = require("../models/AttendanceChangeLog");
const SalarySlip = require("../models/SalarySlip");
const { logAttendanceChange } = require("../utils/attendanceLogger");
const SpecificNonWorkingDay = require("../models/SpecificNonWorkingDay");

function getHoursDiff(checkIn, checkOut) {
  if (!checkIn || !checkOut) return 0;
  const [inH, inM] = checkIn.split(":").map(Number);
  const [outH, outM] = checkOut.split(":").map(Number);
  let diff = outH * 60 + outM - (inH * 60 + inM);
  // handle overnight (e.g. 22:00 to 06:00)
  if (diff < 0) diff += 24 * 60;
  return +(diff / 60).toFixed(2);
}

function resolveOwnerId(user) {
  return user?.owner || user?.createdBy || user?._id;
}

/**
 * getAttendanceBaseQuery
 * Returns a database query object that filters by owner and, if applicable, 
 * the delegated employee's allowed scope.
 */
function getAttendanceBaseQuery(req) {
  const ownerId = resolveOwnerId(req.user);
  const userId = req.user._id;

  const query = {
    owner: { $in: [oid(ownerId), oid(userId)] }
  };

  // If delegated employee has a restricted scope, apply it
  if (req.user.isDelegated && Array.isArray(req.user.attendanceScope) && req.user.attendanceScope.length > 0) {
    query.employee = { $in: req.user.attendanceScope.map(id => oid(id)) };
  }

  return query;
}

function oid(id) {
  return new mongoose.Types.ObjectId(id);
}

/**
 * Check if a date is a non-working day by checking:
 * 1. Recurring non-working days from PayrollPeriod
 * 2. Specific non-working days from SpecificNonWorkingDay collection
 */
async function isNonWorkingDayHelper(ownerId, date, payroll) {
  const ymd = (d) => d.toISOString().slice(0, 10);
  const attendanceDate = new Date(date);
  const dow = attendanceDate.getDay();
  
  // Check recurring non-working days from payroll
  const dateSet = new Set();
  const weekdaySet = new Set();
  const nameToDay = {
    sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2,
    wed: 3, weds: 3, wednesday: 3, thu: 4, thur: 4, thurs: 4, thursday: 4,
    fri: 5, friday: 5, sat: 6, saturday: 6,
  };
  
  (payroll.nonWorkingDays || []).forEach((raw) => {
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
    owner: oid(ownerId),
    date: ymd(attendanceDate),
  }).lean();
  
  return isRecurringNonWorkingDay || !!specificNwd;
}

async function ensureEmployeeAccessible(employeeId, ownerId, userId, attendanceScope = null) {
  // 1. Mandatory scope check for delegated employees
  if (attendanceScope && Array.isArray(attendanceScope) && attendanceScope.length > 0) {
    const inScope = attendanceScope.some(id => String(id) === String(employeeId));
    if (!inScope) return null;
  }

  // 2. Standard ownership check
  return Employee.findOne({
    _id: oid(employeeId),
    $or: [
      { owner: { $in: [ownerId, userId] } },
      { createdBy: { $in: [ownerId, userId] } },
    ],
  }).lean();
}

async function updateLeaveEntitlementForEmployeeProportional(
  ownerId,
  employeeId,
  date,
  daysToDeduct,
  type = "absent",
  forcePaid = false
) {
  const leaveYear = getLeaveYear(date);
  const balance = await LeaveYearBalance.findOne({
    owner: ownerId,
    employee: employeeId,
    year: leaveYear,
  });

  if (!balance) {
    return { paid: 0, unpaid: 0, isProportionate: false };
  }

  const totalEntitled = Number(balance.total || 0) + Number(balance.bonus || 0);
  const usedPaid = Number(balance.usedPaid || 0);
  const availableBalance = totalEntitled - usedPaid;

  let paidToUse = 0;
  let unpaidToUse = 0;
  let isProportionate = false;

  if (forcePaid) {
    paidToUse = daysToDeduct;
  } else if (availableBalance <= 0) {
    unpaidToUse = daysToDeduct;
  } else if (availableBalance >= daysToDeduct) {
    paidToUse = daysToDeduct;
  } else {
    paidToUse = availableBalance;
    unpaidToUse = daysToDeduct - availableBalance;
    isProportionate = true;
  }


  try {
    if (paidToUse > 0) {
      await LeaveTransaction.create(
        {
          owner: ownerId,
          employee: employeeId,
          leaveYearBalance: balance._id,
          year: leaveYear,
          date: new Date(date),
          type: "PAID_LEAVE_USED",
          value: paidToUse,
        },
      );

      balance.usedPaid = usedPaid + paidToUse;
    }

    if (unpaidToUse > 0) {
      await LeaveTransaction.create(
        {
          owner: ownerId,
          employee: employeeId,
          leaveYearBalance: balance._id,
          year: leaveYear,
          date: new Date(date),
          type: "UNPAID_LEAVE_USED",
          value: unpaidToUse,
        },
      );

      balance.usedUnpaid = Number(balance.usedUnpaid || 0) + unpaidToUse;
    }
    await balance.save();

    return {
      paid: paidToUse,
      unpaid: unpaidToUse,
      isProportionate,
    };
  } catch (err) {
    throw err;
  }
}

async function reverseOldBonus(oldRec) {
  if (!oldRec || !oldRec.bonusApplied || !oldRec.bonusHoursGiven) return;

  const ownerId = oldRec.owner;
  const employeeId = oldRec.employee;
  const year = getLeaveYear(oldRec.date);
  const bonusHoursToRemove = oldRec.bonusHoursGiven;

  // Get current balance
  const balance = await LeaveYearBalance.findOne({
    owner: ownerId,
    employee: employeeId,
    year: year,
  });

  let newAccumulated = (balance.bonusHoursAccumulated || 0) - bonusHoursToRemove;
  let newBonus = balance.bonus || 0;

  // Handle negative accumulated hours by reducing bonus days
  while (newAccumulated < 0 && newBonus > 0) {
    newBonus -= 1;
    newAccumulated += 9;
  }

  // Ensure accumulated doesn't go below 0
  if (newAccumulated < 0) {
    newAccumulated = 0;
  }

  // Calculate how many bonus days were lost (if any)
  const bonusDecrease = (balance.bonus || 0) - newBonus;

  // If bonus decreased, create reversal transaction
  if (bonusDecrease > 0) {
    await LeaveTransaction.create({
      owner: ownerId,
      employee: employeeId,
      leaveYearBalance: balance._id,
      year: year,
      date: new Date(),
      type: "ADJUSTMENT", // or you could create a "BONUS_REVERSED" type
      value: -bonusDecrease,
      sourceModel: "Attendance",
      createdBy: oldRec.createdBy,
    });
  }

  // Update LeaveYearBalance
  balance.bonus = newBonus;
  balance.bonusHoursAccumulated = newAccumulated;
  balance.lastRecalculatedAt = new Date();
  await balance.save();

  // Update attendance record to remove bonus flag
  await Attendance.updateOne(
    { _id: oldRec._id },
    { $set: { bonusApplied: false, bonusType: null, bonusHoursGiven: 0 } }
  );
}

/**
 * Reverses any leave balance or bonus effects of an attendance record.
 * Used when updating or deleting a record.
 */
async function reverseAttendanceEffects(record, slip = null, perDay = 0) {
  if (!record) return;

  const ownerId = resolveOwnerId(record);
  const employeeId = record.employee ? (record.employee._id || record.employee) : null;
  if (!employeeId) {
     // If no employee is attached (e.g., a Holiday record), there are no leave/bonus effects to reverse on a per-person basis.
     return;
  }
  const date = record.date;
  const status = record.status;
  const leaveType = record.leaveType;
  const bonusApplied = record.bonusApplied;
  const earlyDepartureDeduction = record.earlyDepartureDeduction;
  const bonusHoursDeducted = record.bonusHoursDeducted;
  const negativeHoursAdded = record.negativeHoursAdded;

  // 1. Reverse Bonus if applied
  if (bonusApplied) {
    await reverseOldBonus(record);
  }

  // 2. Reverse Early Departure Deduction if applied
  if (earlyDepartureDeduction && earlyDepartureDeduction > 0) {
    const year = getLeaveYear(date);
    const balance = await LeaveYearBalance.findOne({
      owner: ownerId,
      employee: employeeId,
      year: year,
    });

    if (balance) {
      let newAccumulated = (balance.bonusHoursAccumulated || 0) + (bonusHoursDeducted || 0);
      let newBonus = balance.bonus || 0;
      
      // Reverse negative hours if any were added
      if (negativeHoursAdded && negativeHoursAdded > 0) {
        newAccumulated += negativeHoursAdded;
      }

      // Convert back accumulated hours to bonus days if needed
      while (newAccumulated >= 9) {
        newBonus += 1;
        newAccumulated -= 9;

        // Create reversal transaction for bonus restored
        await LeaveTransaction.create({
          owner: ownerId,
          employee: employeeId,
          leaveYearBalance: balance._id,
          year: year,
          date: new Date(),
          type: "BONUS_RESTORED",
          value: 1,
          sourceModel: "Attendance",
          createdBy: record.createdBy,
        });
      }

      // Update LeaveYearBalance
      balance.bonus = newBonus;
      balance.bonusHoursAccumulated = newAccumulated;
      balance.lastRecalculatedAt = new Date();
      await balance.save();
    }

    // Clear early departure fields from attendance record
    await Attendance.updateOne(
      { _id: record._id },
      { $unset: { earlyDepartureDeduction: "", bonusHoursDeducted: "", negativeHoursAdded: "" } }
    );
  }

  // 3. Reverse Leave Balance usage (Paid/Unpaid)
  if (status === "Leave" || status === "Absent" || status === "Half Day" || status === "Unpaid Half Day") {
    let daysToReverse = 0;
    if (typeof record.effectivePaidDays === "number") {
      daysToReverse = record.effectivePaidDays;
    } else if (record.proportionate && typeof record.proportionateValue === "number") {
      daysToReverse = record.proportionateValue;
    } else if (status === "Half Day" || status === "Unpaid Half Day") {
      daysToReverse = 0.5;
    } else {
      daysToReverse = 1;
    }

    if (daysToReverse > 0) {
      const leaveYear = getLeaveYear(date);
      const balance = await LeaveYearBalance.findOne({
        owner: ownerId,
        employee: employeeId,
        year: leaveYear,
      });

      if (balance) {
        if (leaveType === "Paid") {
          balance.usedPaid = Math.max(0, Number((balance.usedPaid - daysToReverse).toFixed(2)));
          await LeaveTransaction.create({
            owner: ownerId,
            employee: employeeId,
            leaveYearBalance: balance._id,
            year: leaveYear,
            date: new Date(),
            type: "PAID_LEAVE_REVERSED",
            value: daysToReverse,
          });
        } else {
          // Unpaid
          balance.usedUnpaid = Math.max(0, Number((balance.usedUnpaid - daysToReverse).toFixed(2)));
          await LeaveTransaction.create({
            owner: ownerId,
            employee: employeeId,
            leaveYearBalance: balance._id,
            year: leaveYear,
            date: new Date(),
            type: "UNPAID_LEAVE_REVERSED",
            value: daysToReverse,
          });
        }
        await balance.save();
      }
    }
  }
}

async function updateBonusForNonWorkingDay(
  employeeId,
  checkIn,
  checkOut,
  date
) {
  const hours = getHoursDiff(checkIn, checkOut);

  // Get employee for owner info
  const employee = await Employee.findById(employeeId);
  if (!employee) return { bonus: 0, accumulated: 0 };

  const ownerId = employee.owner || employee.createdBy;
  const year = getLeaveYear(date);

  // Find or create LeaveYearBalance
  let balance = await LeaveYearBalance.findOne({
    owner: ownerId,
    employee: employeeId,
    year: year,
  });

  if (!balance) {
    // Create new balance record if doesn't exist
    balance = await LeaveYearBalance.create({
      owner: ownerId,
      employee: employeeId,
      year: year,
      total: 0,
      bonus: 0,
      bonusHoursAccumulated: 0,
      usedPaid: 0,
      usedUnpaid: 0,
      remainingPaid: 0,
      lastRecalculatedAt: new Date(),
    });
  }

  // Add bonus hours
  let newAccumulated = (balance.bonusHoursAccumulated || 0) + hours;
  let newBonus = balance.bonus || 0;

  // Convert accumulated hours to bonus days (every 9 hours = 1 bonus day)
  while (newAccumulated >= 9) {
    newBonus += 1;
    newAccumulated -= 9;

    // Create transaction for bonus earned
    await LeaveTransaction.create({
      owner: ownerId,
      employee: employeeId,
      leaveYearBalance: balance._id,
      year: year,
      date: new Date(date),
      type: "BONUS_EARNED",
      value: 1,
      sourceModel: "Attendance",
      createdBy: employee.createdBy,
    });
  }

  // Update LeaveYearBalance
  balance.bonus = newBonus;
  balance.bonusHoursAccumulated = newAccumulated;
  balance.lastRecalculatedAt = new Date();
  await balance.save();

  // Update attendance record
  await Attendance.updateOne(
    { employee: employeeId, date },
    {
      $set: {
        bonusApplied: true,
        bonusType: "NonWorkingDay",
        bonusHoursGiven: hours,
      },
    }
  );
  return { bonus: newBonus, accumulated: newAccumulated };
}

async function updateBonusForEarlyBird(
  employeeId,
  checkIn,
  shiftStart,
  shiftEnd,
  checkOut,
  date
) {
  // Early bird calculation logic (same as before)
  if (!checkIn || !shiftStart || !shiftEnd || !checkOut)
    return { bonus: null, accumulated: null };

  const toMin = (hhmm) => {
    const [hStr, mStr = "0"] = String(hhmm).trim().split(":");
    const h = Number(hStr);
    const m = Number(String(mStr).replace(/[^\d]/g, ""));
    if (Number.isNaN(h) || Number.isNaN(m)) return null;
    return h * 60 + m;
  };

  const inMin = toMin(checkIn);
  const startMin = toMin(shiftStart);
  const outMin = toMin(checkOut);
  const endMinRaw = toMin(shiftEnd);
  if (
    inMin == null ||
    startMin == null ||
    outMin == null ||
    endMinRaw == null
  ) {
    return { bonus: null, accumulated: null };
  }

  const earlyMinutes = startMin - inMin;
  if (earlyMinutes < 30) {
    return { bonus: null, accumulated: null };
  }

  let endMin = endMinRaw;
  let outMinNorm = outMin;
  if (endMin <= startMin) {
    endMin += 1440;
    if (outMin < startMin) outMinNorm += 1440;
  }

  // ✅ Removed checkout time restriction - bonus hours are added regardless of when employee leaves
  // Early bird hours are calculated based on checkin time only
  const earlyHours = +(earlyMinutes / 60).toFixed(2);

  // Get employee for owner info
  const employee = await Employee.findById(employeeId);
  if (!employee) return { bonus: null, accumulated: null };

  const ownerId = employee.owner || employee.createdBy;
  const year = getLeaveYear(date);

  // Find or create LeaveYearBalance
  let balance = await LeaveYearBalance.findOne({
    owner: ownerId,
    employee: employeeId,
    year: year,
  });

  if (!balance) {
    // Create new balance record if doesn't exist
    balance = await LeaveYearBalance.create({
      owner: ownerId,
      employee: employeeId,
      year: year,
      total: 0,
      bonus: 0,
      bonusHoursAccumulated: 0,
      usedPaid: 0,
      usedUnpaid: 0,
      remainingPaid: 0,
      lastRecalculatedAt: new Date(),
    });
  }

  // Add bonus hours
  let newAccumulated = (balance.bonusHoursAccumulated || 0) + earlyHours;
  let newBonus = balance.bonus || 0;

  // Convert accumulated hours to bonus days
  while (newAccumulated >= 9) {
    newBonus += 1;
    newAccumulated -= 9;

    // Create transaction for bonus earned
    await LeaveTransaction.create({
      owner: ownerId,
      employee: employeeId,
      leaveYearBalance: balance._id,
      year: year,
      date: new Date(date),
      type: "BONUS_EARNED",
      value: 1,
      sourceModel: "Attendance",
      createdBy: employee.createdBy,
    });
  }

  // Update LeaveYearBalance
  balance.bonus = newBonus;
  balance.bonusHoursAccumulated = newAccumulated;
  balance.lastRecalculatedAt = new Date();
  await balance.save();

  // Update attendance record
  await Attendance.updateOne(
    { employee: employeeId, date },
    {
      $set: {
        bonusApplied: true,
        bonusType: "EarlyBird",
        bonusHoursGiven: earlyHours,
      },
    }
  );
  return { bonus: newBonus, accumulated: newAccumulated };
}

async function deductBonusForEarlyDeparture(
  employeeId,
  checkIn,
  shiftStart,
  shiftEnd,
  checkOut,
  date
) {
  // Early departure calculation logic
  if (!checkIn || !shiftStart || !shiftEnd || !checkOut)
    return { deducted: 0, remainingBonus: null, negativeHours: 0 };

  const toMin = (hhmm) => {
    const [hStr, mStr = "0"] = String(hhmm).trim().split(":");
    const h = Number(hStr);
    const m = Number(String(mStr).replace(/[^\d]/g, ""));
    if (Number.isNaN(h) || Number.isNaN(m)) return null;
    return h * 60 + m;
  };

  const inMin = toMin(checkIn);
  const startMin = toMin(shiftStart);
  const outMin = toMin(checkOut);
  const endMinRaw = toMin(shiftEnd);
  
  if (
    inMin == null ||
    startMin == null ||
    outMin == null ||
    endMinRaw == null
  ) {
    return { deducted: 0, remainingBonus: null, negativeHours: 0 };
  }

  let endMin = endMinRaw;
  let outMinNorm = outMin;
  if (endMin <= startMin) {
    endMin += 1440;
    if (outMin < startMin) outMinNorm += 1440;
  }

  // Check if employee left early (more than 30 minutes before shift end)
  const earlyMinutes = endMin - outMinNorm;
  if (earlyMinutes <= 30) {
    return { deducted: 0, remainingBonus: null, negativeHours: 0 };
  }

  const earlyHours = +(earlyMinutes / 60).toFixed(2);

  // Get employee for owner info
  const employee = await Employee.findById(employeeId);
  if (!employee) return { deducted: 0, remainingBonus: null, negativeHours: 0 };

  const ownerId = employee.owner || employee.createdBy;
  const year = getLeaveYear(date);

  // Find or create LeaveYearBalance
  let balance = await LeaveYearBalance.findOne({
    owner: ownerId,
    employee: employeeId,
    year: year,
  });

  if (!balance) {
    // Create new balance record if doesn't exist
    balance = await LeaveYearBalance.create({
      owner: ownerId,
      employee: employeeId,
      year: year,
      total: 0,
      bonus: 0,
      bonusHoursAccumulated: 0,
      usedPaid: 0,
      usedUnpaid: 0,
      remainingPaid: 0,
      lastRecalculatedAt: new Date(),
    });
  }

  let deductedHours = 0;
  let negativeHours = 0;
  let newAccumulated = balance.bonusHoursAccumulated || 0;
  let newBonus = balance.bonus || 0;

  // First, try to deduct from accumulated hours
  if (newAccumulated >= earlyHours) {
    newAccumulated -= earlyHours;
    deductedHours = earlyHours;
  } else {
    // Use all accumulated hours first
    let remainingToDeduct = earlyHours - newAccumulated;
    deductedHours = newAccumulated;
    newAccumulated = 0;

    // Convert bonus days to hours (1 bonus day = 9 hours)
    while (remainingToDeduct > 0 && newBonus > 0) {
      newBonus -= 1;
      const hoursFromBonus = Math.min(9, remainingToDeduct);
      deductedHours += hoursFromBonus;
      remainingToDeduct -= hoursFromBonus;
    }

    // If still have remaining hours to deduct, add as negative hours
    if (remainingToDeduct > 0) {
      negativeHours = remainingToDeduct;
      newAccumulated -= remainingToDeduct; // This will make it negative
    }
  }

  // Create transaction for bonus deduction if any hours were deducted from bonus
  const bonusDaysDeducted = Math.floor((deductedHours - (balance.bonusHoursAccumulated || 0)) / 9);
  if (bonusDaysDeducted > 0) {
    await LeaveTransaction.create({
      owner: ownerId,
      employee: employeeId,
      leaveYearBalance: balance._id,
      year: year,
      date: new Date(date),
      type: "BONUS_DEDUCTED",
      value: -bonusDaysDeducted,
      sourceModel: "Attendance",
      createdBy: employee.createdBy,
    });
  }

  // Update LeaveYearBalance
  balance.bonus = newBonus;
  balance.bonusHoursAccumulated = newAccumulated;
  balance.lastRecalculatedAt = new Date();
  await balance.save();

  // Update attendance record
  await Attendance.updateOne(
    { employee: employeeId, date },
    {
      $set: {
        earlyDepartureDeduction: earlyHours,
        bonusHoursDeducted: deductedHours,
        negativeHoursAdded: negativeHours,
      },
    }
  );
  
  return { 
    deducted: deductedHours, 
    remainingBonus: newBonus, 
    negativeHours: negativeHours,
    totalEarlyHours: earlyHours
  };
}

async function getLeaveBalanceSnapshot(ownerId, employeeId, date) {
  const leaveYear = getLeaveYear(date);
  const balance = await LeaveYearBalance.findOne({
    owner: ownerId,
    employee: employeeId,
    year: leaveYear,
  }).lean();

  if (!balance) {
    return {
      total: 0,
      bonus: 0,
      usedPaid: 0,
      usedUnpaid: 0,
      remainingPaid: 0,
    };
  }

  const remaining = (balance.total || 0) + (balance.bonus || 0) - (balance.usedPaid || 0);

  return {
    total: balance.total || 0,
    bonus: balance.bonus || 0,
    usedPaid: balance.usedPaid || 0,
    usedUnpaid: balance.usedUnpaid || 0,
    remainingPaid: remaining,
  };
}

exports.markAttendance = async (req, res) => {
  try {
    const ownerId = resolveOwnerId(req.user);
    const userId = req.user._id;

    const {
      employeeId,
      date,
      status,
      checkIn,
      checkOut,
      notes,
      leaveType,
      isHoliday,
      challengeStatus,
      challengeAdminNotes,
    } = req.body;

    // ========= Helpers =========
    const allowanceFields = [
      "basic",
      "conveyanceAllowance",
      "medicalAllowance",
    ];

    const sumEncryptedFields = async (src, fields) => {
      let total = 0;
      let breakdown = {};

      for (const f of fields) {
        if (src && src[f]) {
          const n = Number(await decrypt(src[f])) || 0;
          total += n;
          breakdown[f] = n;
        } else {
          breakdown[f] = 0;
        }
      }
      return total;
    };

    // ========= Helper function for date formatting =========
    const ymd = (d) => d.toISOString().slice(0, 10);

    // ========= Specific Non-Working Day is managed via separate API =========
    // The isHoliday parameter is no longer supported. Use /api/specific-non-working-days instead.

    // ========= Employee (needed for logs) =========
    const employee = await ensureEmployeeAccessible(
      employeeId,
      ownerId,
      userId,
      req.user.attendanceScope
    );

    if (!employee) {
      return res
        .status(404)
        .json({ error: "Employee not found for this owner or unauthorized." });
    }

    // ========= Existing record (for reversals) =========
    const oldRec = await Attendance.findOne({
      owner: ownerId,
      employee: employeeId,
      date,
    }).lean();

    if (oldRec) {
      await reverseAttendanceEffects(oldRec);
    }


    // ========= Upsert attendance =========
    const updateDoc = {
      $set: {
        owner: ownerId,
        createdBy: userId,
        employee: employeeId,
        date,
        status,
        checkIn,
        checkOut,
        notes,
        markedByHR: true,
      },
    };

    if (challengeStatus) updateDoc.$set.challengeStatus = challengeStatus;
    if (challengeAdminNotes) updateDoc.$set.challengeAdminNotes = challengeAdminNotes;
    if (status === "Absent" || status === "Half Day" || status === "Unpaid Half Day") {
      updateDoc.$set.leaveType = (status === "Unpaid Half Day" ? "Unpaid" : (leaveType || "Unpaid"));
    } else {
      updateDoc.$unset = { leaveType: "" };
    }

    const rec = await Attendance.findOneAndUpdate(
      { owner: ownerId, employee: employeeId, date },
      updateDoc,
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    // LOG THE CHANGE
    try {
      let outcome = "None";
      let adjustedDays = 0;
      if (rec.status === "Half Day") adjustedDays = 0.5;
      else if (rec.status === "Absent" || rec.status === "Leave") adjustedDays = 1;
      
      if (rec.status === "Absent" || rec.status === "Half Day") {
        outcome = rec.leaveType === "Unpaid" ? "Salary Deduction" : "Leave Consumption";
      } else if (rec.status === "Leave") {
        outcome = rec.leaveType === "Paid" ? "Leave Consumption" : "Salary Deduction";
      } else if (rec.status === "Late") {
        outcome = "Potential Late Deduction";
      }

      let actualPerformerName = req.user.name;
      if (req.user.isDelegated && req.user.employeeId) {
        const delegatedPerformer = await Employee.findById(req.user.employeeId).select('name');
        if (delegatedPerformer) actualPerformerName = `${delegatedPerformer.name} (Delegated)`;
      }

      await logAttendanceChange({
        ownerId,
        performerId: req.user.employeeId || req.user._id,
        performerType: req.user.isDelegated ? 'Employee' : 'User',
        performerName: actualPerformerName || "Admin",
        employeeId: employeeId,
        attendanceDate: date,
        oldStatus: oldRec?.status,
        newStatus: rec.status,
        oldLeaveType: oldRec?.leaveType,
        newLeaveType: rec.leaveType,
        outcome: outcome,
        adjustedDays: adjustedDays,
        details: req.user.isDelegated ? "Marked by HR (via delegation)" : "Marked by HR"
      });
    } catch (logErr) {
      console.error("Failed to write to AttendanceChangeLog", logErr);
    }

    // ========= Payroll period =========
    const allPayrolls = await PayrollPeriod.find({ owner: ownerId }).lean();
    const shiftId = employee.shifts?.[0];
    const payroll = allPayrolls.find(
      (p) =>
        Array.isArray(p.shifts) &&
        p.shifts.map(String).includes(String(shiftId))
    );
    // ========= Non-working day guard =========
    // Checks both recurring (payroll) and specific (user-marked) non-working days
    const isNonWorkingDay = await isNonWorkingDayHelper(ownerId, date, payroll);

    if (isNonWorkingDay) {
      if (status !== "Present") {
        return res.status(400).json({
          error:
            "You can only mark Present on a non-working day. No leave, late, half day, or absent allowed.",
        });
      }
      const recNwd = await Attendance.findOneAndUpdate(
        { owner: ownerId, employee: employeeId, date },
        {
          $set: {
            owner: ownerId,
            createdBy: userId,
            employee: employeeId,
            date,
            status: "Present",
            checkIn,
            checkOut,
            notes,
            markedByHR: true,
            markedOnNonWorkingDay: true,
          },
          $unset: { leaveType: "" },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
      const { bonus, accumulated } = await updateBonusForNonWorkingDay(
        employeeId,
        checkIn,
        checkOut,
        date
      );
      return res.json(recNwd);
    }

    // ========= Early Bird Bonus =========
    if (status === "Present") {
      let shiftStart = null;
      let shiftEnd = null;

      const shiftId = employee.shifts?.[0];
      if (shiftId) {
        const shiftDoc = await Shift.findById(shiftId).lean();
        if (shiftDoc && shiftDoc.start) {
          shiftStart = shiftDoc.start;
        }
        if (shiftDoc && shiftDoc.end) {
          shiftEnd = shiftDoc.end;
        }
      }

      if (shiftStart && shiftEnd && checkIn && checkOut) {
        const { bonus, accumulated } = await updateBonusForEarlyBird(
          employeeId,
          checkIn,
          shiftStart,
          shiftEnd,
          checkOut,
          date
        );
      }
      // ✅ DISABLED: Early Departure Bonus Deduction
      // Removed completely - only early bird bonus is tracked now
      // Late sitting (hours after shift end) are completely ignored
    }

    // ========= Payroll period dates =========
    const attendanceDate = new Date(date);
    const anchor = new Date(payroll.payrollPeriodStartDay);
    let periodStart, periodEnd;
    if (payroll.payrollPeriodType === "monthly") {
      const anchorDay = anchor.getDate();
      const thisMonthStart = new Date(
        attendanceDate.getFullYear(),
        attendanceDate.getMonth(),
        anchorDay
      );
      if (attendanceDate >= thisMonthStart) {
        periodStart = thisMonthStart;
      } else {
        periodStart = new Date(
          attendanceDate.getFullYear(),
          attendanceDate.getMonth() - 1,
          anchorDay
        );
      }
      periodEnd = new Date(
        periodStart.getFullYear(),
        periodStart.getMonth() + 1,
        periodStart.getDate()
      );
      periodEnd.setDate(periodEnd.getDate() - 1);
    } else {
      let length = payroll.payrollPeriodLength;
      if (payroll.payrollPeriodType === "weekly") length = 7;
      if (payroll.payrollPeriodType === "bimonthly") length = 15;
      if (payroll.payrollPeriodType === "10-days") length = 10;
      const diff = Math.floor(
        (attendanceDate - anchor) / (1000 * 60 * 60 * 24)
      );
      const cycles = Math.floor(diff / length);
      periodStart = new Date(anchor);
      periodStart.setDate(anchor.getDate() + cycles * length);
      periodEnd = new Date(periodStart);
      periodEnd.setDate(periodEnd.getDate() + length - 1);
    }

    const joinDate = employee.joiningDate
      ? new Date(employee.joiningDate)
      : null;
    const effectiveStartDate =
      joinDate && joinDate > periodStart ? joinDate : periodStart;
    const start = effectiveStartDate.toISOString().slice(0, 10);
    const end = periodEnd.toISOString().slice(0, 10);
    const beforeJoin = !!(joinDate && attendanceDate < joinDate);
    const payrollMonth = periodEnd.toLocaleString("en-US", { month: "long" });
    const payrollYear = String(periodEnd.getFullYear());

    // ========= Skip SalarySlip creation - use fixed per-day calculation =========
    const totalWorkingDays = 22;
    const perDay = 0; // Set to 0 since we're not creating salary slips

    // ========= Auto-absent before join (skip non-working days) =========
    if (joinDate && joinDate > periodStart) {
      const dayMs = 24 * 60 * 60 * 1000;
      let daysToCharge = 0;

      for (
        let d = new Date(periodStart);
        d < joinDate;
        d = new Date(d.getTime() + dayMs)
      ) {
        const iso = ymd(d);
        // Check both recurring and specific non-working days
        const isNwd = await isNonWorkingDayHelper(ownerId, iso, payroll);
        if (isNwd) continue;

        const existing = await Attendance.findOne({
          owner: ownerId,
          date: iso,
        }).lean();
        if (existing) continue;

        await Attendance.findOneAndUpdate(
          { owner: ownerId, employee: employeeId, date: iso },
          {
            $set: {
              owner: ownerId,
              employee: employeeId,
              date: iso,
              status: "Absent",
              leaveType: "Unpaid",
              markedByHR: true,
              createdBy: userId,
            },
            $unset: { checkIn: "", checkOut: "", notes: "" },
          },
          { upsert: true, new: true, setDefaultsOnInsert: true }
        );
        daysToCharge += 1;
      }

      if (daysToCharge > 0) {
        const result = await updateLeaveEntitlementForEmployee(
          ownerId,
          employeeId,
          date,
          daysToCharge,
          "absent",
          true
        );
      }
    }

    // ========= ABSENT =========
    if (status === "Absent") {
      const dayMs = 24 * 60 * 60 * 1000;
      let nextNonWorkingCount = 0;
      for (
        let d = new Date(new Date(date).getTime() + dayMs);
        ;
        d = new Date(d.getTime() + dayMs)
      ) {
        const iso = ymd(d);
        // Check both recurring and specific non-working days
        const isNwd = await isNonWorkingDayHelper(ownerId, iso, payroll);
        if (isNwd) {
          nextNonWorkingCount += 1;
          continue;
        }
        break;
      }

      const effectiveDays = nextNonWorkingCount > 0 ? 1 + nextNonWorkingCount : 1;

      const balanceSnapshot = await getLeaveBalanceSnapshot(ownerId, employeeId, date);
      const totalEnt = (balanceSnapshot.total || 0) + (balanceSnapshot.bonus || 0);
      const usedPaid = balanceSnapshot.usedPaid || 0;
      const usedUnpaid = balanceSnapshot.usedUnpaid || 0;
      const balance = +(totalEnt - usedPaid);
      // --- Sandwich handling ---
      if (nextNonWorkingCount > 0) {
        if (leaveType === "Paid") {
          const result = await updateLeaveEntitlementForEmployeeProportional(
            ownerId,
            employeeId,
            date,
            effectiveDays,
            "leave",
            false
          );
          const unpaidDays = result.unpaid || 0;
          const paidDays = result.paid || 0;
          await Attendance.findOneAndUpdate(
            { owner: ownerId, employee: employeeId, date },
            { $set: { effectivePaidDays: paidDays } }
          );

          if (unpaidDays > 0) {
            await Attendance.findOneAndUpdate(
              { owner: ownerId, employee: employeeId, date },
              { $set: { leaveType: "Paid", proportionate: true } }
            );
          } else {
            await Attendance.findOneAndUpdate(
              { owner: ownerId, employee: employeeId, date },
              {
                $set: {
                  status: "Absent",
                  leaveType: "Paid",
                  proportionate: false,
                },
              }
            );
          }
        } else {
          await updateLeaveEntitlementForEmployee(
            ownerId,
            employeeId,
            date,
            effectiveDays,
            "absent",
            true
          );
          await Attendance.findOneAndUpdate(
            { owner: ownerId, employee: employeeId, date },
            { $set: { leaveType: "Unpaid", proportionate: false } }
          );
          return res.json(rec);
        }
      }

      if (leaveType === "Paid" && balance > 0 && balance < 1) {
        const result = await updateLeaveEntitlementForEmployeeProportional(
          ownerId,
          employeeId,
          date,
          1,
          "leave",
          false
        );

        await Attendance.findOneAndUpdate(
          { owner: ownerId, employee: employeeId, date },
          { $set: { leaveType: "Paid", proportionate: true } }
        );
        return res.json(rec);
      }

      // Full paid absent
      if (leaveType === "Paid" && balance >= 1) {
        await updateLeaveEntitlementForEmployee(
          ownerId,
          employeeId,
          date,
          1,
          "leave",
          req.body.forcePaid
        );
        await Attendance.findOneAndUpdate(
          { owner: ownerId, employee: employeeId, date },
          {
            $set: { status: "Absent", leaveType: "Paid", proportionate: false },
          }
        );

        await Attendance.findOneAndUpdate(
          { owner: ownerId, employee: employeeId, date },
          {
            $set: {
              status: "Absent",
              leaveType: "Paid",
              proportionate: false,
            },
          }
        );
      }
    }

    // ========= LEAVE =========
    if (status === "Leave") {
      const dayMs = 24 * 60 * 60 * 1000;
      let nextNonWorkingCountForLeave = 0;
      for (
        let d = new Date(new Date(date).getTime() + dayMs);
        ;
        d = new Date(d.getTime() + dayMs)
      ) {
        const iso = ymd(d);
        // Check both recurring and specific non-working days
        const isNwd = await isNonWorkingDayHelper(ownerId, iso, payroll);
        if (isNwd) {
          nextNonWorkingCountForLeave += 1;
          continue;
        }
        break;
      }

      const effectiveDays = nextNonWorkingCountForLeave > 0 ? 1 + nextNonWorkingCountForLeave : 1;

      const balanceSnapshot = await getLeaveBalanceSnapshot(ownerId, employeeId, date);
      const totalBal = (balanceSnapshot.total || 0) + (balanceSnapshot.bonus || 0);
      const usedPaid = balanceSnapshot.usedPaid || 0;
      const usedUnpaid = balanceSnapshot.usedUnpaid || 0;
      const balance = +(totalBal - usedPaid);

      // Proportionate case
      if (balance > 0 && balance < effectiveDays) {
        const result = await updateLeaveEntitlementForEmployeeProportional(
          ownerId,
          employeeId,
          date,
          effectiveDays,
          "leave",
          false
        );

        await Attendance.findOneAndUpdate(
          { owner: ownerId, employee: employeeId, date },
          {
            $set: {
              status: "Absent",
              leaveType: "Paid",
              effectivePaidDays: result.paid || 0,
              proportionate: true,
            },
          }
        );
        return res.json(rec);
      }

      // Fully covered by paid balance
      if (balance >= effectiveDays) {
        await updateLeaveEntitlementForEmployee(
          ownerId,
          employeeId,
          date,
          effectiveDays,
          "leave",
          req.body.forcePaid
        );
        await Attendance.findOneAndUpdate(
          { owner: ownerId, employee: employeeId, date },
          {
            $set: {
              status: "Absent",
              leaveType: "Paid",
              effectivePaidDays: effectiveDays,
              proportionate: false,
            },
          }
        );
        return res.json(rec);
      }

      // No balance left
      if (typeof req.body.forcePaid === "undefined") {
        return res.status(200).json({
          needsConfirmation: true,
          message: `${employee.name} has no paid leaves available.Do you want to mark as Paid Leave ? `,
        });
      } else if (req.body.forcePaid === true) {
        await updateLeaveEntitlementForEmployee(
          ownerId,
          employeeId,
          date,
          effectiveDays,
          "leave",
          true
        );
        await Attendance.findOneAndUpdate(
          { owner: ownerId, employee: employeeId, date },
          { $set: { status: "Absent", leaveType: "Paid" } }
        );
        return res.json(rec);
      } else {
        await updateLeaveEntitlementForEmployee(
          ownerId,
          employeeId,
          date,
          effectiveDays,
          "absent",
          true
        );

        await Attendance.findOneAndUpdate(
          { owner: ownerId, employee: employeeId, date },
          { $set: { status: "Absent", leaveType: "Unpaid" } }
        );
        return res.json(rec);
      }
    }

    // ========= LATE handling =========
    if (oldRec && oldRec.status === "Late" && status !== "Late" && !beforeJoin) {
      const lateRecordsNow = await Attendance.find({
        employee: employeeId,
        owner: ownerId,
        date: { $gte: start, $lte: end },
        status: "Late",
      }).lean();

      const lateCountNow = lateRecordsNow.length;
      const lateDeductionDaysNow = Math.floor(lateCountNow / 3);

      // Get the salary slip to check previously credited late deductions
      const payrollMonthNow = periodEnd.toLocaleString("en-US", { month: "long" });
      const payrollYearNow = String(periodEnd.getFullYear());
      const slipNow = await SalarySlip.findOne({
        owner: ownerId,
        employee: employeeId,
        month: payrollMonthNow,
        year: payrollYearNow
      });
      const previouslyCredited = slipNow?.lateDeductionDaysCredited || 0;

      if (lateDeductionDaysNow < previouslyCredited) {
        const daysToReverse = previouslyCredited - lateDeductionDaysNow;
        if (daysToReverse >= 1) {
          const propRec = await Attendance.findOne({
            employee: employeeId,
            owner: ownerId,
            date: { $gte: start, $lte: end },
            proportionate: true,
          }).sort({ date: -1 });
          if (propRec) {
            await Attendance.updateOne({ _id: propRec._id }, { $set: { proportionate: false } });
          }
        }
      }
    }
    
    if (!beforeJoin && status === "Late") {      
      const lateRecords = await Attendance.find({
        employee: employeeId,
        owner: ownerId,
        date: { $gte: start, $lte: end },
        status: "Late",
      }).lean();

      const lateCount = lateRecords.length;
      const totalDeductionDays = Math.floor(lateCount / 3);

      // Get previously credited late deductions from SalarySlip
      const payrollMonth = periodEnd.toLocaleString("en-US", { month: "long" });
      const payrollYear = String(periodEnd.getFullYear());
      let previouslyCredited = 0;
      try {
        const slip = await SalarySlip.findOne({
          owner: ownerId,
          employee: employeeId,
          month: payrollMonth,
          year: payrollYear
        });
        previouslyCredited = slip?.lateDeductionDaysCredited || 0;
      } catch (err) {
        console.error("[LATE] Error fetching SalarySlip:", err.message);
      }
      
      const newLateDeductionDays = totalDeductionDays - previouslyCredited;

      if (newLateDeductionDays > 0) {
        // Deduct the new late deduction days
        const result = await updateLeaveEntitlementForEmployee(
          ownerId,
          employeeId,
          date,
          newLateDeductionDays,
          "late"
        );

        // Update SalarySlip to track newly credited deductions
        try {
          const slip = await SalarySlip.findOne({
            owner: ownerId,
            employee: employeeId,
            month: payrollMonth,
            year: payrollYear
          });
          if (slip) {
            slip.lateDeductionDaysCredited = totalDeductionDays;
            await slip.save();
          } else {
            // Create new salary slip if doesn't exist
            await SalarySlip.create({
              owner: ownerId,
              employee: employeeId,
              month: payrollMonth,
              year: payrollYear,
              lateDeductionDaysCredited: totalDeductionDays
            });
          }
        } catch (err) {
          console.error("[LATE] Error updating SalarySlip:", err.message);
        }
      }
    }

    if (!beforeJoin && (status === "Half Day" || status === "Unpaid Half Day")) {
      const isExplicitUnpaid = (status === "Unpaid Half Day" || leaveType === "Unpaid");

      if (!isExplicitUnpaid) {
        // PAID case: deduct from balance (debt allowed as per current full-day leave logic)
        await updateLeaveEntitlementForEmployee(
          ownerId,
          employeeId,
          date,
          0.5,
          "leave", // "leave" type forces addPaid = deductionCount in utils
          false
        );
        await Attendance.updateOne(
          { owner: ownerId, employee: employeeId, date },
          { $set: { leaveType: "Paid", status: "Half Day" } }
        );
      } else {
        // UNPAID case: salary deduction
        await updateLeaveEntitlementForEmployee(
          ownerId,
          employeeId,
          date,
          0.5,
          "absent",
          true // forceUnpaid = true forces addUnpaid = deductionCount in utils
        );
      }
      return res.json(rec);
    }

    // ========= Loans this month (kept as in your flow) =========
    const monthName = payrollMonth;
    const yearNum = Number(payrollYear);
    const loans = await LoanDetail.find({ employee: employeeId }).lean();

    let totalLoanInstallments = 0;
    let totalLoanBenefits = 0;

    for (const loan of loans) {
      if (!Array.isArray(loan.paymentSchedule)) continue;
      const row = loan.paymentSchedule.find(
        (ps) => ps?.month === monthName && Number(ps?.year) === yearNum
      );
      if (!row) continue;

      let installmentAmount = 0;
      if (row.totalPayment) {
        installmentAmount = Number(await decrypt(row.totalPayment)) || 0;
      } else if (loan.monthlyInstallment) {
        installmentAmount = Number(await decrypt(loan.monthlyInstallment)) || 0;
      }
      totalLoanInstallments += installmentAmount;

      if (row.markupAmount) {
        const markupAmt = Number(await decrypt(row.markupAmount)) || 0;
        totalLoanBenefits += markupAmt;
      }
    }

    // ========= Final snapshot =========
    const leaveDedVal = 0;
    const lateDedVal = 0;

    const currentBalance = await getLeaveBalanceSnapshot(ownerId, employeeId, date);
    const usedPaidNow = currentBalance.usedPaid || 0;
    const usedUnpaidNow = currentBalance.usedUnpaid || 0;

    return res.json(rec);
  } catch (err) {
    console.error("[MARK-ATTENDANCE-ERROR]", err);
    console.error("[MARK-ATTENDANCE-STACK]", err.stack);
    return res.status(400).json({ error: err.message, stack: err.stack });
  }
};

// GET /api/attendance?date=YYYY-MM-DD
exports.getRecordsByDate = async (req, res) => {
  const { date } = req.query;
  if (!date) {
    return res.status(400).json({ error: "date query parameter is required" });
  }
  try {
    const ownerId = resolveOwnerId(req.user);
    const query = {
      ...getAttendanceBaseQuery(req),
      date,
    };

    const records = await Attendance.find(query)
      .populate("employee", "name designation department email status _id photographUrl imageUrl")
      .lean();

    res.json(records);
  } catch (err) {
    console.error("Error in getRecordsByDate:", err);
    res.status(500).json({ error: err.message });
  }
};

// GET /api/attendance?from=YYYY-MM-DD&to=YYYY-MM-DD
exports.getRecordsByDateRange = async (req, res) => {
  const { from, to, startDate, endDate } = req.query;
  const start = from || startDate;
  const end = to || endDate;

  if (!start || !end) {
    return res.status(400).json({ error: "Both 'start' and 'end' dates are required" });
  }
  try {
    const ownerId = resolveOwnerId(req.user);
    const userId = req.user._id;

    const records = await Attendance.find({
      owner: { $in: [oid(ownerId), oid(userId)] },
      date: { $gte: start, $lte: end },
    })
      .populate("employee", "name position department email status _id photographUrl imageUrl")
      .lean();

    res.json(records);
  } catch (err) {
    console.error("Error in getRecordsByDateRange:", err);
    res.status(500).json({ error: err.message });
  }
};

// GET /api/attendance/stats?date=YYYY-MM-DD
exports.getStats = async (req, res) => {
  try {
    const { date } = req.query;
    const query = {
      ...getAttendanceBaseQuery(req),
      date
    };

    const stats = await Attendance.aggregate([
      {
        $match: query,
      },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]);

    const result = { present: 0, late: 0, halfDay: 0, absent: 0, total: 0 };
    stats.forEach(({ _id, count }) => {
      if (typeof _id !== "string") return;
      const key = _id === "Half Day" ? "halfDay" : _id.toLowerCase();
      result[key] = count;
      result.total += count;
    });

    res.json(result);
  } catch (err) {
    console.error("Error in getStats:", err);
    res.status(500).json({ error: err.message });
  }
};

// GET /api/attendance/employee/:id
exports.getRecordsByEmployee = async (req, res) => {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) {
    return res.status(400).json({ error: "Invalid employee ID" });
  }
  try {
    const ownerId = resolveOwnerId(req.user);
    const userId = req.user._id;

    // guard: ensure employee belongs to tenant (new/legacy)
    const emp = await ensureEmployeeAccessible(id, ownerId, userId, req.user.attendanceScope);
    if (!emp) {
      return res
        .status(404)
        .json({ error: "Employee not found or unauthorized (check delegation scope)" });
    }

    const query = {
      ...getAttendanceBaseQuery(req),
      employee: oid(id),
    };

    const records = await Attendance.find(query)
      .sort({ date: 1 })
      .populate("employee", "name position department email status _id photographUrl imageUrl")
      .lean();

    res.json(records);
  } catch (err) {
    console.error("Error in getRecordsByEmployee:", err);
    res.status(500).json({ error: err.message });
  }
};

// GET /api/attendance/employee/:id/stats?from=...&to=...
exports.getStatsByEmployee = async (req, res) => {
  const { id } = req.params;
  const { from, to } = req.query;
  if (!mongoose.isValidObjectId(id)) {
    return res.status(400).json({ error: "Invalid employee ID" });
  }
  try {
    const ownerId = resolveOwnerId(req.user);
    const userId = req.user._id;

    // guard
    const emp = await ensureEmployeeAccessible(id, ownerId, userId);
    if (!emp) {
      return res
        .status(404)
        .json({ error: "Employee not found or unauthorized" });
    }

    const match = {
      owner: { $in: [oid(ownerId), oid(userId)] },
      employee: oid(id),
    };
    if (from && to) {
      match.date = { $gte: from, $lte: to };
    }

    const stats = await Attendance.aggregate([
      { $match: match },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]);

    const result = { present: 0, late: 0, halfDay: 0, absent: 0, total: 0 };
    stats.forEach(({ _id, count }) => {
      if (typeof _id !== "string") return;
      const key = _id === "Half Day" ? "halfDay" : _id.toLowerCase();
      result[key] = count;
      result.total += count;
    });

    res.json(result);
  } catch (err) {
    console.error("Error in getStatsByEmployee:", err);
    res.status(500).json({ error: err.message });
  }
};

exports.deleteRecord = async (req, res) => {
  const { id } = req.params;
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(400).json({ error: "Invalid record ID" });
  }
  try {
    const ownerId = resolveOwnerId(req.user);
    const userId = req.user._id;

    const record = await Attendance.findOne({
      _id: id,
      owner: { $in: [oid(ownerId), oid(userId)] },
    });

    if (!record) {
      return res.status(404).json({ error: "Record not found" });
    }

    // Step 1: Reverse any special effects (Leave, Bonus, etc.)
    await reverseAttendanceEffects(record);

    // Step 2: Delete the record
    await Attendance.deleteOne({ _id: id });

    try {
      await logAttendanceChange(req.user, record.employee, record.date, record.status, "Deleted", record.leaveType, "None", "Reversal (Deleted)");
    } catch (logErr) {
      console.error("Failed to write to AttendanceChangeLog", logErr);
    }

    res.json({ success: true, message: "Attendance record deleted and affects reversed." });
  } catch (err) {
    console.error("Error in deleteRecord:", err);
    res.status(500).json({ error: err.message });
  }
};

// GET /api/attendance/change-logs (or /audit-logs)
exports.getChangeLogs = async (req, res) => {
  try {
    const ownerId = resolveOwnerId(req.user);
    const { startDate, endDate, employeeId, page = 1, limit = 50 } = req.query;

    const query = { owner: ownerId };
    if (employeeId) query.employee = employeeId;
    
    if (startDate && endDate) {
      // Create date objects for start and end of range in the log's createdAt timestamp
      const start = new Date(startDate);
      start.setHours(0, 0, 0, 0);
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      
      query.createdAt = {
        $gte: start,
        $lte: end
      };
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const totalCount = await AttendanceChangeLog.countDocuments(query);
    const totalPages = Math.ceil(totalCount / parseInt(limit));

    const logs = await AttendanceChangeLog.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .lean();

    res.json({
      logs,
      pagination: {
        total: totalCount,
        pages: totalPages,
        currentPage: parseInt(page),
        limit: parseInt(limit)
      }
    });
  } catch (err) {
    console.error("Error fetching change logs:", err);
    res.status(500).json({ error: err.message });
  }
};

// ✅ Removed: exports.deductBonusForEarlyDeparture = deductBonusForEarlyDeparture;
// Early departure deduction has been disabled - only early bird bonus is tracked now

exports.updateChallengeStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { challengeStatus, challengeAdminNotes } = req.body;
    const ownerId = resolveOwnerId(req.user);

    const attendance = await Attendance.findOneAndUpdate(
      { _id: id, owner: ownerId },
      { 
        $set: { 
          challengeStatus, 
          challengeAdminNotes,
          challengeAt: new Date()
        } 
      },
      { new: true }
    );

    if (!attendance) {
      return res.status(404).json({ error: "Attendance record not found" });
    }

    res.json({ success: true, attendance });
  } catch (err) {
    console.error("Update challenge status failed:", err);
    res.status(500).json({ error: "Failed to update challenge status" });
  }
};