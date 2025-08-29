const express = require("express");
const router = express.Router();
const requireAuth = require("../middleware/auth");
const Attendance = require("../models/Attendance");
const Employee = require("../models/Employees");

// Utility: Get all months between Jan and selected (inclusive)
function getAttendanceRange(year, month) {
    // Month is name ("October") or number (10)
    let endMonthNum = Number.isNaN(Number(month)) ?
        new Date(Date.parse(month + " 1, 2024")).getMonth() + 1 :
        Number(month);
    return {
        from: new Date(year, 0, 1), // Jan 1st
        to: new Date(year, endMonthNum, 1) // next month 1st
    };
}

// Converts lates, halfdays, absents into leaves as per your logic
function calculateLeaveUsed(records) {
    let lates = 0, halfdays = 0, paidAbsents = 0;
    for (const att of records) {
        if (att.status === "Late") lates++;
        if (att.status === "Half Day") halfdays++;
        if (att.status === "Absent" && att.leaveType === "Paid") paidAbsents++;
    }
    const fromLates = Math.floor(lates / 3);
    const fromHalfDays = Math.floor(halfdays / 2);
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
        console.log(`[API] /leave-summary | Params:`, { employeeId, month, year });

        if (!month || !year) {
            console.log("[API] /leave-summary | ERROR: Missing month/year");
            return res.status(400).json({ error: "month and year are required" });
        }

        // Get entitlement from employee profile
        const employee = await Employee.findById(employeeId);
        if (!employee) {
            console.log(`[API] /leave-summary | ERROR: Employee not found: ${employeeId}`);
            return res.status(404).json({ error: "Employee not found" });
        }
        const entitled = employee.leaveEntitled || 21; // Default 21
        console.log(`[API] /leave-summary | Employee entitled:`, entitled);

        // Get attendance records
        const monthPadded = String(
            Number.isNaN(Number(month)) ? (new Date(Date.parse(month + " 1, 2024")).getMonth() + 1) : Number(month)
        ).padStart(2, "0");
        const fromDate = `${year}-${monthPadded}-01`;
        const toDate = `${year}-${monthPadded}-31`; // (or use dayjs to get last day, but 31 is safe enough for query)
        console.log(`[API] /leave-summary | String-based fromDate: ${fromDate}, toDate: ${toDate}`);

        const attendances = await Attendance.find({
            employee: employeeId,
            date: { $gte: fromDate, $lte: toDate }
        });

        console.log(`[API] /leave-summary | Attendances found:`, attendances.length);

        const stats = calculateLeaveUsed(attendances);
        console.log(`[API] /leave-summary | Leave used stats:`, stats);

        // At the end of your /leave-summary route:
        res.json({
            Annual: {
                total: entitled,
                usedPaid: stats.used,
                usedMonth: stats.used, // (or implement logic for current month only if needed)
                balance: entitled - stats.used
            }
        });

    } catch (e) {
        console.error(e);
        res.status(500).json({ error: e.message });
    }
});


module.exports = router;
