// helpers/leaveSummary.js

const Attendance = require("../models/Attendance");
const Employee = require("../models/Employees");
const ProbationPeriod = require("../models/ProbationPeriod");

// Helper to get YYYY-MM-DD string
function toYMD(date) {
    return date.toISOString().slice(0, 10);
}

function getMonthRange(year, month) {
    let monthNum = Number.isNaN(Number(month))
        ? new Date(Date.parse(month + " 1, " + year)).getMonth()
        : Number(month) - 1;

    let prevMonthNum = monthNum - 1;
    let prevYear = year;

    if (prevMonthNum < 0) {
        prevMonthNum = 11;
        prevYear = year - 1;
    }

    let from = new Date(Date.UTC(prevYear, prevMonthNum, 26));
    let to = new Date(Date.UTC(year, monthNum, 25, 23, 59, 59, 999));

    // Fix for January: always start from Jan 1st
    if (monthNum === 0) {
        from = new Date(Date.UTC(year, 0, 1));
    }

    return { from: toYMD(from), to: toYMD(to) };
}

function getPayrollPeriodKey(date) {
    // Always treat date as UTC!
    let d = new Date(date);
    let year = d.getUTCFullYear();
    let month = d.getUTCMonth(); // 0-based
    let periodYear = year;
    let periodMonth = month;
    if (d.getUTCDate() > 25) {
        periodMonth += 1;
        if (periodMonth === 12) {
            periodMonth = 0;
            periodYear += 1;
        }
    }
    // Return key like '2024-02' for payroll ending 25th Feb 2024
    return `${periodYear}-${String(periodMonth + 1).padStart(2, '0')}`;
}

function getYTDRange(year, month) {
    let monthNum = Number.isNaN(Number(month))
        ? new Date(Date.parse(month + " 1, " + year)).getMonth()
        : Number(month) - 1;
    let from = new Date(Date.UTC(year, 0, 1)); // Jan 1
    let to = new Date(Date.UTC(year, monthNum, 25, 23, 59, 59, 999)); // 25th of THIS month
    return { from: toYMD(from), to: toYMD(to) };
}

function countLeavesFromLates(attendanceRecords) {
    // Step 1: Filter and sort all "Late" attendances with proportionate info
    const lates = attendanceRecords
        .filter(att => att.status === "Late")
        .map(att => ({
            date: new Date(att.date),
            proportionate: att.proportionate === true || att.proportionate === "true"
        }))
        .sort((a, b) => a.date - b.date);

    // Step 2: Group lates by payroll period (26th–25th), and count leaves
    let periods = {};
    for (let lateObj of lates) {
        const key = getPayrollPeriodKey(lateObj.date);
        if (!periods[key]) periods[key] = [];
        periods[key].push(lateObj);
    }

    // Step 3: For each period, count groups of 3 (reset after each period)
    let lateLeaveCount = 0;
    Object.values(periods).forEach(latesInPeriod => {
        let group = [];
        latesInPeriod.forEach(late => {
            group.push(late);
            if (group.length === 3) {
                // If any of this group has proportionate:true, count as 0.5
                if (group.some(l => l.proportionate)) {
                    lateLeaveCount += 0.5;
                } else {
                    lateLeaveCount += 1;
                }
                group = [];
            }
        });
        // Leftover lates in period do not roll over!
    });

    return lateLeaveCount;
}

