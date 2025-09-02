const express = require("express");
const router = express.Router();
const requireAuth = require("../middleware/auth");
const Attendance = require("../models/Attendance");
const Employee = require("../models/Employees");
const ProbationPeriod = require("../models/ProbationPeriod");

// Helper to get YYYY-MM-DD string
function toYMD(date) {
    return date.toISOString().slice(0, 10);
}

function getMonthRange(year, month) {
    // Get the numeric month (0-based, so Jan=0)
    let monthNum = Number.isNaN(Number(month))
        ? new Date(Date.parse(month + " 1, " + year)).getMonth()
        : Number(month) - 1;

    // MTH period for "September": 26 Aug to 25 Sep
    let prevMonthNum = monthNum - 1;
    let prevYear = year;

    // If month is January (0), prevMonthNum = -1 → December of previous year
    if (prevMonthNum < 0) {
        prevMonthNum = 11;
        prevYear = year - 1;
    }


    let from = new Date(Date.UTC(prevYear, prevMonthNum, 26));
    let to = new Date(Date.UTC(year, monthNum, 25, 23, 59, 59, 999));

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
    // Step 1: Filter and sort all "Late" attendances
    const lates = attendanceRecords
        .filter(att => att.status === "Late")
        .map(att => new Date(att.date))
        .sort((a, b) => a - b);

    // Step 2: Group lates by payroll period (26th–25th), and count leaves
    let periods = {};
    for (let lateDate of lates) {
        const key = getPayrollPeriodKey(lateDate);
        if (!periods[key]) periods[key] = [];
        periods[key].push(lateDate);
    }

    // Step 3: For each period, count groups of 3 (reset after each period)
    let lateLeaveCount = 0;
    Object.values(periods).forEach(latesInPeriod => {
        let counter = 0;
        latesInPeriod.forEach(() => {
            counter++;
            if (counter === 3) {
                lateLeaveCount++;
                counter = 0;
            }
        });
        // Leftover lates in period do not roll over!
    });

    return lateLeaveCount;
}

function calculateLeaveUsed(records) {
    const fromLates = countLeavesFromLates(records);

    let halfdays = 0, paidAbsents = 0;
    for (const att of records) {
        if (att.status === "Half Day") halfdays++;
        if (att.status === "Absent" && att.leaveType === "Paid") paidAbsents++;
    }
    const fromHalfDays = halfdays * 0.5;            
    const fromPaidAbsent = paidAbsents;             

    return {
        fromLates,
        fromHalfDays,
        fromPaidAbsent,
        used: fromLates + fromHalfDays + fromPaidAbsent
    };
}


router.get("/leave-summary/:employeeId", requireAuth, async (req, res) => {
    try {
        const { employeeId } = req.params;
        const { month, year } = req.query;
        if (!month || !year) return res.status(400).json({ error: "month and year are required" });

        // Fetch entitlement
        const employee = await Employee.findById(employeeId);
        if (!employee) return res.status(404).json({ error: "Employee not found" });
        const entitled = (employee.leaveEntitlement && employee.leaveEntitlement.total);

        // Month period (26 prev - 25 current)
        const { from: mthFrom, to: mthTo } = getMonthRange(Number(year), month);
        // YTD period (Jan 1 - 25 current)
        const { from: ytdFrom, to: ytdTo } = getYTDRange(Number(year), month);

        console.log("[API] /leave-summary | Params:", { employeeId, month, year });
        console.log("[API] /leave-summary | MTH period:", mthFrom, mthTo);
        console.log("[API] /leave-summary | YTD period:", ytdFrom, ytdTo);

        const jan1 = new Date(Date.UTC(Number(year), 0, 1));
        let mthStart = mthFrom;
        if (new Date(mthFrom) < jan1 && new Date(mthTo) >= jan1) {
            mthStart = toYMD(jan1); // Only consider records from Jan 1
        }
        const attendancesMth = await Attendance.find({
            employee: employeeId,
            date: { $gte: mthStart, $lte: mthTo }
        });

        const attendancesYTD = await Attendance.find({
            employee: employeeId,
            date: { $gte: toYMD(jan1), $lte: ytdTo }
        });


        console.log(`[API] /leave-summary | Attendances (MTH): ${attendancesMth.length}`);
        console.log(`[API] /leave-summary | Attendances (YTD): ${attendancesYTD.length}`);

        const statsMth = calculateLeaveUsed(attendancesMth);
        const statsYTD = calculateLeaveUsed(attendancesYTD);

        res.json({
            Annual: {
                total: entitled,
                usedPaid: statsYTD.used,
                usedMonth: statsMth.used,
                balance: entitled - statsYTD.used
            }
        });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: e.message });
    }
});

router.get("/leave-summary-history/:employeeId", requireAuth, async (req, res) => {
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

        const entitled = (employee.leaveEntitlement && employee.leaveEntitlement.total);

        const months = [
            "January", "February", "March", "April", "May", "June",
            "July", "August", "September", "October", "November", "December"
        ];

        let results = [];

        for (let m = 0; m < 12; m++) {
            const monthName = months[m];
            const { from: mthFrom, to: mthTo } = getMonthRange(Number(year), monthName);
            const { from: ytdFrom, to: ytdTo } = getYTDRange(Number(year), monthName);

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

            // Normal logic
            const attendancesMth = await Attendance.find({
                employee: employeeId,
                date: { $gte: mthFrom, $lte: mthTo }
            });
            const jan1 = new Date(Date.UTC(Number(year), 0, 1));
            const attendancesYTD = await Attendance.find({
                employee: employeeId,
                date: { $gte: toYMD(jan1), $lte: ytdTo }
            });


            const statsMth = calculateLeaveUsed(attendancesMth);
            const statsYTD = calculateLeaveUsed(attendancesYTD);

            results.push({
                month: monthName,
                usedPaid: statsYTD.used,
                usedMonth: statsMth.used,
                balance: entitled - statsYTD.used
            });
        }


        res.json(results);

    } catch (e) {
        console.error("[leave-summary-history][ERROR]", e);
        res.status(500).json({ error: e.message });
    }
});

module.exports = router;
