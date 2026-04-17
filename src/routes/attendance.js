const router = require('express').Router();
const {
  markAttendance,
  getRecordsByDate,
  getStats,
  getRecordsByEmployee,
  getStatsByEmployee,
  getRecordsByDateRange,
  deleteRecord,
  creditBonusLeavesForPayrollPeriod,
  getChangeLogs,
  updateChallengeStatus
} = require('../controllers/attendanceController');
const Attendance = require('../models/Attendance');
const AttendanceLog = require('../models/AttendanceLog');
const anyPayrollAuth = require('../middleware/anyPayrollAuth');
const leaveYearBalanceController = require('../controllers/leaveYearBalanceController');
const Employee = require("../models/Employees");
const LeaveYearBalance = require("../models/LeaveYearBalance");
const LeaveTransaction = require("../models/LeaveTransaction");
const { getLeaveYear } = require("../utils/leaveEntitlement");

const attendanceAuth = require('../middleware/attendanceAuth');

router.get('/challenges', async (req, res) => {
  try {
    const query = { challengeStatus: 'Pending' };
    const ownerId = req.user.owner || req.user._id;

    // Apply scope if delegated
    if (req.user.isDelegated && Array.isArray(req.user.attendanceScope) && req.user.attendanceScope.length > 0) {
      query.employee = { $in: req.user.attendanceScope };
    } else {
      query.owner = ownerId;
    }

    const challenges = await Attendance.find(query)
      .populate('employee', 'name email companyEmail designation department')
      .sort({ challengeAt: -1 });

    res.json(challenges);
  } catch (err) {
    console.error('Fetch challenges failed:', err);
    res.status(500).json({ error: 'Failed to fetch challenges' });
  }
});

// existing endpoints
router.post('/', markAttendance);      // upsert by {employee, date}
router.get('/', (req, res) => {
  if (req.query.from || req.query.startDate) {
    return getRecordsByDateRange(req, res);
  }
  return getRecordsByDate(req, res);
});
router.get('/stats', getStats);            // GET /api/attendance/stats?date=YYYY-MM-DD
router.get('/change-logs', anyPayrollAuth, getChangeLogs); // GET /api/attendance/change-logs (admin)
router.get('/audit-logs', attendanceAuth, getChangeLogs); // GET /api/attendance/audit-logs (attendance app)

// Fiscal month logic (26th to 25th)
function getFiscalMonth(date) {
  const d = new Date(date);
  const day = d.getUTCDate();
  const month = d.getUTCMonth();
  const year = d.getUTCFullYear();

  const months = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"
  ];

  if (day >= 26) {
    if (month === 11) {
      return { month: "January", year: year + 1 };
    } else {
      return { month: months[month + 1], year };
    }
  } else {
    return { month: months[month], year };
  }
}