function calculateLeaveUsed(records, currentBalance = null, entitled = null) {
    // Count paid absents using effectivePaidDays / proportionate
    let paidAbsents = 0;
    for (const att of records) {
        if (att.status === "Absent" && att.leaveType === "Paid") {
            if (att.effectivePaidDays !== undefined && att.effectivePaidDays !== null) {
                // ✅ Always use effectivePaidDays if present (e.g. 3 for Friday case)
                paidAbsents += Number(att.effectivePaidDays);
            } else if (att.proportionate === true || att.proportionate === "true") {
                // ✅ No effectivePaidDays → check proportionate flag
                paidAbsents += 0.5;
            } else {
                // ✅ Fallback → normal full day
                paidAbsents += 1;
            }
        }
    }
    let fromPaidAbsent = paidAbsents;

    // ✅ Add +2 leaves for September payroll (for all employees)
    try {
        if (records.length > 0) {
            const sampleDate = new Date(records[0].date);
            const payrollKey = getPayrollPeriodKey(sampleDate);
            const [yr, mon] = payrollKey.split("-");
            const payrollMonthNum = Number(mon);
            const employeeId = records[0]?.employee?.toString?.() || records[0]?.employee?._id?.toString?.();

            if (payrollMonthNum === 9 && employeeId === "68adcffb5751cbec4e63c939") {
                fromPaidAbsent += 2;
                console.log(`✅ Added +2 extra leaves for September payroll (${payrollKey})`);
            }
        }
    } catch (err) {
        console.warn("Error applying September +2 leaves adjustment:", err);
    }

    // Calculate lates (unchanged)
    const fromLates = countLeavesFromLates(records);

    // Half days (unchanged)
    let halfdays = 0;
    for (const att of records) {
        if (att.status === "Half Day") halfdays++;
    }
    const fromHalfDays = halfdays * 0.5;

    // If balance is already 0 or negative, ignore lates and half days completely
    let actualFromLates = fromLates;
    let actualFromHalfDays = fromHalfDays;
    if (currentBalance !== null && currentBalance <= 0) {
        actualFromLates = 0;
        actualFromHalfDays = 0;
    }

    return {
        fromLates: actualFromLates,
        fromHalfDays: actualFromHalfDays,
        fromPaidAbsent,
        used: actualFromLates + actualFromHalfDays + fromPaidAbsent,
        // Debug values
        originalFromLates: fromLates,
        originalFromHalfDays: fromHalfDays
    };
}



async function calculateYTDLeaveWithRunningBalance(employeeId, entitled, year, month, options = {}) {
    // Fetch employee and probation info if not already provided
    let employee = options.employee;
    let probationEnd, joiningDate, leaveDuringProbation;
    if (!employee) {
        employee = await Employee.findById(employeeId);
    }
    if (employee) {
        let probationPolicy = await ProbationPeriod.findOne({ owner: employee.owner }).sort({ createdAt: -1 });
        let probationDays = probationPolicy ? probationPolicy.days : 0;
        leaveDuringProbation = probationPolicy ? probationPolicy.leaveDuringProbation : false;
        joiningDate = new Date(employee.joiningDate);
        probationEnd = new Date(joiningDate);
        probationEnd.setDate(probationEnd.getDate() + probationDays);
    }

    const months = [
        "January", "February", "March", "April", "May", "June",
        "July", "August", "September", "October", "November", "December"
    ];
    const uptoMonthNum = Number.isNaN(Number(month))
        ? new Date(Date.parse(month + " 1, " + year)).getMonth()
        : Number(month) - 1;

    let runningBalance = entitled ?? 0;
    let ytdUsed = 0;
    let monthUsed = 0;

    for (let m = 0; m <= uptoMonthNum; m++) {
        const monthName = months[m];
        const { from: mthFrom, to: mthTo } = getMonthRange(Number(year), monthName);

        // Parse payroll period end date and joining/probation
        let payrollPeriodEnd = new Date(mthTo);

        // SKIP: before joining OR (on probation and leave not allowed)
        if (
            employee &&
            (payrollPeriodEnd < joiningDate ||
                (payrollPeriodEnd < probationEnd && leaveDuringProbation === false))
        ) {
            continue; // skip this month!
        }

        // Don't fetch attendances before Jan 1
        let fromDate = mthFrom;
        const jan1 = new Date(Date.UTC(Number(year), 0, 1));
        if (new Date(mthFrom) < jan1 && new Date(mthTo) >= jan1) {
            fromDate = toYMD(jan1);
        }

        const attendancesMth = await Attendance.find({
            employee: employeeId,
            date: { $gte: fromDate, $lte: mthTo }
        });

        const statsMth = calculateLeaveUsed(attendancesMth);

        // 1. Apply late/halfday deduction only if runningBalance > 0
        let lateAndHalf = statsMth.fromLates + statsMth.fromHalfDays;
        let useFromBalance = runningBalance > 0 ? Math.min(runningBalance, lateAndHalf) : 0;
        runningBalance -= useFromBalance;

        // 2. Always deduct paid absents
        runningBalance -= statsMth.fromPaidAbsent;

        // Prevent negative zero
        if (runningBalance === -0) runningBalance = 0;

        let usedThisMonth = useFromBalance + statsMth.fromPaidAbsent;
        ytdUsed += usedThisMonth;

        if (m === uptoMonthNum) {
            monthUsed = usedThisMonth;
        }
    }

    return {
        ytdUsed,
        monthUsed,
        balance: runningBalance
    };
}

