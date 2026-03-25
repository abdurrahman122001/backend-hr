// backend/src/controllers/attendanceController.js
const mongoose = require("mongoose");
const { backfillForDate } = require("../backfillAttendance");
const Employee = require("../models/Employees");
const PayrollPeriod = require("../models/PayrollPeriod");
const Shift = require("../models/Shift");
const SalarySlip = require("../models/SalarySlip");
const Attendance = require("../models/Attendance");
const { decrypt, encrypt } = require("../utils/encryption");
const taxController = require("./taxController");

const {
  updateLeaveEntitlementForEmployee,
  getLeaveYear,
} = require("../utils/leaveEntitlement");
const Salaries = require("../models/Salaries");
const LoanDetail = require("../models/LoanDetail");
const LeaveYearBalance = require("../models/LeaveYearBalance");
const LeaveTransaction = require("../models/LeaveTransaction");

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

  if (!balance) {
    console.log(`[BONUS-REVERSAL] No balance record found for reversal`);
    return;
  }

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

  console.log(
    `[BONUS-REVERSAL] Employee=${employeeId} Bonus=${newBonus}, Accumulated=${newAccumulated}`
  );
}

/**
 * Reverses any leave balance or bonus effects of an attendance record.
 * Used when updating or deleting a record.
 */
async function reverseAttendanceEffects(record, slip = null, perDay = 0) {
  if (!record) return;

  const ownerId = resolveOwnerId(record);
  const employeeId = record.employee._id || record.employee;
  const date = record.date;
  const status = record.status;
  const leaveType = record.leaveType;
  const bonusApplied = record.bonusApplied;

  // 1. Reverse Bonus if applied
  if (bonusApplied) {
    await reverseOldBonus(record);
  }

  // 2. Reverse Leave Balance usage (Paid/Unpaid)
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
          console.log(`[REVERSAL] [${employeeId}] Reversed ${daysToReverse} Paid Leave`);
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

          // If Unpaid and we have a slip, reverse the deduction
          if (slip && perDay > 0) {
            if (!slip.leaveDeductions) slip.leaveDeductions = await encrypt("0");
            let prevDeduction = Number(await decrypt(slip.leaveDeductions)) || 0;
            const deductionToReverse = Math.round(perDay * daysToReverse);
            let newDeduction = Math.max(0, prevDeduction - deductionToReverse);
            slip.leaveDeductions = await encrypt(newDeduction.toString());
            await slip.save();
            console.log(`[REVERSAL] [${employeeId}] Reversed ${daysToReverse} Unpaid Leave Deduction: ${deductionToReverse}`);
          }
          console.log(`[REVERSAL] [${employeeId}] Reversed ${daysToReverse} Unpaid Leave`);
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

  console.log(`[BONUS-UPDATE] NonWorkingDay -> Bonus=${newBonus}, Accumulated=${newAccumulated}`);
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

  if (outMinNorm < endMin) {
    return { bonus: null, accumulated: null };
  }

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

  console.log(`[BONUS-UPDATE] EarlyBird -> Bonus=${newBonus}, Accumulated=${newAccumulated}`);
  return { bonus: newBonus, accumulated: newAccumulated };
}