async function calculateMonthlyBalances(ownerId, employeeId, leaveYear) {
  // 1. Get leave balance for the year
  const leaveBalance = await LeaveYearBalance.findOne({
    owner: ownerId,
    employee: employeeId,
    year: leaveYear
  });

  if (!leaveBalance) {
    const employee = await Employee.findById(employeeId).lean();
    const profileYear = employee?.leaveEntitlement?.bonusYear;

    // Only use profile total if it matches the requested year
    let totalEntitled = 0;
    if (profileYear === leaveYear) {
      totalEntitled = employee?.leaveEntitlement?.total || 0;
    }

    return {
      initialBalance: totalEntitled,
      monthlyBalances: {},
      totalUsedPaid: 0,
      totalUsedUnpaid: 0,
      finalBalance: totalEntitled
    };
  }

  // 2. Get current FISCAL month
  const now = new Date();
  const currentFiscalMonth = getFiscalMonth(now);
  const currentYear = currentFiscalMonth.year;
  const currentMonthName = currentFiscalMonth.month;

  // 3. Get all transactions for the year, sorted by date
  const transactions = await LeaveTransaction.find({
    owner: ownerId,
    employee: employeeId,
    leaveYearBalance: leaveBalance._id,
    $or: [
      { type: "PAID_LEAVE_USED" },
      { type: "UNPAID_LEAVE_USED" },
      { type: "BONUS_EARNED" },
      { type: "PAID_LEAVE_REVERSED" },
      { type: "UNPAID_LEAVE_REVERSED" },
      { type: "PAID_LEAVE_CREDITED" },
      { type: "ADJUSTMENT" }
    ]
  }).sort({ date: 1 }).lean();

  // 4. Group transactions by fiscal month
  const months = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"
  ];

  const monthlyData = {};
  months.forEach(month => {
    monthlyData[month] = {
      paidUsed: 0,
      unpaidUsed: 0,
      bonusAdded: 0,
      credited: 0
    };
  });

  // 5. Aggregate transactions by fiscal month
  let yearCredits = 0;
  for (const tx of transactions) {
    const fiscalMonth = getFiscalMonth(tx.date);
    const monthName = fiscalMonth.month;
    if (!monthlyData[monthName]) continue;

    switch (tx.type) {
      case "PAID_LEAVE_USED": monthlyData[monthName].paidUsed += tx.value || 0; break;
      case "UNPAID_LEAVE_USED": monthlyData[monthName].unpaidUsed += tx.value || 0; break;
      case "BONUS_EARNED": monthlyData[monthName].bonusAdded += tx.value || 0; break;
      case "ADJUSTMENT": monthlyData[monthName].bonusAdded += tx.value || 0; break;
      case "PAID_LEAVE_CREDITED":
        monthlyData[monthName].credited += tx.value || 0;
        yearCredits += tx.value || 0;
        break;
      case "PAID_LEAVE_REVERSED": monthlyData[monthName].paidUsed -= tx.value || 0; break;
      case "UNPAID_LEAVE_REVERSED": monthlyData[monthName].unpaidUsed -= tx.value || 0; break;
    }
  }

  // 6. Calculate initial balance (start of year) and running balance month by month
  const calculatedInitialBalance = (leaveBalance.total || 0) - yearCredits;
  let runningBalance = calculatedInitialBalance;
  const monthlyBalances = {};
  let totalUsedPaid = 0;
  let totalUsedUnpaid = 0;

  const monthIndexMap = {};
  months.forEach((month, index) => {
    monthIndexMap[month] = index;
  });

  for (const month of months) {
    const monthData = monthlyData[month];
    totalUsedPaid += monthData.paidUsed;
    totalUsedUnpaid += monthData.unpaidUsed;

    const isFutureMonth = (
      leaveYear > currentYear ||
      (leaveYear === currentYear && monthIndexMap[month] > monthIndexMap[currentMonthName])
    );

    if (isFutureMonth) {
      monthlyBalances[month] = {
        balance: "-",
        paidUsed: "-",
        unpaidUsed: "-",
        bonusAdded: "-",
        credited: "-",
        isFuture: true
      };
    } else {
      // balance = prev_balance + credits - used + bonus
      runningBalance = runningBalance + (monthData.credited || 0) - monthData.paidUsed + monthData.bonusAdded;

      monthlyBalances[month] = {
        balance: runningBalance,
        paidUsed: monthData.paidUsed,
        unpaidUsed: monthData.unpaidUsed,
        bonusAdded: monthData.bonusAdded,
        credited: monthData.credited,
        isFuture: false
      };
    }
  }

  return {
    initialBalance: calculatedInitialBalance,
    monthlyBalances,
    totalUsedPaid,
    totalUsedUnpaid,
    finalBalance: runningBalance
  };
}
// GET between-shift login logs
router.get('/logs/between-shift', anyPayrollAuth, async (req, res) => {
  try {
    let { ownerId, startDate, endDate, employeeId } = req.query;

    // If ownerId not provided in query, use the authenticated user's owner from middleware
    if (!ownerId && req.user) {
      ownerId = req.user.owner;
    }

    if (!ownerId) {
      return res.status(401).json({ error: "Authentication failed: Unable to determine company ID. Please log in again." });
    }

    const query = { owner: ownerId };

    if (employeeId) {
      query.employee = employeeId;
    }

    if (startDate && endDate) {
      query.date = { $gte: startDate, $lte: endDate };
    }

    const logs = await AttendanceLog.find(query)
      .populate('employee', 'name email companyEmail')
      .populate('firstShiftId', 'name start end')
      .populate('secondShiftId', 'name start end')
      .sort({ createdAt: -1 })
      .lean();

    return res.json({
      status: 'success',
      total: logs.length,
      data: logs
    });
  } catch (err) {
    console.error('[ATTENDANCE-LOGS] Error:', err);
    return res.status(500).json({ error: 'Server error fetching logs' });
  }
});

