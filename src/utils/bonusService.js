const mongoose = require("mongoose");
const Employee = require("../models/Employees");
const Attendance = require("../models/Attendance");
const LeaveYearBalance = require("../models/LeaveYearBalance");
const LeaveTransaction = require("../models/LeaveTransaction");
const Shift = require("../models/Shift");
const PayrollPeriod = require("../models/PayrollPeriod");
const { getLeaveYear } = require("./leaveEntitlement");

function getHoursDiff(checkIn, checkOut) {
    if (!checkIn || !checkOut) return 0;
    const [inH, inM] = checkIn.split(":").map(Number);
    const [outH, outM] = checkOut.split(":").map(Number);
    let diff = outH * 60 + outM - (inH * 60 + inM);
    // handle overnight (e.g. 22:00 to 06:00)
    if (diff < 0) diff += 24 * 60;
    return +(diff / 60).toFixed(2);
}

function checkIsNonWorkingDay(payroll, dateStr) {
    const d = new Date(dateStr);
    const ymd = d.toISOString().slice(0, 10);
    const dow = d.getDay();
    const dateSet = new Set();
    const weekdaySet = new Set();
    const nameToDay = {
        sun: 0, sunday: 0,
        mon: 1, monday: 1,
        tue: 2, tues: 2, tuesday: 2,
        wed: 3, weds: 3, wednesday: 3,
        thu: 4, thur: 4, thurs: 4, thursday: 4,
        fri: 5, friday: 5,
        sat: 6, saturday: 6
    };

    (payroll.nonWorkingDays || []).forEach((raw) => {
        if (!raw) return;
        const s = String(raw).trim();
        if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return dateSet.add(s);
        if (/^[0-6]$/.test(s)) return weekdaySet.add(Number(s));
        const key = s.toLowerCase();
        if (key in nameToDay) return weekdaySet.add(nameToDay[key]);
        const nd = new Date(s);
        if (!isNaN(nd)) dateSet.add(nd.toISOString().slice(0, 10));
    });

    return dateSet.has(ymd) || weekdaySet.has(dow);
}

async function updateBonusForNonWorkingDay(employeeId, checkIn, checkOut, date) {
    const hours = getHoursDiff(checkIn, checkOut);
    const employee = await Employee.findById(employeeId);
    if (!employee) return { bonus: 0, accumulated: 0 };

    const ownerId = employee.owner || employee.createdBy;
    const year = getLeaveYear(date);

    let balance = await LeaveYearBalance.findOne({ owner: ownerId, employee: employeeId, year });
    if (!balance) {
        balance = await LeaveYearBalance.create({
            owner: ownerId, employee: employeeId, year,
            total: 0, bonus: 0, bonusHoursAccumulated: 0,
            usedPaid: 0, usedUnpaid: 0, remainingPaid: 0,
            lastRecalculatedAt: new Date(),
        });
    }

    let newAccumulated = (balance.bonusHoursAccumulated || 0) + hours;
    let newBonus = balance.bonus || 0;

    while (newAccumulated >= 9) {
        newBonus += 1;
        newAccumulated -= 9;
        await LeaveTransaction.create({
            owner: ownerId, employee: employeeId, leaveYearBalance: balance._id,
            year, date: new Date(date), type: "BONUS_EARNED", value: 1,
            sourceModel: "Attendance", createdBy: employee.createdBy,
        });
    }

    balance.bonus = newBonus;
    balance.bonusHoursAccumulated = newAccumulated;
    balance.lastRecalculatedAt = new Date();
    await balance.save();

    await Attendance.updateOne(
        { employee: employeeId, date },
        { $set: { bonusApplied: true, bonusType: "NonWorkingDay", bonusHoursGiven: hours } }
    );
    console.log(`[BONUS-UPDATE] NonWorkingDay -> Bonus=${newBonus}, Accumulated=${newAccumulated}`);
    return { bonus: newBonus, accumulated: newAccumulated, hoursGiven: hours };
}

