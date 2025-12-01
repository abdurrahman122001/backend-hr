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
} = require("../utils/leaveEntitlement");
const Salaries = require("../models/Salaries");
const LoanDetail = require("../models/LoanDetail");

function getHoursDiff(checkIn, checkOut) {
  if (!checkIn || !checkOut) return 0;
  const [inH, inM] = checkIn.split(":").map(Number);
  const [outH, outM] = checkOut.split(":").map(Number);
  let diff = outH * 60 + outM - (inH * 60 + inM);
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

async function updateLeaveEntitlementForEmployeeProportional(
  employeeId,
  daysToDeduct,
  type = "absent",
  forcePaid = false
) {
  const employee = await Employee.findById(employeeId).lean();
  if (!employee) throw new Error("Employee not found");

  const entitlement = employee.leaveEntitlement || {};
  const bonus = entitlement?.bonus || 0;
  const total = (entitlement.total || 0) + bonus;
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
    isProportionate,
  };
}

async function reverseOldBonus(oldRec) {
  if (!oldRec || !oldRec.bonusApplied || !oldRec.bonusHoursGiven) return;

  const emp = await Employee.findById(oldRec.employee);
  if (!emp) return;

  let bonus = emp.leaveEntitlement.bonus || 0;
  let accumulated = emp.leaveEntitlement.bonusHoursAccumulated || 0;

  // Roll back the hours
  accumulated -= oldRec.bonusHoursGiven;

  // If accumulated goes negative, roll back into bonus days
  while (accumulated < 0 && bonus > 0) {
    bonus -= 1;
    accumulated += 9;
  }

  if (accumulated < 0) accumulated = 0;

  await Employee.updateOne(
    { _id: oldRec.employee },
    {
      $set: {
        "leaveEntitlement.bonus": bonus,
        "leaveEntitlement.bonusHoursAccumulated": accumulated,
      },
    }
  );

  // Reset bonus flags on attendance record
  await Attendance.updateOne(
    { _id: oldRec._id },
    { $set: { bonusApplied: false, bonusType: null, bonusHoursGiven: 0 } }
  );

  console.log(
    `[BONUS-REVERSAL] Employee=${oldRec.employee} Bonus=${bonus}, Accumulated=${accumulated}`
  );
}

async function updateBonusForNonWorkingDay(
  employeeId,
  checkIn,
  checkOut,
  date
) {
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
      },
    }
  );

  await Attendance.updateOne(
    { employee: employeeId, date },
    {
      $set: {
        bonusApplied: true,
        bonusType: "NonWorkingDay",
        bonusHoursGiven: hours, // ✅ FIXED
      },
    }
  );

  return { bonus, accumulated };
}