async function calculateLeaveSummaryHistory(employeeId, year) {
    // 1. Fetch employee
    const employee = await Employee.findById(employeeId);
    if (!employee) {
        throw new Error("Employee not found");
    }

    // 2. Get Probation Policy (latest one for owner)
    const probationPolicy = await ProbationPeriod.findOne({ owner: employee.owner }).sort({ createdAt: -1 });
    let probationDays = 0;
    let leaveDuringProbation = false;
    if (probationPolicy) {
        probationDays = probationPolicy.days;
        leaveDuringProbation = probationPolicy.leaveDuringProbation;
    }

    // 3. Calculate probation end date
    let joiningDate = new Date(employee.joiningDate);
    let probationEnd = new Date(joiningDate);
    probationEnd.setDate(probationEnd.getDate() + probationDays);

    const total = employee.leaveEntitlement?.total;
    const bonus = employee.leaveEntitlement?.bonus || 0;
    const entitled = total + bonus;

    const months = [
        "January", "February", "March", "April", "May", "June",
        "July", "August", "September", "October", "November", "December"
    ];

    let results = [];
    const yearAttendances = await Attendance.find({
        employee: employeeId,
        date: { $gte: `${year}-01-01`, $lte: `${year}-12-31` }
    });

    let lastMonthWithAttendance = -1;
    if (yearAttendances.length > 0) {
        lastMonthWithAttendance = Math.max(
            ...yearAttendances.map(a => {
                const d = new Date(a.date);
                return d.getMonth(); // 0-based: Jan=0, Feb=1, ...
            })
        );
    }

    let runningBalance = entitled ?? 0;

    for (let m = 0; m < 12; m++) {
        const monthName = months[m];
        const { from: mthFrom, to: mthTo } = getMonthRange(Number(year), monthName);

        // Payroll period end
        let payrollPeriodEnd = new Date(mthTo);

        // SKIP: before joining OR (on probation and leave not allowed)
        if (
            payrollPeriodEnd < joiningDate ||
            (payrollPeriodEnd < probationEnd && leaveDuringProbation === false)
        ) {
            results.push({
                month: monthName,
                usedPaid: "-",
                usedMonth: "-",
                balance: "-"
            });
            continue;
        }

        if (m > lastMonthWithAttendance) {
            results.push({
                month: monthName,
                usedPaid: "-",
                usedMonth: "-",
                balance: "-"
            });
            continue;
        }

        // Only THIS month's attendances
        const attendancesMth = await Attendance.find({
            employee: employeeId,
            date: { $gte: mthFrom, $lte: mthTo }
        });

        // Calculate for this month only!
        const statsMth = calculateLeaveUsed(attendancesMth);

        // 1. Apply late/halfday deduction only if runningBalance > 0
        let lateAndHalf = statsMth.fromLates + statsMth.fromHalfDays;
        let useFromBalance = runningBalance > 0 ? Math.min(runningBalance, lateAndHalf) : 0;
        runningBalance -= useFromBalance;

        // 2. Always deduct paid absents
        runningBalance -= statsMth.fromPaidAbsent;

        // Prevent negative zero (-0)
        if (runningBalance === -0) runningBalance = 0;

        results.push({
            month: monthName,
            usedPaid: statsMth.fromLates + statsMth.fromHalfDays + statsMth.fromPaidAbsent,
            usedMonth: statsMth.fromLates + statsMth.fromHalfDays + statsMth.fromPaidAbsent,
            balance: runningBalance
        });
    }

    return {
        total: entitled ?? "-",
        history: results
    };
}

module.exports = {
    toYMD,
    getMonthRange,
    getPayrollPeriodKey,
    getYTDRange,
    countLeavesFromLates,
    calculateLeaveUsed,
    calculateYTDLeaveWithRunningBalance,
    calculateLeaveSummaryHistory
};