// UPDATE LOG STATUS (for admin review)
router.patch('/logs/between-shift/:id', anyPayrollAuth, async (req, res) => {
  try {
    const { status, notes } = req.body;
    const logId = req.params.id;

    const updateData = {};
    if (status) updateData.status = status;
    if (notes) updateData.notes = notes;
    updateData.reviewedBy = req.user._id;
    updateData.reviewedAt = new Date();

    const updated = await AttendanceLog.findByIdAndUpdate(
      logId,
      updateData,
      { new: true }
    ).populate('employee', 'name email companyEmail');

    return res.json({
      status: 'success',
      data: updated
    });
  } catch (err) {
    console.error('[ATTENDANCE-LOGS-UPDATE] Error:', err);
    return res.status(500).json({ error: 'Server error updating log' });
  }
});
router.get('/employee/:id', getRecordsByEmployee);
router.get('/employee/:employeeId/current', leaveYearBalanceController.getCurrentYearLeaveBalance);

router.get('/employee/:id/stats', getStatsByEmployee);
router.get('/range', getRecordsByDateRange);
router.patch('/:id/challenge', updateChallengeStatus);
router.delete('/:id', deleteRecord);
router.get("/leave-summary/:employeeId", async (req, res) => {
  try {
    const { employeeId } = req.params;
    const { month, year } = req.query;

    if (!month || !year) {
      return res.status(400).json({ error: "month and year are required" });
    }

    const employee = await Employee.findById(employeeId);
    if (!employee) {
      return res.status(404).json({ error: "Employee not found" });
    }

    if (String(employee.owner) !== String(req.user.owner)) {
      return res.status(403).json({ error: "Unauthorized access to employee data" });
    }

    const ownerId = Array.isArray(employee.owner) ? employee.owner[0] : employee.owner;
    const leaveYear = Number(year);

    const balanceData = await calculateMonthlyBalances(ownerId, employeeId, leaveYear);
    const monthBalance = balanceData.monthlyBalances[month] || {
      balance: balanceData.initialBalance,
      paidUsed: 0,
      unpaidUsed: 0
    };

    const leaveBalance = await LeaveYearBalance.findOne({
      owner: ownerId,
      employee: employeeId,
      year: leaveYear
    });

    const total = leaveBalance?.total || 0;
    const bonus = leaveBalance?.bonus || 0;
    const totalWithBonus = total + bonus;
    const usedPaidYTD = balanceData.totalUsedPaid;
    const usedUnpaidYTD = balanceData.totalUsedUnpaid;
    const usedPaidMonth = typeof monthBalance.paidUsed === 'number' ? monthBalance.paidUsed : 0;
    const usedUnpaidMonth = typeof monthBalance.unpaidUsed === 'number' ? monthBalance.unpaidUsed : 0;
    const balance = monthBalance.balance;

    const remainingPaid = leaveBalance?.remainingPaid || 0;

    res.json({
      Annual: {
        total,
        bonus,
        totalWithBonus,
        usedPaidYTD,
        usedUnpaidYTD,
        usedPaidMonth,
        usedUnpaidMonth,
        balance,
        remainingPaid
      }
    });
  } catch (e) {
    console.error("[leave-summary][ERROR]", e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