async function getLeaveBalanceSnapshot(ownerId, employeeId, date) {
  const leaveYear = getLeaveYear(date);
  const balance = await LeaveYearBalance.findOne({
    owner: ownerId,
    employee: employeeId,
    year: leaveYear,
  }).lean();

  console.log(`[DEBUG-BALANCE] Year=${leaveYear}, Found=${!!balance}`);
  if (balance) {
    console.log(`[DEBUG-BALANCE-DETAILS] Total=${balance.total}, Bonus=${balance.bonus}, UsedPaid=${balance.usedPaid}, BonusHoursAccumulated=${balance.bonusHoursAccumulated}`);
  }

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
  console.log(`[DEBUG-BALANCE-CALC] RemainingPaid = ${balance.total} + ${balance.bonus} - ${balance.usedPaid} = ${remaining}`);

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

      console.log("[GROSS BREAKDOWN]", breakdown, "Total =", total);
      return total;
    };

    // ========= Holiday (tenant-scoped, no employee) =========
    if (isHoliday) {
      console.log(`[HOLIDAY] Marking Holiday -> ${date}`);

      await Attendance.deleteMany({
        owner: ownerId,
        employee: { $exists: true },
        date,
      });

      const rec = await Attendance.findOneAndUpdate(
        { owner: ownerId, date, isHoliday: true },
        {
          $set: {
            owner: ownerId,
            date,
            isHoliday: true,
            markedByHR: true,
            createdBy: userId,
          },
          $unset: {
            employee: "",
            status: "",
            checkIn: "",
            checkOut: "",
            notes: "",
            leaveType: "",
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );

      console.log(`[HOLIDAY] Overriding all employee attendance for ${date}`);
      return res.json({
        message: "Holiday applied and all previous attendance removed.",
        holiday: rec,
      });
    }

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
    console.log(
      `[ATTENDANCE][${employee.name}]Upserted -> Status=${rec.status
      }, LeaveType = ${rec.leaveType || "-"} on ${date} `
    );

    // ========= Payroll period =========
    const allPayrolls = await PayrollPeriod.find({ owner: ownerId }).lean();
    const shiftId = employee.shifts?.[0];
    const payroll = allPayrolls.find(
      (p) =>
        Array.isArray(p.shifts) &&
        p.shifts.map(String).includes(String(shiftId))
    );
    if (!payroll) {
      console.log(
        `[ERROR][${employee.name}] Payroll period not found for shift = ${String(
          shiftId
        )
        }`
      );
      return res.status(404).json({ error: "Payroll period not found." });
    }

    // ========= Non-working day guard =========
    const attendanceDate = new Date(date);
    const ymd = (d) => d.toISOString().slice(0, 10);
    const dow = attendanceDate.getDay();
    const dateSet = new Set();
    const weekdaySet = new Set();
    const nameToDay = {
      sun: 0,
      sunday: 0,
      mon: 1,
      monday: 1,
      tue: 2,
      tues: 2,
      tuesday: 2,
      wed: 3,
      weds: 3,
      wednesday: 3,
      thu: 4,
      thur: 4,
      thurs: 4,
      thursday: 4,
      fri: 5,
      friday: 5,
      sat: 6,
      saturday: 6,
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
    const isNonWorkingDay =
      dateSet.has(ymd(attendanceDate)) || weekdaySet.has(dow);

    if (isNonWorkingDay) {
      if (status !== "Present") {
        console.log(
          `[BLOCK][${employee.name}] ${date} is non - working.Only 'Present' allowed.Requested = ${status} `
        );
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
      console.log(
        `[BONUS][${employee.name}]Non - working Present -> Bonus=${bonus}, CarryoverHours = ${accumulated} `
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
        console.log(
          `[BONUS][${employee.name}]EarlyBird -> Bonus=${bonus}, CarryoverHours = ${accumulated} `
        );
      } else {
        console.log(
          `[BONUS][${employee.name}] No shiftStart found in shifts collection, skipping EarlyBird bonus.`
        );
      }
    }

    // ========= Payroll period dates =========
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

    console.log(
      `[PERIOD][${employee.name}]Start = ${start}, End = ${end}, BeforeJoin = ${beforeJoin ? "YES" : "NO"
      } `
    );

    // ========= SalarySlip (tenant-scoped) =========
    let slip = await SalarySlip.findOne({
      owner: ownerId,
      employee: employeeId,
      month: payrollMonth,
      year: payrollYear,
    });

    let grossSalary = 0;

    if (!slip) {
      const salaryDoc = await Salaries.findOne({
        employee: employeeId,
        owner: ownerId,
      });

      if (!salaryDoc) {
        console.log(
          `[ERROR][${employee.name}] Salary structure not found in Salaries.`
        );
        return res
          .status(404)
          .json({ error: "Salary structure not found for employee." });
      }

      const slipData = {
        owner: ownerId,
        employee: employeeId,
        month: payrollMonth,
        year: payrollYear,
        lateDeductionDaysCredited: 0,
        createdBy: userId,
      };

      allowanceFields.forEach((f) => (slipData[f] = salaryDoc[f] || ""));

      slipData.taxDeduction = salaryDoc.taxDeduction || "";
      slipData.annualTaxDeduction = salaryDoc.annualTaxDeduction || "";

      slip = await SalarySlip.create(slipData);

      grossSalary = await sumEncryptedFields(salaryDoc, allowanceFields);
      console.log(
        `[GROSS][${employee.name}](new slip) Gross = ${grossSalary} `
      );

      console.log(
        `[TAX][${employee.name}] Applied taxDeduction = ${salaryDoc.taxDeduction || "0"
        } `
      );
    } else {
      grossSalary = await sumEncryptedFields(slip, allowanceFields);

      console.log(
        `[GROSS][${employee.name}](existing slip) Gross = ${grossSalary} `
      );

      const currentTax = slip.taxDeduction
        ? Number(await decrypt(slip.taxDeduction)) || 0
        : 0;

      if (currentTax === 0) {
        const salaryDoc = await Salaries.findOne({
          employee: employeeId,
          owner: ownerId,
        });

        if (salaryDoc) {
          slip.taxDeduction = salaryDoc.taxDeduction || "";
          slip.annualTaxDeduction = salaryDoc.annualTaxDeduction || "";
          await slip.save();

          console.log(
            `[TAX][${employee.name}] Slip missing tax → applied from Salaries`
          );
        } else {
          console.log(
            `[TAX][${employee.name}] SalaryDoc missing, skipping tax import `
          );
        }
      }
    }

    // ========= Per-day calc =========
    const totalWorkingDays = 22;
    const perDay = grossSalary / totalWorkingDays;
    console.log(
      `[PERDAY][${employee.name}]Gross = ${grossSalary}, WorkingDays = ${totalWorkingDays}, PerDay = ${perDay} `
    );

    // ========= Auto-absent before join (skip non-working days) =========
    if (joinDate && joinDate > periodStart) {
      const dayMs = 24 * 60 * 60 * 1000;
      let daysToCharge = 0;

      const buildNonWorkingSets = () => {
        const ds = new Set();
        const ws = new Set();
        (payroll.nonWorkingDays || []).forEach((raw) => {
          if (!raw) return;
          const s = String(raw).trim();
          if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return ds.add(s);
          if (/^[0-6]$/.test(s)) return ws.add(Number(s));
          const key = s.toLowerCase();
          const nameToDay2 = {
            sun: 0,
            sunday: 0,
            mon: 1,
            monday: 1,
            tue: 2,
            tues: 2,
            tuesday: 2,
            wed: 3,
            weds: 3,
            wednesday: 3,
            thu: 4,
            thur: 4,
            thurs: 4,
            thursday: 4,
            fri: 5,
            friday: 5,
            sat: 6,
            saturday: 6,
          };
          if (key in nameToDay2) return ws.add(nameToDay2[key]);
          const nd = new Date(s);
          if (!isNaN(nd)) ds.add(ymd(nd));
        });
        return { ds, ws };
      };

      const { ds, ws } = buildNonWorkingSets();

      for (
        let d = new Date(periodStart);
        d < joinDate;
        d = new Date(d.getTime() + dayMs)
      ) {
        const iso = ymd(d);
        const weekday = d.getDay();
        if (ds.has(iso) || ws.has(weekday)) continue;

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
        if (result.unpaid > 0) {
          let prev = 0;
          if (slip.leaveDeductions)
            prev = Number(await decrypt(slip.leaveDeductions)) || 0;
          const add = perDay * result.unpaid;
          slip.leaveDeductions = await encrypt(String(prev + add));
          await slip.save();
          console.log(
            `[PREJOIN][${employee.name
            }] Auto Absent Days = ${daysToCharge}, Unpaid = ${result.unpaid
            }, Deduction = ${add}, New leaveDeductions = ${prev + add} `
          );
        } else {
          console.log(
            `[PREJOIN][${employee.name}] Auto Absent Days = ${daysToCharge}, Fully covered by paid leaves.`
          );
        }
      }
    }

    // ========= Reversal if switching from Unpaid Absent =========
    if (
      oldRec &&
      oldRec.status === "Absent" &&
      (oldRec.leaveType === "Unpaid" || !oldRec.leaveType) &&
      !(status === "Absent" && (leaveType === "Unpaid" || !leaveType))
    ) {
      const dayMs = 24 * 60 * 60 * 1000;
      const dsR = new Set();
      const wsR = new Set();
      (payroll.nonWorkingDays || []).forEach((raw) => {
        if (!raw) return;
        const s = String(raw).trim();
        if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return dsR.add(s);
        if (/^[0-6]$/.test(s)) return wsR.add(Number(s));
        const key = s.toLowerCase();
        if (key in nameToDay) return wsR.add(nameToDay[key]);
        const nd = new Date(s);
        if (!isNaN(nd)) dsR.add(ymd(nd));
      });

      let nextNonWorkingCountRev = 0;
      for (
        let d = new Date(new Date(date).getTime() + dayMs);
        ;
        d = new Date(d.getTime() + dayMs)
      ) {
        const iso = ymd(d);
        const weekday = d.getDay();
        if (dsR.has(iso) || wsR.has(weekday)) {
          nextNonWorkingCountRev += 1;
          continue;
        }
        const holidayRec = await Attendance.findOne({ owner: ownerId, date: iso, isHoliday: true }).lean();
        if (holidayRec) {
          nextNonWorkingCountRev += 1;
          continue;
        }
        break;
      }

      const daysToReverse = nextNonWorkingCountRev > 0 ? 1 + nextNonWorkingCountRev : 1;

      if (!slip.leaveDeductions) slip.leaveDeductions = await encrypt("0");
      let prevDeduction = Number(await decrypt(slip.leaveDeductions)) || 0;
      const deductionToReverse = Math.round(perDay * daysToReverse);
      let newDeduction = Math.max(0, prevDeduction - deductionToReverse);
      slip.leaveDeductions = await encrypt(newDeduction.toString());
      await slip.save();

      // Reverse unpaid leave in LeaveYearBalance
      const leaveYear = getLeaveYear(date);
      const balance = await LeaveYearBalance.findOne({
        owner: ownerId,
        employee: employeeId,
        year: leaveYear,
      });

      if (balance) {
        const oldUsed = balance.usedUnpaid || 0;
        const newUsed = Math.max(0, Number((oldUsed - daysToReverse).toFixed(2)));
        balance.usedUnpaid = newUsed;
        await balance.save();

        // Log the reversal transaction
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

      let incomingWillBePaid = false;
      try {
        if (status === "Leave") {
          const balanceSnapshot = await getLeaveBalanceSnapshot(ownerId, employeeId, date);
          const balance2 = balanceSnapshot.remainingPaid;
          if (req.body.forcePaid === true || balance2 > 0) incomingWillBePaid = true;
        } else if (status === "Absent" && leaveType === "Paid") {
          incomingWillBePaid = true;
        }
      } catch (e) {
        console.error("Error while deciding incoming paid state:", e);
      }

      if (!incomingWillBePaid && balance) {
        // Credit one paid leave in LeaveYearBalance
        balance.usedPaid = Math.max(0, (balance.usedPaid || 0) - 1);
        await balance.save();

        // Log the credit transaction
        await LeaveTransaction.create({
          owner: ownerId,
          employee: employeeId,
          leaveYearBalance: balance._id,
          year: leaveYear,
          date: new Date(),
          type: "PAID_LEAVE_CREDITED",
          value: 1,
        });
      }

      console.log(
        `[DEDUCTION - REVERSAL][${employee.name}]Reversed = ${deductionToReverse}, New leaveDeductions = ${newDeduction}, Reverted UnpaidDays = ${daysToReverse} `
      );
    }

    // ========= ABSENT =========
    if (status === "Absent") {
      const dayMs = 24 * 60 * 60 * 1000;
      const ds2 = new Set();
      const ws2 = new Set();
      (payroll.nonWorkingDays || []).forEach((raw) => {
        if (!raw) return;
        const s = String(raw).trim();
        if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return ds2.add(s);
        if (/^[0-6]$/.test(s)) return ws2.add(Number(s));
        const key = s.toLowerCase();
        if (key in nameToDay) return ws2.add(nameToDay[key]);
        const nd = new Date(s);
        if (!isNaN(nd)) return ds2.add(ymd(nd));
      });

      let nextNonWorkingCount = 0;
      for (
        let d = new Date(attendanceDate.getTime() + dayMs);
        ;
        d = new Date(d.getTime() + dayMs)
      ) {
        const iso = ymd(d);
        const weekday = d.getDay();
        if (ds2.has(iso) || ws2.has(weekday)) {
          nextNonWorkingCount += 1;
          continue;
        }
        const holidayRec = await Attendance.findOne({ owner: ownerId, date: iso, isHoliday: true }).lean();
        if (holidayRec) {
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

      console.log(
        `[LEAVE][${employee.name}]Absent -> Entitled=${totalEnt}, UsedPaid = ${usedPaid}, UsedUnpaid = ${usedUnpaid}, Balance = ${balance}, Requested = ${leaveType || "Unpaid"}, SandwichNextDays = ${nextNonWorkingCount}, DaysToCharge = ${effectiveDays} `
      );

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
            if (!slip.leaveDeductions) slip.leaveDeductions = await encrypt("0");
            const prev = Number(await decrypt(slip.leaveDeductions)) || 0;
            const add = Math.round(perDay * unpaidDays);
            slip.leaveDeductions = await encrypt(String(prev + add));
            await slip.save();
            console.log(
              `[DEDUCTION][${employee.name}] Sandwich Absent(Paid req) proportionate -> Paid=${paidDays}, Unpaid = ${unpaidDays}, Deduction = ${add}, New leaveDeductions = ${prev + add} `
            );
            await Attendance.findOneAndUpdate(
              { owner: ownerId, employee: employeeId, date },
              { $set: { leaveType: "Paid", proportionate: true } }
            );
          } else {
            console.log(
              `[DEDUCTION][${employee.name}] Sandwich Absent fully covered by paid -> Paid=${paidDays}, Unpaid = 0, NO deduction`
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
          if (!slip.leaveDeductions) slip.leaveDeductions = await encrypt("0");
          const prev = Number(await decrypt(slip.leaveDeductions)) || 0;
          const add = perDay * effectiveDays;
          slip.leaveDeductions = await encrypt(String(prev + add));
          await slip.save();
          console.log(
            `[DEDUCTION][${employee.name}] Sandwich Absent(Unpaid) -> Days=${effectiveDays}, Deduction = ${add}, New leaveDeductions = ${prev + add} `
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
        if (!slip.leaveDeductions) slip.leaveDeductions = await encrypt("0");
        const prev = Number(await decrypt(slip.leaveDeductions)) || 0;
        const add = Math.round(perDay * (result.unpaid || 0));
        slip.leaveDeductions = await encrypt(String(prev + add));
        await slip.save();
        console.log(
          `[DEDUCTION][${employee.name
          }] Absent proportionate -> Paid=${result.paid || 0}, Unpaid = ${result.unpaid || 0
          }, Deduction = ${add}, New leaveDeductions = ${prev + add} `
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
        console.log(
          `[DEDUCTION][${employee.name}] Absent fully paid -> NO deduction`
        );
        return res.json(rec);
      }

      // Unpaid absent
      await updateLeaveEntitlementForEmployee(
        ownerId,
        employeeId,
        date,
        1,
        "absent",
        true
      );
      if (!slip.leaveDeductions) slip.leaveDeductions = await encrypt("0");
      const prev = Number(await decrypt(slip.leaveDeductions)) || 0;
      const add = perDay;
      slip.leaveDeductions = await encrypt(String(prev + add));
      await slip.save();
      console.log(
        `[DEDUCTION][${employee.name
        }] Absent unpaid -> Deduction=${add}, New leaveDeductions = ${prev + add} `
      );

      await Attendance.findOneAndUpdate(
        { owner: ownerId, employee: employeeId, date },
        { $set: { leaveType: "Unpaid", proportionate: false } }
      );
    }

    // ========= LEAVE =========
    if (status === "Leave") {
      const dayMs = 24 * 60 * 60 * 1000;
      const ds3 = new Set();
      const ws3 = new Set();
      (payroll.nonWorkingDays || []).forEach((raw) => {
        if (!raw) return;
        const s = String(raw).trim();
        if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return ds3.add(s);
        if (/^[0-6]$/.test(s)) return ws3.add(Number(s));
        const key = s.toLowerCase();
        if (key in nameToDay) return ws3.add(nameToDay[key]);
        const nd = new Date(s);
        if (!isNaN(nd)) return ds3.add(ymd(nd));
      });

      let nextNonWorkingCountForLeave = 0;
      for (
        let d = new Date(attendanceDate.getTime() + dayMs);
        ;
        d = new Date(d.getTime() + dayMs)
      ) {
        const iso = ymd(d);
        const weekday = d.getDay();
        if (ds3.has(iso) || ws3.has(weekday)) {
          nextNonWorkingCountForLeave += 1;
          continue;
        }
        const holidayRec = await Attendance.findOne({ owner: ownerId, date: iso, isHoliday: true }).lean();
        if (holidayRec) {
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

      console.log(
        `[LEAVE][${employee.name}]Leave -> Entitled=${totalBal}, UsedPaid = ${usedPaid}, UsedUnpaid = ${usedUnpaid}, ` +
        `Balance = ${balance}, SandwichNextDays = ${nextNonWorkingCountForLeave}, DaysToCharge = ${effectiveDays} `
      );

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

        if (!slip.leaveDeductions) slip.leaveDeductions = await encrypt("0");
        const prev = Number(await decrypt(slip.leaveDeductions)) || 0;
        const add = perDay * (result.unpaid || 0);
        slip.leaveDeductions = await encrypt(String(prev + add));
        await slip.save();

        console.log(
          `[DEDUCTION][${employee.name
          }] Leave proportionate -> Paid=${result.paid || 0}, Unpaid = ${result.unpaid || 0
          }, ` + `Deduction = ${add}, New leaveDeductions = ${prev + add} `
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
        console.log(
          `[DEDUCTION][${employee.name}] Leave fully paid -> Days=${effectiveDays}, NO deduction`
        );
        return res.json(rec);
      }

      // No balance left
      if (typeof req.body.forcePaid === "undefined") {
        console.log(
          `[LEAVE][${employee.name}] No paid leave left -> needs confirmation(Days = ${effectiveDays})`
        );
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
        console.log(
          `[LEAVE][${employee.name}] Forced paid leave -> Days=${effectiveDays}, NO deduction`
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
        if (!slip.leaveDeductions) slip.leaveDeductions = await encrypt("0");
        const prev = Number(await decrypt(slip.leaveDeductions)) || 0;
        const add = perDay * effectiveDays;
        slip.leaveDeductions = await encrypt(String(prev + add));
        await slip.save();

        console.log(
          `[DEDUCTION][${employee.name}] Leave unpaid -> Days=${effectiveDays}, Deduction = ${add}, ` +
          `New leaveDeductions = ${prev + add} `
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
      const previouslyCredited = slip.lateDeductionDaysCredited || 0;

      if (lateDeductionDaysNow < previouslyCredited) {
        const daysToReverse = previouslyCredited - lateDeductionDaysNow;
        let prevLateAmt = 0;
        if (slip.lateDeductions) prevLateAmt = Number(await decrypt(slip.lateDeductions)) || 0;
        const maxRefundPossible = perDay * daysToReverse;
        const refundAmt = Math.min(prevLateAmt, maxRefundPossible);
        const unpaidDaysRefund = +(refundAmt / perDay);

        // Reverse leave balance
        const leaveYear = getLeaveYear(date);
        const balance = await LeaveYearBalance.findOne({
          owner: ownerId,
          employee: employeeId,
          year: leaveYear,
        });

        if (balance) {
          const usedPaid = balance.usedPaid || 0;
          const usedUnpaid = balance.usedUnpaid || 0;

          let newUsedUnpaid = Math.max(0, usedUnpaid - unpaidDaysRefund);
          let remainingDaysToReverse = daysToReverse - Math.min(usedUnpaid, unpaidDaysRefund);
          let newUsedPaid = usedPaid;
          if (remainingDaysToReverse > 0) {
            newUsedPaid = Math.max(0, usedPaid - remainingDaysToReverse);
          }

          balance.usedUnpaid = newUsedUnpaid;
          balance.usedPaid = newUsedPaid;
          await balance.save();

          // Log reversal transactions
          if (unpaidDaysRefund > 0) {
            await LeaveTransaction.create({
              owner: ownerId,
              employee: employeeId,
              leaveYearBalance: balance._id,
              year: leaveYear,
              date: new Date(),
              type: "UNPAID_LEAVE_REVERSED",
              value: unpaidDaysRefund,
            });
          }
          if (remainingDaysToReverse > 0) {
            await LeaveTransaction.create({
              owner: ownerId,
              employee: employeeId,
              leaveYearBalance: balance._id,
              year: leaveYear,
              date: new Date(),
              type: "PAID_LEAVE_REVERSED",
              value: remainingDaysToReverse,
            });
          }
        }

        const newLateAmt = Math.max(0, prevLateAmt - refundAmt);
        slip.lateDeductions = await encrypt(String(newLateAmt));
        slip.lateDeductionDaysCredited = lateDeductionDaysNow;
        await slip.save();

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

        console.log(
          `[LATE - REV][${employee.name}] Reversed ${daysToReverse} late deduction(s) -> Refund=${refundAmt}, New lateDeductions = ${newLateAmt} `
        );
      }
    }

    // ========= LATE (3 = 1 day) =========
    if (!beforeJoin && status === "Late") {
      const lateRecords = await Attendance.find({
        employee: employeeId,
        owner: ownerId,
        date: { $gte: start, $lte: end },
        status: "Late",
      }).lean();

      const lateCount = lateRecords.length;
      const lateDeductionDays = Math.floor(lateCount / 3);
      const previouslyCredited = slip.lateDeductionDaysCredited || 0;
      const newLateDeductionDays = lateDeductionDays - previouslyCredited;
      console.log(
        `[LATE][${employee.name}]LatesInPeriod = ${lateCount}, DeductionDaysTotal = ${lateDeductionDays}, NewToApply = ${newLateDeductionDays} `
      );

      if (newLateDeductionDays > 0) {
        if (newLateDeductionDays === 1) {
          const balanceSnapshot = await getLeaveBalanceSnapshot(ownerId, employeeId, date);
          const total = (balanceSnapshot.total || 0) + (balanceSnapshot.bonus || 0);
          const usedPaid = balanceSnapshot.usedPaid || 0;
          const balance = total - usedPaid;

          if (balance > 0 && balance < 1) {
            const result = await updateLeaveEntitlementForEmployeeProportional(
              ownerId,
              employeeId,
              date,
              1,
              "late",
              false
            );
            let prevLate = 0;
            if (slip.lateDeductions)
              prevLate = Number(await decrypt(slip.lateDeductions)) || 0;
            const addLate = perDay * (result.unpaid || 0);
            slip.lateDeductions = await encrypt(String(prevLate + addLate));
            slip.lateDeductionDaysCredited = lateDeductionDays;
            await slip.save();

            const lastLate = await Attendance.findOne({
              employee: employeeId,
              owner: ownerId,
              status: "Late",
              date: { $gte: start, $lte: end },
            }).sort({ date: -1 });
            if (lastLate) {
              await Attendance.updateOne(
                { _id: lastLate._id },
                { $set: { proportionate: true } }
              );
            }
            console.log(
              `[LATE - DEDUCTION][${employee.name
              }]Proportionate -> Paid=${result.paid || 0}, Unpaid = ${result.unpaid || 0
              }, Deduction = ${addLate}, New lateDeductions = ${prevLate + addLate} `
            );
          } else if (balance >= 1) {
            await updateLeaveEntitlementForEmployee(
              ownerId,
              employeeId,
              date,
              1,
              "late",
              false
            );
            slip.lateDeductionDaysCredited = lateDeductionDays;
            await slip.save();
            console.log(
              `[LATE][${employee.name}] Paid leave consumed(usedPaid + 1), NO deduction`
            );
          } else {
            const result = await updateLeaveEntitlementForEmployee(
              ownerId,
              employeeId,
              date,
              1,
              "late"
            );
            let prevLate = 0;
            if (slip.lateDeductions)
              prevLate = Number(await decrypt(slip.lateDeductions)) || 0;
            const addLate = perDay * (result.unpaid || 0);
            slip.lateDeductions = await encrypt(String(prevLate + addLate));
            slip.lateDeductionDaysCredited = lateDeductionDays;
            await slip.save();
            console.log(
              `[LATE - DEDUCTION][${employee.name
              }] Full day late deduction -> Days=${result.unpaid || 0
              }, Amount = ${addLate}, New lateDeductions = ${prevLate + addLate} `
            );
          }
        } else {
          const result = await updateLeaveEntitlementForEmployee(
            ownerId,
            employeeId,
            date,
            newLateDeductionDays,
            "late"
          );
          let prevLate = 0;
          if (slip.lateDeductions)
            prevLate = Number(await decrypt(slip.lateDeductions)) || 0;
          const addLate = Math.round(perDay * (result.unpaid || 0));
          slip.lateDeductions = await encrypt(String(prevLate + addLate));
          slip.lateDeductionDaysCredited = lateDeductionDays;
          await slip.save();
          console.log(
            `[LATE - DEDUCTION][${employee.name
            }]Multi - day late deduction -> Days=${result.unpaid || 0
            }, Amount = ${addLate}, New lateDeductions = ${prevLate + addLate} `
          );
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
        console.log(`[HALF] Paid half-day -> Balance used (0.5)`);
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
        
        // Apply salary deduction to slip
        if (!slip.leaveDeductions) slip.leaveDeductions = await encrypt("0");
        const prev = Number(await decrypt(slip.leaveDeductions)) || 0;
        const add = perDay * 0.5;
        slip.leaveDeductions = await encrypt(String(prev + add));
        await slip.save();

        await Attendance.updateOne(
          { owner: ownerId, employee: employeeId, date },
          { $set: { leaveType: "Unpaid", status: "Half Day" } }
        );
        console.log(`[HALF] Unpaid half-day -> Salary Deduction=${add}`);
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

    if (!slip.loanDeductions) slip.loanDeductions = {};
    slip.loanDeductions.otherLoans = await encrypt(
      String(totalLoanInstallments || 0)
    );
    slip.markModified("loanDeductions");
    if (totalLoanBenefits > 0) {
      const prev = slip.othersAllowances
        ? Number(await decrypt(slip.othersAllowances)) || 0
        : 0;
      slip.othersAllowances = await encrypt(String(prev + totalLoanBenefits));
    }
    if (!slip.loanDeductions.vehicleLoan)
      slip.loanDeductions.vehicleLoan = await encrypt("0");
    if (!slip.gratuityFundDeduction)
      slip.gratuityFundDeduction = await encrypt("0");

    await slip.save();

    // ========= Final snapshot =========
    const leaveDedVal = slip.leaveDeductions
      ? Number(await decrypt(slip.leaveDeductions)) || 0
      : 0;
    const lateDedVal = slip.lateDeductions
      ? Number(await decrypt(slip.lateDeductions)) || 0
      : 0;

    const currentBalance = await getLeaveBalanceSnapshot(ownerId, employeeId, date);
    const usedPaidNow = currentBalance.usedPaid || 0;
    const usedUnpaidNow = currentBalance.usedUnpaid || 0;

    console.log(
      `[SNAPSHOT][${employee.name}]Month = ${payrollMonth} ${payrollYear} | Gross=${grossSalary} | PerDay=${perDay} | ` +
      `LeaveDeductions = ${leaveDedVal} | LateDeductions=${lateDedVal} | UsedPaid=${usedPaidNow} | UsedUnpaid=${usedUnpaidNow} `
    );

    return res.json(rec);
  } catch (err) {
    console.error("Error in markAttendance:", err);
    return res.status(400).json({ error: err.message });
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

    // keep any auto-backfill tenant-scoped by passing effective owner if your backfill uses it
    await backfillForDate(date, ownerId);

    const query = {
      ...getAttendanceBaseQuery(req),
      date,
    };

    const records = await Attendance.find(query)

      // ⭐ MUST include status and _id so previous offboarded attendance shows
      .populate("employee", "name designation department email status _id")
      .lean();

    res.json(records);
  } catch (err) {
    console.error("Error in getRecordsByDate:", err);
    res.status(500).json({ error: err.message });
  }
};

// GET /api/attendance?from=YYYY-MM-DD&to=YYYY-MM-DD
exports.getRecordsByDateRange = async (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) {
    return res.status(400).json({ error: "Both 'from' and 'to' are required" });
  }
  try {
    const ownerId = resolveOwnerId(req.user);
    const userId = req.user._id;

    const records = await Attendance.find({
      owner: { $in: [oid(ownerId), oid(userId)] },
      date: { $gte: from, $lte: to },
    })
      // ⭐ MUST include status + _id, otherwise old offboarded attendance doesn't show in UI
      .populate("employee", "name position department email status _id")
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
      // ⭐ MUST include status + _id so UI can show old offboarded attendance
      .populate("employee", "name position department email status _id")
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

    res.json({ success: true, message: "Attendance record deleted and affects reversed." });
  } catch (err) {
    console.error("Error in deleteRecord:", err);
    res.status(500).json({ error: err.message });
  }
};