async function updateBonusForEarlyBird(
  employeeId,
  checkIn,
  shiftStart,
  shiftEnd,
  checkOut,
  date
) {
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

  // Must be at least 30 min early
  const earlyMinutes = startMin - inMin;
  if (earlyMinutes < 30) {
    return { bonus: null, accumulated: null };
  }

  // Overnight-safe: if end <= start, it ends next day (e.g., 15:00 → 00:00)
  let endMin = endMinRaw;
  let outMinNorm = outMin;
  if (endMin <= startMin) {
    endMin += 1440; // move end to next day
    if (outMin < startMin) outMinNorm += 1440; // move checkout too if after midnight
  }

  // Must checkout at or after shift end
  if (outMinNorm < endMin) {
    return { bonus: null, accumulated: null };
  }

  const earlyHours = +(earlyMinutes / 60).toFixed(2);

  const emp = await Employee.findById(employeeId);
  const year = new Date(date).getFullYear();
  let bonus = emp.leaveEntitlement?.bonus || 0;
  let accumulated = emp.leaveEntitlement?.bonusHoursAccumulated || 0;
  let bonusYear = emp.leaveEntitlement?.bonusYear || year;

  if (bonusYear !== year) {
    accumulated = 0;
    bonus = 0;
    bonusYear = year;
  }

  accumulated += earlyHours;

  while (accumulated >= 9) {
    bonus += 1;
    accumulated -= 9;
  }

  await Employee.updateOne(
    { _id: employeeId },
    {
      $set: {
        "leaveEntitlement.bonus": bonus,
        "leaveEntitlement.bonusHoursAccumulated": accumulated,
        "leaveEntitlement.bonusYear": bonusYear,
      },
    }
  );

  await Attendance.updateOne(
    { employee: employeeId, date },
    {
      $set: {
        bonusApplied: true,
        bonusType: "EarlyBird",
        bonusHoursGiven: earlyHours, // or hours
      },
    }
  );

  return { bonus, accumulated };
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
      let breakdown = {}; // store each field’s value

      for (const f of fields) {
        if (src && src[f]) {
          const n = Number(await decrypt(src[f])) || 0;
          total += n;
          breakdown[f] = n; // keep track
        } else {
          breakdown[f] = 0; // field missing, set 0
        }
      }

      console.log("[GROSS BREAKDOWN]", breakdown, "Total =", total);

      return total;
    };

    // ========= Employee (needed for logs) =========
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
    console.log(
      `[ATTENDANCE] [${
        employee.name
      }] Request -> Date=${date}, Status=${status}, LeaveType=${
        leaveType || "-"
      }, CheckIn=${checkIn || "-"}, CheckOut=${checkOut || "-"}`
    );

    // ========= Holiday (tenant-scoped, no employee) =========
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
      console.log(`[ATTENDANCE] [${employee.name}] Marked HOLIDAY on ${date}`);
      return res.json(rec);
    }

    // ========= Existing record (for reversals) =========
    const oldRec = await Attendance.findOne({
      owner: ownerId,
      employee: employeeId,
      date,
    }).lean();
    if (oldRec) {
      await reverseOldBonus(oldRec);
      console.log(
        `[ATTENDANCE] [${employee.name}] Previous -> Status=${
          oldRec.status
        }, LeaveType=${oldRec.leaveType || "-"}`
      );
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
    console.log(
      `[ATTENDANCE] [${employee.name}] Upserted -> Status=${
        rec.status
      }, LeaveType=${rec.leaveType || "-"} on ${date}`
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
        `[ERROR] [${employee.name}] Payroll period not found for shift=${String(
          shiftId
        )}`
      );
      return res.status(404).json({ error: "Payroll period not found." });
    }

    // ========= Non-working day guard =========
    const attendanceDate = new Date(date);
    const ymd = (d) => d.toISOString().slice(0, 10);
    const dow = attendanceDate.getDay(); // 0..6
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
          `[BLOCK] [${employee.name}] ${date} is non-working. Only 'Present' allowed. Requested=${status}`
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
        `[BONUS] [${employee.name}] Non-working Present -> Bonus=${bonus}, CarryoverHours=${accumulated}`
      );
      return res.json(recNwd);
    }

    // ========= Early Bird Bonus =========
    if (status === "Present") {
      let shiftStart = null;
      let shiftEnd = null;

      // employee.shifts[0] holds the shift ID reference
      const shiftId = employee.shifts?.[0];
      if (shiftId) {
        const shiftDoc = await Shift.findById(shiftId).lean();
        if (shiftDoc && shiftDoc.start) {
          shiftStart = shiftDoc.start; // e.g. "15:00"
        }
        if (shiftDoc && shiftDoc.end) {
          shiftEnd = shiftDoc.end; // e.g. "00:00" for 12am next day
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
          `[BONUS] [${employee.name}] EarlyBird -> Bonus=${bonus}, CarryoverHours=${accumulated}`
        );
      } else {
        console.log(
          `[BONUS] [${employee.name}] No shiftStart found in shifts collection, skipping EarlyBird bonus.`
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
      `[PERIOD] [${employee.name}] Start=${start}, End=${end}, BeforeJoin=${
        beforeJoin ? "YES" : "NO"
      }`
    );

    // ========= SalarySlip (tenant-scoped) =========
    let slip = await SalarySlip.findOne({
      owner: ownerId,
      employee: employeeId,
      month: payrollMonth,
      year: payrollYear,
    }); // not lean

    let grossSalary = 0;

    if (!slip) {
      // ===== NEW SLIP: Pull ALL fields including TAX from Salaries =====
      const salaryDoc = await Salaries.findOne({
        employee: employeeId,
        owner: ownerId,
      });

      if (!salaryDoc) {
        console.log(
          `[ERROR] [${employee.name}] Salary structure not found in Salaries.`
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

      // copy ALL encrypted allowance fields
      allowanceFields.forEach((f) => (slipData[f] = salaryDoc[f] || ""));

      // --- NEW: copy encrypted TAX fields from Salaries → SalarySlip ---
      slipData.taxDeduction = salaryDoc.taxDeduction || "";
      slipData.annualTaxDeduction = salaryDoc.annualTaxDeduction || "";

      slip = await SalarySlip.create(slipData);

      // compute gross
      grossSalary = await sumEncryptedFields(salaryDoc, allowanceFields);
      console.log(
        `[GROSS] [${employee.name}] (new slip) Gross = ${grossSalary}`
      );

      console.log(
        `[TAX] [${employee.name}] Applied taxDeduction=${
          salaryDoc.taxDeduction || "0"
        }`
      );
    } else {
      // ===== EXISTING SLIP: read gross + apply tax if missing =====
      grossSalary = await sumEncryptedFields(slip, allowanceFields);

      console.log(
        `[GROSS] [${employee.name}] (existing slip) Gross = ${grossSalary}`
      );

      // decrypt current slip tax
      const currentTax = slip.taxDeduction
        ? Number(await decrypt(slip.taxDeduction)) || 0
        : 0;

      // If slip has no tax → copy from Salaries
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
            `[TAX] [${employee.name}] Slip missing tax → applied from Salaries`
          );
        } else {
          console.log(
            `[TAX] [${employee.name}] SalaryDoc missing, skipping tax import`
          );
        }
      }
    }

    // ========= Per-day calc =========
    const totalWorkingDays = 22; // keep your assumption
    const perDay = grossSalary / totalWorkingDays;
    console.log(
      `[PERDAY] [${employee.name}] Gross=${grossSalary}, WorkingDays=${totalWorkingDays}, PerDay=${perDay}`
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
          employeeId,
          daysToCharge
        );
        if (result.unpaid > 0) {
          let prev = 0;
          if (slip.leaveDeductions)
            prev = Number(await decrypt(slip.leaveDeductions)) || 0;
          const add = perDay * result.unpaid;
          slip.leaveDeductions = await encrypt(String(prev + add));
          await slip.save();
          console.log(
            `[PREJOIN] [${
              employee.name
            }] Auto Absent Days=${daysToCharge}, Unpaid=${
              result.unpaid
            }, Deduction=${add}, New leaveDeductions=${prev + add}`
          );
        } else {
          console.log(
            `[PREJOIN] [${employee.name}] Auto Absent Days=${daysToCharge}, Fully covered by paid leaves.`
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
      if (!slip.leaveDeductions) slip.leaveDeductions = await encrypt("0");
      let prevDeduction = Number(await decrypt(slip.leaveDeductions)) || 0;
      const deductionToReverse = Math.round(perDay);
      let newDeduction = Math.max(0, prevDeduction - deductionToReverse);
      slip.leaveDeductions = await encrypt(newDeduction.toString());
      await slip.save();

      // reverse unpaid counter, credit one paid
      const empDoc = await Employee.findById(employeeId).lean();
      if (
        empDoc &&
        empDoc.leaveEntitlement &&
        typeof empDoc.leaveEntitlement.usedUnpaid === "number"
      ) {
        const oldUsed = empDoc.leaveEntitlement.usedUnpaid || 0;
        const newUsed = Math.max(0, oldUsed - 1);
        await Employee.updateOne(
          { _id: employeeId },
          { $set: { "leaveEntitlement.usedUnpaid": newUsed } }
        );
      }
      await Employee.updateOne(
        { _id: employeeId },
        { $inc: { "leaveEntitlement.usedPaid": 1 } }
      );
      console.log(
        `[DEDUCTION-REVERSAL] [${employee.name}] Reversed=${deductionToReverse}, New leaveDeductions=${newDeduction}, Credited 1 paid leave`
      );
    }

    // ========= ABSENT =========
    if (status === "Absent") {
      const isFriday = attendanceDate.getDay() === 5; // 5 = Friday
      const effectiveDays = isFriday ? 3 : 1;

      const freshEmp = await Employee.findById(employeeId).lean();
      const ent = freshEmp?.leaveEntitlement || {};
      const bonusEnt = ent?.bonus || 0;
      const totalEnt = (ent.total || 0) + bonusEnt;
      const usedPaid = ent.usedPaid || 0;
      const usedUnpaid = ent.usedUnpaid || 0;
      const balance = +(totalEnt - usedPaid);

      console.log(
        `[LEAVE] [${
          employee.name
        }] Absent -> Entitled=${totalEnt}, UsedPaid=${usedPaid}, UsedUnpaid=${usedUnpaid}, Balance=${balance}, Requested=${
          leaveType || "Unpaid"
        }, Friday=${isFriday ? "YES" : "NO"}, DaysToCharge=${effectiveDays}`
      );

      // --- Friday special handling (3 days) ---
      if (isFriday) {
        if (leaveType === "Paid") {
          // Use proportional helper for 3 days.
          const result = await updateLeaveEntitlementForEmployeeProportional(
            employeeId,
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
            if (!slip.leaveDeductions)
              slip.leaveDeductions = await encrypt("0");
            const prev = Number(await decrypt(slip.leaveDeductions)) || 0;
            const add = Math.round(perDay * unpaidDays);
            slip.leaveDeductions = await encrypt(String(prev + add));
            await slip.save();
            console.log(
              `[DEDUCTION] [${
                employee.name
              }] Friday Absent(Paid req) proportionate -> Paid=${paidDays}, Unpaid=${unpaidDays}, Deduction=${add}, New leaveDeductions=${
                prev + add
              }`
            );
            await Attendance.findOneAndUpdate(
              { owner: ownerId, employee: employeeId, date },
              { $set: { leaveType: "Paid", proportionate: true } }
            );
          } else {
            console.log(
              `[DEDUCTION] [${employee.name}] Friday Absent fully covered by paid -> Paid=${paidDays}, Unpaid=0, NO deduction`
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
          // Unpaid for 3 days
          await updateLeaveEntitlementForEmployee(
            employeeId,
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
            `[DEDUCTION] [${
              employee.name
            }] Friday Absent(Unpaid) -> Days=${effectiveDays}, Deduction=${add}, New leaveDeductions=${
              prev + add
            }`
          );
          await Attendance.findOneAndUpdate(
            { owner: ownerId, employee: employeeId, date },
            { $set: { leaveType: "Unpaid", proportionate: false } }
          );
          return res.json(rec);
        }
      }

      // --- Normal (non-Friday) existing logic below ---
      // Proportionate paid+unpaid (for 1 day)
      if (leaveType === "Paid" && balance > 0 && balance < 1) {
        await Employee.updateOne(
          { _id: employeeId },
          {
            $inc: {
              "leaveEntitlement.usedPaid": balance,
              "leaveEntitlement.usedUnpaid": 1 - balance,
            },
          }
        );
        if (!slip.leaveDeductions) slip.leaveDeductions = await encrypt("0");
        const prev = Number(await decrypt(slip.leaveDeductions)) || 0;
        const add = Math.round(perDay * (1 - balance));
        slip.leaveDeductions = await encrypt(String(prev + add));
        await slip.save();
        console.log(
          `[DEDUCTION] [${
            employee.name
          }] Absent proportionate -> Paid=${balance}, Unpaid=${
            1 - balance
          }, Deduction=${add}, New leaveDeductions=${prev + add}`
        );

        await Attendance.findOneAndUpdate(
          { owner: ownerId, employee: employeeId, date },
          { $set: { leaveType: "Paid", proportionate: true } }
        );
        return res.json(rec);
      }

      // Full paid absent (no deduction)
      if (leaveType === "Paid" && balance >= 1) {
        await updateLeaveEntitlementForEmployee(
          employeeId,
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
          `[DEDUCTION] [${employee.name}] Absent fully paid -> NO deduction`
        );
        return res.json(rec);
      }

      // Unpaid absent
      await updateLeaveEntitlementForEmployee(employeeId, 1, "absent", true);
      if (!slip.leaveDeductions) slip.leaveDeductions = await encrypt("0");
      const prev = Number(await decrypt(slip.leaveDeductions)) || 0;
      const add = perDay;
      slip.leaveDeductions = await encrypt(String(prev + add));
      await slip.save();
      console.log(
        `[DEDUCTION] [${
          employee.name
        }] Absent unpaid -> Deduction=${add}, New leaveDeductions=${prev + add}`
      );

      await Attendance.findOneAndUpdate(
        { owner: ownerId, employee: employeeId, date },
        { $set: { leaveType: "Unpaid", proportionate: false } }
      );
    }

    // ========= LEAVE =========
    if (status === "Leave") {
      const isFriday = attendanceDate.getDay() === 5; // 5 = Friday
      const effectiveDays = isFriday ? 3 : 1;

      const freshEmp = await Employee.findById(employeeId).lean();
      const ent = freshEmp?.leaveEntitlement || {};
      const bonusBal = ent?.bonus || 0;
      const totalBal = (ent.total || 0) + bonusBal;
      const usedPaid = ent.usedPaid || 0;
      const usedUnpaid = ent.usedUnpaid || 0;
      const balance = +(totalBal - usedPaid);

      console.log(
        `[LEAVE] [${employee.name}] Leave -> Entitled=${totalBal}, UsedPaid=${usedPaid}, UsedUnpaid=${usedUnpaid}, ` +
          `Balance=${balance}, Friday=${
            isFriday ? "YES" : "NO"
          }, DaysToCharge=${effectiveDays}`
      );

      // Proportionate case: some paid available but less than needed (e.g., Fri=3 but balance 1 or 2)
      if (balance > 0 && balance < effectiveDays) {
        await Employee.updateOne(
          { _id: employeeId },
          {
            $inc: {
              "leaveEntitlement.usedPaid": balance,
              "leaveEntitlement.usedUnpaid": effectiveDays - balance,
            },
          }
        );

        if (!slip.leaveDeductions) slip.leaveDeductions = await encrypt("0");
        const prev = Number(await decrypt(slip.leaveDeductions)) || 0;
        const add = perDay * (effectiveDays - balance);
        slip.leaveDeductions = await encrypt(String(prev + add));
        await slip.save();

        console.log(
          `[DEDUCTION] [${
            employee.name
          }] Leave proportionate -> Paid=${balance}, Unpaid=${
            effectiveDays - balance
          }, ` + `Deduction=${add}, New leaveDeductions=${prev + add}`
        );

        await Attendance.findOneAndUpdate(
          { owner: ownerId, employee: employeeId, date },
          {
            $set: {
              status: "Absent",
              leaveType: "Paid",
              effectivePaidDays: balance,
              proportionate: true,
            },
          }
        );
        return res.json(rec);
      }

      // Fully covered by paid balance
      if (balance >= effectiveDays) {
        await updateLeaveEntitlementForEmployee(
          employeeId,
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
          `[DEDUCTION] [${employee.name}] Leave fully paid -> Days=${effectiveDays}, NO deduction`
        );
        return res.json(rec);
      }

      // No balance left
      if (typeof req.body.forcePaid === "undefined") {
        console.log(
          `[LEAVE] [${employee.name}] No paid leave left -> needs confirmation (Days=${effectiveDays})`
        );
        return res.status(200).json({
          needsConfirmation: true,
          message: `${employee.name} has no paid leaves available. Do you want to mark as Paid Leave?`,
        });
      } else if (req.body.forcePaid === true) {
        await updateLeaveEntitlementForEmployee(
          employeeId,
          effectiveDays,
          "leave",
          true
        );
        await Attendance.findOneAndUpdate(
          { owner: ownerId, employee: employeeId, date },
          { $set: { status: "Absent", leaveType: "Paid" } }
        );
        console.log(
          `[LEAVE] [${employee.name}] Forced paid leave -> Days=${effectiveDays}, NO deduction`
        );
        return res.json(rec);
      } else {
        // unpaid for all effectiveDays
        await updateLeaveEntitlementForEmployee(
          employeeId,
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
          `[DEDUCTION] [${employee.name}] Leave unpaid -> Days=${effectiveDays}, Deduction=${add}, ` +
            `New leaveDeductions=${prev + add}`
        );

        await Attendance.findOneAndUpdate(
          { owner: ownerId, employee: employeeId, date },
          { $set: { status: "Absent", leaveType: "Unpaid" } }
        );
        return res.json(rec);
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
        `[LATE] [${employee.name}] LatesInPeriod=${lateCount}, DeductionDaysTotal=${lateDeductionDays}, NewToApply=${newLateDeductionDays}`
      );

      if (newLateDeductionDays > 0) {
        if (newLateDeductionDays === 1) {
          const freshEmp = await Employee.findById(employeeId).lean();
          const ent = freshEmp?.leaveEntitlement || {};
          const total = ent.total || 0;
          const bonus = ent.bonus || 0;
          const usedPaid = ent.usedPaid || 0;
          const balance = total + bonus - usedPaid;

          if (balance > 0 && balance < 1) {
            await Employee.updateOne(
              { _id: employeeId },
              {
                $inc: {
                  "leaveEntitlement.usedPaid": balance,
                  "leaveEntitlement.usedUnpaid": 1 - balance,
                },
              }
            );
            let prevLate = 0;
            if (slip.lateDeductions)
              prevLate = Number(await decrypt(slip.lateDeductions)) || 0;
            const addLate = perDay * (1 - balance);
            slip.lateDeductions = await encrypt(String(prevLate + addLate));
            slip.lateDeductionDaysCredited = lateDeductionDays;
            await slip.save();

            // mark last late proportionate
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
              `[LATE-DEDUCTION] [${
                employee.name
              }] Proportionate -> Paid=${balance}, Unpaid=${
                1 - balance
              }, Deduction=${addLate}, New lateDeductions=${prevLate + addLate}`
            );
            // do not run full-late flow
          } else if (balance >= 1) {
            // use 1 paid leave → usedPaid + 1
            await Employee.updateOne(
              { _id: employeeId },
              { $inc: { "leaveEntitlement.usedPaid": 1 } }
            );

            slip.lateDeductionDaysCredited = lateDeductionDays;
            await slip.save();

            console.log(
              `[LATE] [${employee.name}] Paid leave consumed (usedPaid +1), NO deduction`
            );
          } else {
            const result = await updateLeaveEntitlementForEmployee(
              employeeId,
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
              `[LATE-DEDUCTION] [${
                employee.name
              }] Full day late deduction -> Days=${
                result.unpaid || 0
              }, Amount=${addLate}, New lateDeductions=${prevLate + addLate}`
            );
          }
        } else {
          // apply multiple days
          const result = await updateLeaveEntitlementForEmployee(
            employeeId,
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
            `[LATE-DEDUCTION] [${
              employee.name
            }] Multi-day late deduction -> Days=${
              result.unpaid || 0
            }, Amount=${addLate}, New lateDeductions=${prevLate + addLate}`
          );
        }
      }
    }

    // ========= Reverse previous Half Day if changed away =========
    if (oldRec && oldRec.status === "Half Day" && status !== "Half Day") {
      if (oldRec.leaveType === "Paid") {
        await Employee.updateOne(
          { _id: employeeId },
          { $inc: { "leaveEntitlement.usedPaid": -0.5 } }
        );
        console.log(
          `[HALF-REV] [${employee.name}] Reversed HalfDay Paid -> -0.5 paid`
        );
      } else {
        let prevDed = 0;
        if (slip.leaveDeductions)
          prevDed = Number(await decrypt(slip.leaveDeductions)) || 0;
        const newDed = Math.max(0, prevDed - perDay / 2);
        slip.leaveDeductions = await encrypt(String(newDed));
        await slip.save();
        await Employee.updateOne(
          { _id: employeeId },
          { $inc: { "leaveEntitlement.usedUnpaid": -0.5 } }
        );
        console.log(
          `[HALF-REV] [${employee.name}] Reversed HalfDay Unpaid -> Refund=${
            perDay / 2
          }, New leaveDeductions=${newDed}`
        );
      }
    }

    if (!beforeJoin && status === "Half Day") {
      const emp = await Employee.findById(employeeId).lean();
      const ent = emp.leaveEntitlement || {};

      const totalBal = (ent.total || 0) + (ent.bonus || 0);
      const usedPaid = ent.usedPaid || 0;
      const balance = totalBal - usedPaid;

      let unpaid = 0;

      if (balance >= 0.5) {
        // Half day fully paid
        await Employee.updateOne(
          { _id: employeeId },
          { $inc: { "leaveEntitlement.usedPaid": 0.5 } }
        );

        await Attendance.updateOne(
          { owner: ownerId, employee: employeeId, date },
          { $set: { leaveType: "Paid" } }
        );

        console.log(`[HALF] Paid half-day -> NO deduction`);
      } else {
        // Half day unpaid
        unpaid = 0.5;

        await Employee.updateOne(
          { _id: employeeId },
          { $inc: { "leaveEntitlement.usedUnpaid": 0.5 } }
        );

        let prev = slip.leaveDeductions
          ? Number(await decrypt(slip.leaveDeductions))
          : 0;

        const add = perDay * 0.5;
        slip.leaveDeductions = await encrypt(String(prev + add));
        await slip.save();

        await Attendance.updateOne(
          { owner: ownerId, employee: employeeId, date },
          { $set: { leaveType: "Unpaid" } }
        );

        console.log(
          `[HALF] Unpaid half-day -> Deduction=${add}, New leaveDeductions=${
            prev + add
          }`
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

    // Re-fetch current employee leave counters for accurate snapshot
    const empNow = await Employee.findById(employeeId).lean();
    const usedPaidNow = empNow?.leaveEntitlement?.usedPaid || 0;
    const usedUnpaidNow = empNow?.leaveEntitlement?.usedUnpaid || 0;

    console.log(
      `[SNAPSHOT] [${employee.name}] Month=${payrollMonth} ${payrollYear} | Gross=${grossSalary} | PerDay=${perDay} | ` +
        `LeaveDeductions=${leaveDedVal} | LateDeductions=${lateDedVal} | UsedPaid=${usedPaidNow} | UsedUnpaid=${usedUnpaidNow}`
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
    const userId = req.user._id;

    // keep any auto-backfill tenant-scoped by passing effective owner if your backfill uses it
    await backfillForDate(date, ownerId);

    const records = await Attendance.find({
      owner: { $in: [oid(ownerId), oid(userId)] }, // support legacy/user-scoped data
      date,
    })
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
