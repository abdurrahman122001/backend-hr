// backend/src/controllers/attendanceController.js
const mongoose = require("mongoose");
const { backfillForDate } = require("../backfillAttendance");
const Employee = require("../models/Employees");
const PayrollPeriod = require("../models/PayrollPeriod");
const SalarySlip = require("../models/SalarySlip");
const Attendance = require("../models/Attendance");
const { decrypt, encrypt } = require("../utils/encryption");
const {
  updateLeaveEntitlementForEmployee,
} = require("../utils/leaveEntitlement");
const Salaries = require("../models/Salaries");
const LoanDetail = require("../models/LoanDetail");

function getHoursDiff(checkIn, checkOut) {
  if (!checkIn || !checkOut) return 0;
  const [inH, inM] = checkIn.split(':').map(Number);
  const [outH, outM] = checkOut.split(':').map(Number);
  let diff = (outH * 60 + outM) - (inH * 60 + inM);
  // handle overnight (e.g. 22:00 to 06:00)
  if (diff < 0) diff += 24 * 60;
  return +(diff / 60).toFixed(2);
}
/**
 * Add early-bird hours to bonus entitlement (on working days).
 * @param {String} employeeId
 * @param {String} checkIn
 * @param {String} shiftStart
 * @param {String} date 
 */
async function updateBonusForEarlyBird(employeeId, checkIn, shiftStart, date) {
  // 1. Parse check-in and shift start
  if (!checkIn || !shiftStart) return;
  const [inH, inM] = checkIn.split(":").map(Number);
  const [shH, shM] = shiftStart.split(":").map(Number);

  // 2. Calculate early minutes (positive if early, negative if late/on time)
  const checkInMinutes = inH * 60 + inM;
  const startMinutes = shH * 60 + shM;
  let earlyMinutes = startMinutes - checkInMinutes; // positive = early

  // Only if at least 30 minutes early
  if (earlyMinutes < 30) return;

  // Convert to hours (float)
  const earlyHours = +(earlyMinutes / 60).toFixed(2);

  // 3. Load employee bonus tracking
  const emp = await Employee.findById(employeeId);
  const year = new Date(date).getFullYear();
  let bonus = emp.leaveEntitlement?.bonus || 0;
  let accumulated = emp.leaveEntitlement?.bonusHoursAccumulated || 0;
  let bonusYear = emp.leaveEntitlement?.bonusYear || year;

  // Reset if year changes
  if (bonusYear !== year) {
    accumulated = 0;
    bonus = 0;
    bonusYear = year;
  }

  accumulated += earlyHours;

  // 4. Add bonus for each 9h completed
  while (accumulated >= 9) {
    bonus += 1;
    accumulated -= 9;
  }

  // 5. Save
  await Employee.updateOne(
    { _id: employeeId },
    {
      $set: {
        "leaveEntitlement.bonus": bonus,
        "leaveEntitlement.bonusHoursAccumulated": accumulated,
        "leaveEntitlement.bonusYear": bonusYear,
      }
    }
  );

  return { bonus, accumulated };
}

async function updateBonusForNonWorkingDay(employeeId, checkIn, checkOut, date) {
  // 1. Calculate worked hours for this attendance
  const hours = getHoursDiff(checkIn, checkOut);

  // 2. Get employee doc
  const emp = await Employee.findById(employeeId);

  // Get previous accumulated hours for the current year
  const year = new Date(date).getFullYear();
  let bonus = emp.leaveEntitlement?.bonus || 0;
  let accumulated = emp.leaveEntitlement?.bonusHoursAccumulated || 0;
  let bonusYear = emp.leaveEntitlement?.bonusYear || year; // add this field if needed

  // Reset if year changed
  if (bonusYear !== year) {
    accumulated = 0;
    bonus = 0;
    bonusYear = year;
  }

  // 3. Update accumulated hours
  accumulated += hours;

  // 4. Increment bonus for each 9 hours completed
  while (accumulated >= 9) {
    bonus += 1;
    accumulated -= 9;
  }

  // 5. Save back to employee
  await Employee.updateOne(
    { _id: employeeId },
    {
      $set: {
        "leaveEntitlement.bonus": bonus,
        "leaveEntitlement.bonusHoursAccumulated": accumulated,
        "leaveEntitlement.bonusYear": bonusYear,
      }
    }
  );

  return { bonus, accumulated };
}

