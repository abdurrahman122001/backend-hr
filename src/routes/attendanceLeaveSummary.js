const express = require("express");
const router = express.Router();
const requireAuth = require("../middleware/auth");
const Attendance = require("../models/Attendance");
const Employee = require("../models/Employees");

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


function getYTDRange(year, month) {
  let monthNum = Number.isNaN(Number(month)) ?
    new Date(Date.parse(month + " 1, " + year)).getMonth() :
    Number(month) - 1;
  let from = new Date(Date.UTC(year, 0, 1)); // Jan 1
  let to = new Date(Date.UTC(year, monthNum + 1, 25, 23, 59, 59, 999)); // 25th this month
  return { from: toYMD(from), to: toYMD(to) };
}

function calculateLeaveUsed(records) {
  let lates = 0, halfdays = 0, paidAbsents = 0;
  for (const att of records) {
    if (att.status === "Late") lates++;
    if (att.status === "Half Day") halfdays++;
    if (att.status === "Absent" && att.leaveType === "Paid") paidAbsents++;
  }
  const fromLates = Math.floor(lates / 3);        // 3 Lates = 1 Leave
  const fromHalfDays = halfdays * 0.5;            // Each Half Day = 0.5 Leave
  const fromPaidAbsent = paidAbsents;             // Each paid absent = 1 Leave

  // If you want leave as decimal (e.g., 2.5), keep as is. If you need integer, Math.floor or Math.round as needed.
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
    const entitled = (employee.leaveEntitlement && employee.leaveEntitlement.total) || 22;

    // Month period (26 prev - 25 current)
    const { from: mthFrom, to: mthTo } = getMonthRange(Number(year), month);
    // YTD period (Jan 1 - 25 current)
    const { from: ytdFrom, to: ytdTo } = getYTDRange(Number(year), month);

    console.log("[API] /leave-summary | Params:", { employeeId, month, year });
    console.log("[API] /leave-summary | MTH period:", mthFrom, mthTo);
    console.log("[API] /leave-summary | YTD period:", ytdFrom, ytdTo);

    // Always string compare for date!
    const attendancesMth = await Attendance.find({
      employee: employeeId,
      date: { $gte: mthFrom, $lte: mthTo }
    });
    const attendancesYTD = await Attendance.find({
      employee: employeeId,
      date: { $gte: ytdFrom, $lte: ytdTo }
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

module.exports = router;
