const express = require("express");
const router = express.Router();
const requireAuth = require("../middleware/auth");
const Attendance = require("../models/Attendance");
const Employee = require("../models/Employees");
const requireEmpAuth = require("../middleware/empAuth");
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

    // --- Fix for January: always start from Jan 1st
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
    // Count paid absents, respecting 'proportionate'
    let paidAbsents = 0;
    for (const att of records) {
        if (att.status === "Absent" && att.leaveType === "Paid") {
            if (att.proportionate === true || att.proportionate === "true") {
                // if proportionate is true → use value if available, else 0.5
                paidAbsents += (att.proportionateValue !== undefined && att.proportionateValue !== null)
                    ? Number(att.proportionateValue)
                    : 0.5;
            } else {
                // if proportionate is false → always 1
                paidAbsents += 1;
            }
        }

    }
    const fromPaidAbsent = paidAbsents;

    // Calculate lates (with proportionate handling)
    const fromLates = countLeavesFromLates(records);

    // Half days (no proportionate logic needed here)
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
        // Also return original values for debugging
        originalFromLates: fromLates,
        originalFromHalfDays: fromHalfDays
    };
}

async function calculateYTDLeaveWithRunningBalance(employeeId, entitled, year, month, options = {}) {
    // For payroll, months are Jan=0, Feb=1, ..., Dec=11
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
    let skipMonthIndexes = options.skipMonthIndexes || [];
    for (let m = 0; m <= uptoMonthNum; m++) {
        if (skipMonthIndexes.includes(m)) continue;
        const monthName = months[m];
        const { from: mthFrom, to: mthTo } = getMonthRange(Number(year), monthName);

        // Don't fetch attendances before Jan 1
        let fromDate = mthFrom;
        const jan1 = new Date(Date.UTC(Number(year), 0, 1));
        if (new Date(mthFrom) < jan1 && new Date(mthTo) >= jan1) {
            fromDate = toYMD(jan1);
        }
        // Fetch for month
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

        // Remember used for the selected month only
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

router.get("/leave-summary/:employeeId", async (req, res) => {
    try {
        const { employeeId } = req.params;
        const { month, year } = req.query;
        if (!month || !year) return res.status(400).json({ error: "month and year are required" });

        // 1. Fetch employee
        const employee = await Employee.findById(employeeId);
        if (!employee) return res.status(404).json({ error: "Employee not found" });
        const total = employee.leaveEntitlement?.total;
        const bonus = employee.leaveEntitlement?.bonus || 0;
        const entitled = total + bonus;
        console.log("total: " + total + " bonus: " + bonus + " entitled: " + entitled);
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

        // 4. Calculate which months must be skipped for running balance
        //     - If the entire requested month is before joining/probation end and leave not allowed, skip!
        const months = [
            "January", "February", "March", "April", "May", "June",
            "July", "August", "September", "October", "November", "December"
        ];
        const uptoMonthNum = Number.isNaN(Number(month))
            ? new Date(Date.parse(month + " 1, " + year)).getMonth()
            : Number(month) - 1;

        // Compute for each month: payroll period end date
        let skipMonthIndexes = [];
        for (let m = 0; m <= uptoMonthNum; m++) {
            const monthName = months[m];
            const { to: mthTo } = getMonthRange(Number(year), monthName);
            let payrollPeriodEnd = new Date(mthTo);

            // 🚩 1. If payroll period ends before joining date, skip this month!
            if (payrollPeriodEnd < joiningDate) {
                skipMonthIndexes.push(m);
                continue;
            }
            // 🚩 2. If on probation (payroll period ends before probation end) and leave not allowed, skip this month!
            let onProbation = payrollPeriodEnd < probationEnd;
            if (onProbation && !leaveDuringProbation) {
                skipMonthIndexes.push(m);
            }
        }

        // 🚩 5. If the SELECTED month is skipped, respond with "-"
        if (skipMonthIndexes.includes(uptoMonthNum)) {
            return res.json({
                Annual: {
                    total: total,
                    bonus: bonus,
                    totalWithBonus: entitled,
                    usedPaid: "-",
                    usedMonth: "-",
                    balance: "-"
                }
            });
        }

        // 6. Proceed to leave calculation only for months after probation/joining
        const { ytdUsed, monthUsed, balance } = await calculateYTDLeaveWithRunningBalance(
            employeeId, entitled, Number(year), month, { skipMonthIndexes }
        );

        res.json({
            Annual: {
                total: total,
                bonus: bonus,
                totalWithBonus: entitled,
                usedPaid: ytdUsed,
                usedMonth: monthUsed,
                balance: balance
            }
        });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: e.message });
    }
});

router.get("/leave-summary-history/:employeeId", async (req, res) => {
    try {
        const { employeeId } = req.params;
        const { year } = req.query;
        if (!year) {
            console.warn("[leave-summary-history] year query param is missing.");
            return res.status(400).json({ error: "year is required" });
        }

        // 1. Fetch employee
        const employee = await Employee.findById(employeeId);
        if (!employee) {
            console.warn(`[leave-summary-history] Employee not found: ${employeeId}`);
            return res.status(404).json({ error: "Employee not found" });
        }

        // 2. Get Probation Policy (assuming latest one for owner)
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
            if (m > lastMonthWithAttendance) {
                results.push({
                    month: months[m],
                    usedPaid: "-",
                    usedMonth: "-",
                    balance: "-"
                });
                continue;
            }
            const monthName = months[m];
            const { from: mthFrom, to: mthTo } = getMonthRange(Number(year), monthName);

            // Parse payroll period end date and employee's joining date
            let payrollPeriodEnd = new Date(mthTo);
            let employeeJoiningDate = new Date(employee.joiningDate);

            // 🚩 1. If the payroll period ends before employee joined, skip
            if (payrollPeriodEnd < employeeJoiningDate) {
                results.push({
                    month: monthName,
                    usedPaid: "-",
                    usedMonth: "-",
                    balance: "-"
                });
                continue;
            }

            // 🚩 2. If on probation and leaves not allowed during probation, skip
            let onProbation = payrollPeriodEnd < probationEnd;
            if (onProbation && !leaveDuringProbation) {
                results.push({
                    month: monthName,
                    usedPaid: "-",
                    usedMonth: "-",
                    balance: "-"
                });
                continue;
            }

            // Normal logic: use only THIS month's attendances
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


        res.json({
            total: entitled ?? "-",
            history: results
        });


    } catch (e) {
        console.error("[leave-summary-history][ERROR]", e);
        res.status(500).json({ error: e.message });
    }
});


module.exports = router;