async function updateBonusForEarlyBird(employeeId, checkIn, shiftStart, shiftEnd, checkOut, date) {
    if (!checkIn || !shiftStart || !shiftEnd || !checkOut) return { bonus: null, accumulated: null };

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

    if (inMin == null || startMin == null || outMin == null || endMinRaw == null) return { bonus: null, accumulated: null };

    const earlyMinutes = startMin - inMin;
    if (earlyMinutes < 30) return { bonus: null, accumulated: null };

    let endMin = endMinRaw;
    let outMinNorm = outMin;
    if (endMin <= startMin) {
        endMin += 1440;
        if (outMin < startMin) outMinNorm += 1440;
    }

    // ✅ Removed checkout time restriction - bonus hours are added regardless of when employee leaves
    // Early bird hours are calculated based on checkin time only
    const earlyHours = +(earlyMinutes / 60).toFixed(2);
    const employee = await Employee.findById(employeeId);
    if (!employee) return { bonus: null, accumulated: null };

    const ownerId = employee.owner || employee.createdBy;
    const year = getLeaveYear(date);

    let balance = await LeaveYearBalance.findOne({ owner: ownerId, employee: employeeId, year });
    if (!balance) {
        balance = await LeaveYearBalance.create({
            owner: ownerId, employee: employeeId, year,
            total: 0, bonus: 0, bonusHoursAccumulated: 0,
            usedPaid: 0, usedUnpaid: 0, remainingPaid: 0,
            lastRecalculatedAt: new Date(),
        });
    }

    let newAccumulated = (balance.bonusHoursAccumulated || 0) + earlyHours;
    let newBonus = balance.bonus || 0;

    while (newAccumulated >= 9) {
        newBonus += 1;
        newAccumulated -= 9;
        await LeaveTransaction.create({
            owner: ownerId, employee: employeeId, leaveYearBalance: balance._id,
            year, date: new Date(date), type: "BONUS_EARNED", value: 1,
            sourceModel: "Attendance", createdBy: employee.createdBy,
        });
    }

    balance.bonus = newBonus;
    balance.bonusHoursAccumulated = newAccumulated;
    balance.lastRecalculatedAt = new Date();
    await balance.save();

    await Attendance.updateOne(
        { employee: employeeId, date },
        { $set: { bonusApplied: true, bonusType: "EarlyBird", bonusHoursGiven: earlyHours } }
    );
    console.log(`[BONUS-UPDATE] EarlyBird -> Bonus=${newBonus}, Accumulated=${newAccumulated}`);
    return { bonus: newBonus, accumulated: newAccumulated, hoursGiven: earlyHours };
}

/**
 * Triggered at logout to apply bonuses
 */
async function applyRealTimeLogoutBonus(employeeId, ownerId, attendanceId, date) {
    try {
        const attendance = await Attendance.findById(attendanceId);
        if (!attendance || !attendance.checkIn || !attendance.checkOut) return null;

        // 1. Check if it's a Non-Working Day
        const payroll = await PayrollPeriod.findOne({
            owner: ownerId,
            shifts: { $in: [attendance.shiftId] } // Optional: match shift
        }).lean() || await PayrollPeriod.findOne({ owner: ownerId }).lean();

        if (payroll && checkIsNonWorkingDay(payroll, date)) {
            console.log(`[REALTIME-BONUS] Processing Non-Working Day for ${employeeId}`);
            return await updateBonusForNonWorkingDay(employeeId, attendance.checkIn, attendance.checkOut, date);
        }

        // 2. Otherwise Check for Early Bird
        const employee = await Employee.findById(employeeId).lean();
        const shiftId = employee?.shifts?.[0];
        if (shiftId) {
            const shiftDoc = await Shift.findById(shiftId).lean();
            if (shiftDoc && shiftDoc.start && shiftDoc.end) {
                console.log(`[REALTIME-BONUS] Checking Early Bird for ${employeeId}`);
                return await updateBonusForEarlyBird(
                    employeeId,
                    attendance.checkIn,
                    shiftDoc.start,
                    shiftDoc.end,
                    attendance.checkOut,
                    date
                );
            }
        }
        return null;
    } catch (err) {
        console.error("[REALTIME-LOGOUT-BONUS] Error:", err);
        return null;
    }
}

module.exports = {
    getHoursDiff,
    checkIsNonWorkingDay,
    updateBonusForNonWorkingDay,
    updateBonusForEarlyBird,
    applyRealTimeLogoutBonus
};