function resolveOwnerId(user) {
  // Prefer explicit tenant/company id (user.owner) → parent admin (createdBy) → self
  return user?.owner || user?.createdBy || user?._id;
}

function oid(id) {
  return new mongoose.Types.ObjectId(id);
}

async function ensureEmployeeAccessible(employeeId, ownerId, userId) {
  return Employee.findOne({
    _id: oid(employeeId),
    $or: [
      { owner: { $in: [ownerId, userId] } }, // legacy owner array
      { createdBy: { $in: [ownerId, userId] } }, // new creator scoping
    ],
  }).lean();
}
async function updateLeaveEntitlementForEmployeeProportional(employeeId, daysToDeduct, type = "absent", forcePaid = false) {
  const employee = await Employee.findById(employeeId).lean();
  if (!employee) throw new Error("Employee not found");

  const entitlement = employee.leaveEntitlement || {};
  const total = entitlement.total || 0;
  const usedPaid = entitlement.usedPaid || 0;
  const usedUnpaid = entitlement.usedUnpaid || 0;
  const availableBalance = total - usedPaid;

  let paidToUse = 0;
  let unpaidToUse = 0;
  let isProportionate = false;

  if (forcePaid) {
    // Force paid regardless of balance
    paidToUse = daysToDeduct;
  } else if (availableBalance <= 0) {
    // No paid balance available
    unpaidToUse = daysToDeduct;
  } else if (availableBalance >= daysToDeduct) {
    // Sufficient balance available
    paidToUse = daysToDeduct;
  } else {
    // Partial balance available - this is the proportional case
    paidToUse = availableBalance;
    unpaidToUse = daysToDeduct - availableBalance;
    isProportionate = true;
  }

  // Update the employee's leave entitlement
  const updates = {};
  if (paidToUse > 0) {
    updates["leaveEntitlement.usedPaid"] = usedPaid + paidToUse;
  }
  if (unpaidToUse > 0) {
    updates["leaveEntitlement.usedUnpaid"] = usedUnpaid + unpaidToUse;
  }

  if (Object.keys(updates).length > 0) {
    await Employee.updateOne({ _id: employeeId }, { $set: updates });
  }

  return {
    paid: paidToUse,
    unpaid: unpaidToUse,
    isProportionate
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
    // Holiday marking — unique by date + owner (tenant-scoped)
    if (isHoliday) {
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
      return res.json(rec);
    }

    // Guard: employee must belong to this tenant or be created by this user/tenant
    const employee = await ensureEmployeeAccessible(
      employeeId,
      ownerId,
      userId
    );
    if (!employee) {
      return res
        .status(404)
        .json({ error: "Employee not found for this owner or unauthorized." });
    }

    const oldRec = await Attendance.findOne({
      owner: ownerId,
      employee: employeeId,
      date,
    }).lean();

    // 1) Upsert attendance (tenant-scoped)
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
    if (status === "Absent" || status === "Half Day") {
      updateDoc.$set.leaveType = leaveType || "Unpaid";
    } else {
      updateDoc.$unset = { leaveType: "" };
    }

    const rec = await Attendance.findOneAndUpdate(
      { owner: ownerId, employee: employeeId, date },
      updateDoc,
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    // 2) Find payroll period for this employee (tenant-scoped)
    const allPayrolls = await PayrollPeriod.find({ owner: ownerId }).lean();

    // If employee has multiple shifts, pick the first for period mapping (adjust if needed)
    const shiftId = employee.shifts?.[0];
    const payroll = allPayrolls.find(
      (p) =>
        Array.isArray(p.shifts) &&
        p.shifts.map(String).includes(String(shiftId))
    );
    if (!payroll) {
      return res.status(404).json({ error: "Payroll period not found." });
    }
    // --- BLOCK non-working day marking for "Leave", "Late", "Absent", "Half Day" ---
    const attendanceDate = new Date(date);
    const ymd = (d) => d.toISOString().slice(0, 10);
    const dow = attendanceDate.getDay(); // 0=Sun ... 6=Sat

    const dateSet = new Set();
    const weekdaySet = new Set();
    const nameToDay = {
      sun: 0, sunday: 0,
      mon: 1, monday: 1,
      tue: 2, tues: 2, tuesday: 2,
      wed: 3, weds: 3, wednesday: 3,
      thu: 4, thur: 4, thurs: 4, thursday: 4,
      fri: 5, friday: 5,
      sat: 6, saturday: 6,
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
      // Only "Present" allowed!
      if (status !== "Present") {
        return res.status(400).json({
          error: "You can only mark Present on a non-working day. No leave, late, half day, or absent allowed."
        });
      }

      // upsert Present only
      const rec = await Attendance.findOneAndUpdate(
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
          $unset: { leaveType: "" }
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );

      // *** Update the bonus using new logic ***
      const { bonus, accumulated } = await updateBonusForNonWorkingDay(employeeId, checkIn, checkOut, date);
      console.log(`Employee ${employee.name} | Updated Bonus: ${bonus}, Carryover hours: ${accumulated}`);

      return res.json(rec);
    }

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

    // --- UPDATED: bound start by joining date, and flag before-join ---
    const joinDate = employee.joiningDate
      ? new Date(employee.joiningDate)
      : null;
    const effectiveStartDate =
      joinDate && joinDate > periodStart ? joinDate : periodStart;

    const start = effectiveStartDate.toISOString().slice(0, 10);
    const end = periodEnd.toISOString().slice(0, 10);

    const beforeJoin = joinDate && attendanceDate < joinDate;
    const payrollMonth = periodEnd.toLocaleString("en-US", { month: "long" });
    const payrollYear = periodEnd.getFullYear().toString();

    // 4) Fetch or create SalarySlip (tenant-scoped)
    let slip = await SalarySlip.findOne({
      owner: ownerId,
      employee: employeeId,
      month: payrollMonth,
      year: payrollYear,
    }); // not lean on purpose
    if (!slip) {
      const salaryDoc = await Salaries.findOne({
        employee: employeeId,
        owner: ownerId,
      });
      if (!salaryDoc) {
        return res
          .status(404)
          .json({ error: "Salary structure not found for employee." });
      }
      const allowanceFields = [
        "basic",
        "dearnessAllowance",
        "houseRentAllowance",
        "conveyanceAllowance",
        "medicalAllowance",
        "utilityAllowance",
        "overtimeCompensation",
        "dislocationAllowance",
        "leaveEncashment",
        "bonus",
        "arrears",
        "autoAllowance",
        "incentive",
        "fuelAllowance",
        "othersAllowances",
        "grossSalary",
      ];
      const slipData = {
        owner: ownerId,
        employee: employeeId,
        month: payrollMonth,
        year: payrollYear,
        lateDeductionDaysCredited: 0,
        createdBy: userId,
      };
      allowanceFields.forEach((f) => (slipData[f] = salaryDoc[f] || ""));
      slip = await SalarySlip.create(slipData);
    }
    // --- REPLACEMENT: auto-mark Absent from periodStart to day before join AND deduct (skip nonWorkingDays by date or weekday) ---
    if (joinDate && joinDate > periodStart) {
      const dayMs = 24 * 60 * 60 * 1000;
      let daysToCharge = 0;

      // helper: Date -> 'YYYY-MM-DD' (timezone-safe)
      const ymd = (dt) => {
        const y = dt.getFullYear();
        const m = String(dt.getMonth() + 1).padStart(2, "0");
        const d = String(dt.getDate()).padStart(2, "0");
        return `${y}-${m}-${d}`;
      };

      // Build non-working rules
      const dateSet = new Set(); // explicit dates, e.g., '2025-08-14'
      const weekdaySet = new Set(); // 0..6 (0=Sun)

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

        // 1) Exact date 'YYYY-MM-DD'
        if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
          dateSet.add(s);
          return;
        }

        // 2) Numeric weekday '0'..'6'
        if (/^[0-6]$/.test(s)) {
          weekdaySet.add(Number(s));
          return;
        }

        // 3) Weekday names
        const key = s.toLowerCase();
        if (key in nameToDay) {
          weekdaySet.add(nameToDay[key]);
          return;
        }

        // 4) Fallback: parseable date string -> normalize to YYYY-MM-DD
        const nd = new Date(s);
        if (!isNaN(nd)) {
          dateSet.add(ymd(nd));
        }
      });

      for (
        let d = new Date(periodStart);
        d < joinDate;
        d = new Date(d.getTime() + dayMs)
      ) {
        const iso = ymd(d);
        const dow = d.getDay();

        // skip if non-working by explicit date or weekday
        if (dateSet.has(iso) || weekdaySet.has(dow)) continue;

        // skip if any record already exists that day (holiday/attendance)
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
          employeeId,
          daysToCharge
        );
        if (result.unpaid > 0) {
          let gross = 0;
          if (slip.grossSalary) gross = Number(await decrypt(slip.grossSalary));
          const perDayAuto = gross / 22; // same totalWorkingDays assumption

          let prev = 0;
          if (slip.leaveDeductions)
            prev = Number(await decrypt(slip.leaveDeductions)) || 0;

          const add = Math.round(perDayAuto * result.unpaid);
          slip.leaveDeductions = await encrypt(String(prev + add));
          await slip.save();
        }
      }
    }
    if (joinDate && joinDate > periodStart) {
      const dayMs = 24 * 60 * 60 * 1000;
      let daysToCharge = 0;

      // helper: Date -> 'YYYY-MM-DD' (timezone-safe)
      const ymd = (dt) => {
        const y = dt.getFullYear();
        const m = String(dt.getMonth() + 1).padStart(2, "0");
        const d = String(dt.getDate()).padStart(2, "0");
        return `${y}-${m}-${d}`;
      };

      // Build non-working rules
      const dateSet = new Set(); // explicit dates, e.g., '2025-08-14'
      const weekdaySet = new Set(); // 0..6 (0=Sun)

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

        // 1) Exact date 'YYYY-MM-DD'
        if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
          dateSet.add(s);
          return;
        }

        // 2) Numeric weekday '0'..'6'
        if (/^[0-6]$/.test(s)) {
          weekdaySet.add(Number(s));
          return;
        }

        // 3) Weekday names
        const key = s.toLowerCase();
        if (key in nameToDay) {
          weekdaySet.add(nameToDay[key]);
          return;
        }

        // 4) Fallback: parseable date string -> normalize to YYYY-MM-DD
        const nd = new Date(s);
        if (!isNaN(nd)) {
          dateSet.add(ymd(nd));
        }
      });

      for (
        let d = new Date(periodStart);
        d < joinDate;
        d = new Date(d.getTime() + dayMs)
      ) {
        const iso = ymd(d);
        const dow = d.getDay();

        // skip if non-working by explicit date or weekday
        if (dateSet.has(iso) || weekdaySet.has(dow)) continue;

        // skip if any record already exists that day (holiday/attendance)
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

      // apply leave entitlement and monetary deduction for the pre-join absences
      if (daysToCharge > 0) {
        const result = await updateLeaveEntitlementForEmployee(
          employeeId,
          daysToCharge
        );
        if (result.unpaid > 0) {
          let gross = 0;
          if (slip.grossSalary) gross = Number(await decrypt(slip.grossSalary));
          const perDayAuto = gross / 22; // same totalWorkingDays assumption

          let prev = 0;
          if (slip.leaveDeductions)
            prev = Number(await decrypt(slip.leaveDeductions)) || 0;

          const add = Math.round(perDayAuto * result.unpaid);
          slip.leaveDeductions = await encrypt(String(prev + add));
          await slip.save();
        }
      }
    }

    // 5) Gross salary + per-day calc
    let grossSalary = 0;
    if (slip.grossSalary) {
      grossSalary = Number(await decrypt(slip.grossSalary));
    }
    const totalWorkingDays = 22; // TODO: make dynamic if needed
    const perDay = grossSalary / totalWorkingDays;

    if (
      oldRec &&
      oldRec.status === "Absent" &&
      (oldRec.leaveType === "Unpaid" || !oldRec.leaveType) &&
      !(status === "Absent" && (leaveType === "Unpaid" || !leaveType))
    ) {
      // 1. Reverse deduction in SalarySlip
      if (!slip.leaveDeductions) {
        slip.leaveDeductions = await encrypt("0");
      }
      let prevDeduction = Number(await decrypt(slip.leaveDeductions)) || 0;
      const deductionToReverse = Math.round(perDay);
      let newDeduction = Math.max(0, prevDeduction - deductionToReverse);
      slip.leaveDeductions = await encrypt(newDeduction.toString());
      await slip.save();

      // 2. Reverse usedUnpaid leave
      let empDoc = await Employee.findById(employeeId).lean();
      if (
        empDoc &&
        empDoc.leaveEntitlement &&
        typeof empDoc.leaveEntitlement.usedUnpaid === "number"
      ) {
        let oldUsed = empDoc.leaveEntitlement.usedUnpaid || 0;
        let newUsed = Math.max(0, oldUsed - 1);
        await Employee.updateOne(
          { _id: employeeId },
          { $set: { "leaveEntitlement.usedUnpaid": newUsed } }
        );
      }
      await Employee.updateOne(
        { _id: employeeId },
        { $inc: { "leaveEntitlement.usedPaid": 1 } }
      );
    }

    if (status === "Absent") {
      // If user explicitly marked Paid, check fractional balance and handle proportionately.
      if (leaveType === "Paid") {
        const freshEmp = await Employee.findById(employeeId).lean();
        const ent = freshEmp?.leaveEntitlement || {};
        const total = ent.total || 0;
        const usedPaid = ent.usedPaid || 0;
        const balance = +(total - usedPaid);

        if (balance > 0 && balance < 1) {
          // Proportionate: use remaining paid balance, rest unpaid
          await Employee.updateOne(
            { _id: employeeId },
            {
              $inc: {
                "leaveEntitlement.usedPaid": balance,
                "leaveEntitlement.usedUnpaid": 1 - balance,
              },
            }
          );

          // Deduct salary only for unpaid part
          if (!slip.leaveDeductions) slip.leaveDeductions = await encrypt("0");
          let prevDeduction = Number(await decrypt(slip.leaveDeductions)) || 0;
          const add = Math.round(perDay * (1 - balance));
          slip.leaveDeductions = await encrypt(String(prevDeduction + add));
          await slip.save();

          // Mark attendance as Paid + proportionate
          await Attendance.findOneAndUpdate(
            { owner: ownerId, employee: employeeId, date },
            { $set: { leaveType: "Paid", proportionate: true } }
          );

          return res.json(rec);
        }

        // If full day paid is available (>=1), keep your existing fully-paid flow:
        if (balance >= 1) {
          const result = await updateLeaveEntitlementForEmployee(
            employeeId,
            1,
            "leave",
            req.body.forcePaid
          );
          await Attendance.findOneAndUpdate(
            { owner: ownerId, employee: employeeId, date },
            { $set: { status: "Absent", leaveType: "Paid", proportionate: false } }
          );
          // No deduction
          return res.json(rec);
        }
        // else: no paid balance → fall through to your existing unpaid logic below
      }

      // (Existing) Unpaid Absent flow
      await updateLeaveEntitlementForEmployee(employeeId, 1, "absent", true);

      // Always decrement usedPaid if editing from Absent(Paid) to Absent(Unpaid)
      if (
        oldRec &&
        oldRec.status === "Absent" &&
        oldRec.leaveType === "Paid" &&
        status === "Absent" &&
        (leaveType === "Unpaid" || !leaveType)
      ) {
        let empDoc = await Employee.findById(employeeId).lean();
        if (
          empDoc &&
          empDoc.leaveEntitlement &&
          typeof empDoc.leaveEntitlement.usedPaid === "number"
        ) {
          let oldUsed = empDoc.leaveEntitlement.usedPaid || 0;
          let newUsed = Math.max(0, oldUsed - 1);
          await Employee.updateOne(
            { _id: employeeId },
            { $set: { "leaveEntitlement.usedPaid": newUsed } }
          );
        }
      }

      if (!slip.leaveDeductions) {
        slip.leaveDeductions = await encrypt("0");
      }
      {
        let prevDeduction = Number(await decrypt(slip.leaveDeductions)) || 0;
        const leaveDeduction = Math.round(perDay + prevDeduction);
        slip.leaveDeductions = await encrypt(leaveDeduction.toString());
        await slip.save();
      }

      await Attendance.findOneAndUpdate(
        { owner: ownerId, employee: employeeId, date },
        { $set: { leaveType: "Unpaid", proportionate: false } }
      );
    }


    if (status === "Leave") {
      // 👇 ADD THIS proportional guard FIRST
      const freshEmp = await Employee.findById(employeeId).lean();
      const ent = freshEmp?.leaveEntitlement || {};
      const totalBal = ent.total || 0;
      const usedPaid = ent.usedPaid || 0;
      const balance = +(totalBal - usedPaid);

      if (balance > 0 && balance < 1) {
        // 0 < balance < 1  → take partial paid + partial unpaid
        await Employee.updateOne(
          { _id: employeeId },
          {
            $inc: {
              "leaveEntitlement.usedPaid": balance,       // e.g. 0.5
              "leaveEntitlement.usedUnpaid": 1 - balance, // e.g. 0.5
            },
          }
        );

        // Deduct ONLY the unpaid fraction
        if (!slip.leaveDeductions) slip.leaveDeductions = await encrypt("0");
        const prev = Number(await decrypt(slip.leaveDeductions)) || 0;
        const add = Math.round(perDay * (1 - balance)); // e.g. 0.5 day
        slip.leaveDeductions = await encrypt(String(prev + add));
        await slip.save();

        // Store it as Absent + Paid (per your app) and flag proportionate
        await Attendance.findOneAndUpdate(
          { owner: ownerId, employee: employeeId, date },
          { $set: { status: "Absent", leaveType: "Paid", proportionate: true } }
        );

        return res.json(rec);
      }

      // 🔽 keep your existing "Leave" logic unchanged below this line
      let result = { paid: 0, unpaid: 0 };
      const employeeEntitlement = employee.leaveEntitlement || {};
      const entitlementLeft = (employeeEntitlement.total) - (employeeEntitlement.usedPaid);

      if (entitlementLeft > 0) {
        result = await updateLeaveEntitlementForEmployee(employeeId, 1, "leave", req.body.forcePaid);
        await Attendance.findOneAndUpdate(
          { owner: ownerId, employee: employeeId, date },
          { $set: { status: "Absent", leaveType: "Paid" } }
        );
        return res.json(rec);
      }

      if (typeof req.body.forcePaid === "undefined") {
        return res.status(200).json({
          needsConfirmation: true,
          message: `${employee.name} has no paid leaves available. Do you want to mark as Paid Leave?`,
        });
      } else if (req.body.forcePaid === true) {
        await updateLeaveEntitlementForEmployee(employeeId, 1, "leave", true);
        await Attendance.findOneAndUpdate(
          { owner: ownerId, employee: employeeId, date },
          { $set: { status: "Absent", leaveType: "Paid" } }
        );
        return res.json(rec);
      } else {
        await updateLeaveEntitlementForEmployee(employeeId, 1, "absent", true);

        if (!slip.leaveDeductions) {
          slip.leaveDeductions = await encrypt("0");
        }
        let prevDeduction = Number(await decrypt(slip.leaveDeductions)) || 0;
        const leaveDeduction = Math.round(perDay + prevDeduction);
        slip.leaveDeductions = await encrypt(leaveDeduction.toString());
        await slip.save();
        await Attendance.findOneAndUpdate(
          { owner: ownerId, employee: employeeId, date },
          { $set: { status: "Absent", leaveType: "Unpaid" } }
        );
        return res.json(rec);
      }
    }


    // 7) Late → 3 Lates = 1 day, tracked cumulatively, leave-aware
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

      if (newLateDeductionDays > 0) {
        // Proportionate only when exactly 1 day is being charged and balance is fractional
        if (newLateDeductionDays === 1) {
          const freshEmp = await Employee.findById(employeeId).lean();
          const ent = freshEmp?.leaveEntitlement || {};
          const total = ent.total || 0;
          const usedPaid = ent.usedPaid || 0;
          const balance = +(total - usedPaid);

          if (balance > 0 && balance < 1) {
            // Take partial paid + partial unpaid
            await Employee.updateOne(
              { _id: employeeId },
              {
                $inc: {
                  "leaveEntitlement.usedPaid": balance,
                  "leaveEntitlement.usedUnpaid": 1 - balance,
                },
              }
            );

            // Deduct only for unpaid half
            let prevLate = 0;
            if (slip.lateDeductions) prevLate = Number(await decrypt(slip.lateDeductions)) || 0;
            const addLate = Math.round(perDay * (1 - balance));
            slip.lateDeductions = await encrypt(String(prevLate + addLate));

            slip.lateDeductionDaysCredited = lateDeductionDays;
            await slip.save();

            // Mark the latest "Late" as proportionate
            const lastLate = await Attendance.findOne({
              employee: employeeId,
              owner: ownerId,
              status: "Late",
              date: { $gte: start, $lte: end },
            }).sort({ date: -1 });
            if (lastLate) {
              await Attendance.updateOne({ _id: lastLate._id }, { $set: { proportionate: true } });
            }
            return; // stop here, don't run old late updater
          }
        }
        const result = await updateLeaveEntitlementForEmployee(
          employeeId,
          newLateDeductionDays,
          "late"
        );

        let prevLateDeduction = 0;
        if (slip.lateDeductions) {
          prevLateDeduction = Number(await decrypt(slip.lateDeductions)) || 0;
        }
        const deductionDays = result.unpaid || 0; // unpaid days count
        const newDeductionAmount = Math.round(perDay * deductionDays);
        slip.lateDeductions = await encrypt(
          (prevLateDeduction + newDeductionAmount).toString()
        );

        slip.lateDeductionDaysCredited = lateDeductionDays;
        await slip.save();
      }
    }

    if (oldRec && oldRec.status === "Half Day") {
      if (oldRec.leaveType === "Paid") {
        await Employee.updateOne(
          { _id: employeeId },
          { $inc: { "leaveEntitlement.usedPaid": -0.5 } } // or -1 if stored as 1/2 = 0.5
        );
      } else {
        let prevDeduction = 0;
        if (slip.leaveDeductions) prevDeduction = Number(await decrypt(slip.leaveDeductions)) || 0;
        slip.leaveDeductions = await encrypt(Math.max(0, prevDeduction - perDay / 2).toString());
        await slip.save();

        await Employee.updateOne(
          { _id: employeeId },
          { $inc: { "leaveEntitlement.usedUnpaid": -0.5 } }
        );
      }
    }

    // mark new half day
    if (!beforeJoin && status === "Half Day") {
      const result = await updateLeaveEntitlementForEmployee(employeeId, 0.5);
      if (result.unpaid > 0) {
        let prevDeduction = 0;
        if (slip.leaveDeductions) prevDeduction = Number(await decrypt(slip.leaveDeductions)) || 0;
        slip.leaveDeductions = await encrypt(Math.round(prevDeduction + (perDay / 2) * result.unpaid).toString());
        await slip.save();
      }
      const leaveTypeToSet = result.unpaid > 0 ? "Unpaid" : "Paid";
      await Attendance.updateOne(
        { owner: ownerId, employee: employeeId, date },
        { $set: { leaveType: leaveTypeToSet } }
      );
    }


    const monthName = payrollMonth; // e.g., "August"
    const yearNum = Number(payrollYear); // e.g., 2025

    // Get all loans for this employee
    const loans = await LoanDetail.find({ employee: employeeId }).lean();

    let totalLoanInstallments = 0; // to write into slip.loanDeductions.otherLoans
    let totalLoanBenefits = 0; // optional: per-month markup sum

    for (const loan of loans) {
      if (!Array.isArray(loan.paymentSchedule)) continue;

      // Only deduct if a schedule row exists for THIS (month, year)
      const row = loan.paymentSchedule.find(
        (ps) => ps?.month === monthName && Number(ps?.year) === yearNum
      );
      if (!row) continue; // ← prevents deductions before the loan starts

      // Deduction: prefer the schedule row's totalPayment; fallback to loan.monthlyInstallment
      let installmentAmount = 0;
      if (row.totalPayment) {
        installmentAmount = Number(await decrypt(row.totalPayment)) || 0;
      } else if (loan.monthlyInstallment) {
        installmentAmount = Number(await decrypt(loan.monthlyInstallment)) || 0;
      }
      totalLoanInstallments += installmentAmount;

      // (Optional) “loan benefit” for the month = that row's markupAmount
      if (row.markupAmount) {
        const markupAmt = Number(await decrypt(row.markupAmount)) || 0;
        totalLoanBenefits += markupAmt;
      }
    }

    // Ensure nested object exists
    if (!slip.loanDeductions) slip.loanDeductions = {};

    // Write the loan deduction for this month
    slip.loanDeductions.otherLoans = await encrypt(
      String(totalLoanInstallments || 0)
    );
    slip.markModified("loanDeductions");

    // OPTIONAL: add the month’s loan benefit to an allowance bucket.
    // If you store it elsewhere, replace 'othersAllowances' below.
    if (totalLoanBenefits > 0) {
      const prev = slip.othersAllowances
        ? Number(await decrypt(slip.othersAllowances)) || 0
        : 0;
      slip.othersAllowances = await encrypt(String(prev + totalLoanBenefits));
    }

    // Safe defaults for related fields
    if (!slip.loanDeductions.vehicleLoan) {
      slip.loanDeductions.vehicleLoan = await encrypt("0");
    }
    if (!slip.gratuityFundDeduction) {
      slip.gratuityFundDeduction = await encrypt("0");
    }

    await slip.save();
    res.json(rec);
  } catch (err) {
    console.error("Error in markAttendance:", err);
    res.status(400).json({ error: err.message });
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
    const userId = req.user._id;

    // keep any auto-backfill tenant-scoped by passing effective owner if your backfill uses it
    await backfillForDate(date, ownerId);

    const records = await Attendance.find({
      owner: { $in: [oid(ownerId), oid(userId)] }, // support legacy/user-scoped data
      date,
    })
      .populate("employee", "name designation department email")
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
      .populate("employee", "name position department")
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
    const ownerId = resolveOwnerId(req.user);
    const userId = req.user._id;

    const stats = await Attendance.aggregate([
      {
        $match: {
          owner: { $in: [oid(ownerId), oid(userId)] },
          date,
        },
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
    const emp = await ensureEmployeeAccessible(id, ownerId, userId);
    if (!emp) {
      return res
        .status(404)
        .json({ error: "Employee not found or unauthorized" });
    }

    const records = await Attendance.find({
      owner: { $in: [oid(ownerId), oid(userId)] },
      employee: oid(id),
    })
      .sort({ date: 1 })
      .populate("employee", "name position department")
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

    const deleted = await Attendance.findOneAndDelete({
      _id: id,
      owner: { $in: [oid(ownerId), oid(userId)] }, // allow deletion of legacy/self docs too
    });
    if (!deleted) {
      return res.status(404).json({ error: "Record not found" });
    }
    res.json({ success: true });
  } catch (err) {
    console.error("Error in deleteRecord:", err);
    res.status(500).json({ error: err.message });
  }
};
