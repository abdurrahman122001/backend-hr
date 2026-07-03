const express = require("express");
const router = express.Router();
const Employee = require("../models/Employees");
const LeaveYearBalance = require("../models/LeaveYearBalance");
const LeaveTransaction = require("../models/LeaveTransaction");
const { getLeaveYear } = require("../utils/leaveEntitlement");
const leaveYearBalanceController = require("../controllers/leaveYearBalanceController");
const empAuth = require("../middleware/empAuth");
const attendanceAuth = require("../middleware/attendanceAuth");
const requireAuth = require("../middleware/auth");
// Get month range for your fiscal calendar (26th to 25th)
function getMonthRange(year, monthName) {
    const months = [
        "January", "February", "March", "April", "May", "June",
        "July", "August", "September", "October", "November", "December"
    ];

    const monthIndex = months.indexOf(monthName);
    const prevMonthIndex = monthIndex === 0 ? 11 : monthIndex - 1;
    const prevYear = monthIndex === 0 ? year - 1 : year;

    let from = new Date(Date.UTC(prevYear, prevMonthIndex, 26));
    let to = new Date(Date.UTC(year, monthIndex, 25, 23, 59, 59, 999));

    // For January, start from Jan 1st
    if (monthIndex === 0) {
        from = new Date(Date.UTC(year, 0, 1));
    }

    return {
        from: from.toISOString().split('T')[0],
        to: to.toISOString().split('T')[0]
    };
}

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

// NEW: Calculate monthly running balances from transactions
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
           
            case "PAID_LEAVE_REVERSED": monthlyData[monthName].paidUsed -= tx.value || 0; break;
            case "UNPAID_LEAVE_REVERSED": monthlyData[monthName].unpaidUsed -= tx.value || 0; break;
        }
    }

    // 6. Calculate initial balance (start of year) and running balance month by month
    const calculatedInitialBalance = (leaveBalance.total || 0) ;
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

// GET /leave-summary/:employeeId?month=&year=
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

        // Allow self-access for employees OR check owner match for admins
        const isSelf = String(employee._id) === String(req.user.employeeId || req.user._id);
        const isAdminOfOwner = String(employee.owner) === String(req.user.owner);

        if (!isSelf && !isAdminOfOwner) {
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

// GET /leave-summary-history/:employeeId?year=
router.get("/:employeeId", async (req, res) => {
    try {
        const { employeeId } = req.params;
        const { year } = req.query;

        if (!year) {
            return res.status(400).json({ error: "year is required" });
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

        const months = [
            "January", "February", "March", "April", "May", "June",
            "July", "August", "September", "October", "November", "December"
        ];

        const history = months.map(month => {
            const monthData = balanceData.monthlyBalances[month] || {
                balance: "-",
                paidUsed: "-",
                unpaidUsed: "-",
                bonusAdded: "-",
                isFuture: true
            };

            return {
                month,
                usedPaid: monthData.paidUsed,
                usedMonth: monthData.paidUsed,
                balance: monthData.balance,
                unpaidUsed: monthData.unpaidUsed,
                bonusAdded: monthData.bonusAdded
            };
        });

        const leaveBalance = await LeaveYearBalance.findOne({
            owner: ownerId,
            employee: employeeId,
            year: leaveYear
        }).lean();

        res.json({
            total: balanceData.finalBalance, // Remaining balance
            initialBalance: balanceData.initialBalance,
            bonus: leaveBalance?.bonus || 0,
            // Accumulated overtime/bonus hours (9 hrs converts to 1 bonus day)
            bonusHours: leaveBalance?.bonusHoursAccumulated || 0,
            history
        });
    } catch (e) {
        console.error("[leave-summary-history][ERROR]", e);
        res.status(500).json({ error: e.message });
    }
});

// GET /leave-transactions/:employeeId?year=&month=
router.get("/leave-transactions/:employeeId", async (req, res) => {
    try {
        const { employeeId } = req.params;
        const { year, month } = req.query;

        const employee = await Employee.findById(employeeId);
        if (!employee) return res.status(404).json({ error: "Employee not found" });

        const ownerId = employee.owner;
        const query = { owner: ownerId, employee: employeeId };

        if (year) {
            const targetYear = getLeaveYear(new Date(`${year}-12-26`));
            const lb = await LeaveYearBalance.findOne({ owner: ownerId, employee: employeeId, year: targetYear });
            if (lb) query.leaveYearBalance = lb._id;
        }

        if (month && year) {
            const { from, to } = getMonthRange(parseInt(year), month);
            query.date = { $gte: new Date(from), $lte: new Date(to) };
        }

        const transactions = await LeaveTransaction.find(query).sort({ date: -1, createdAt: -1 }).lean();

        res.json({
            success: true,
            transactions: transactions.map(tx => ({
                id: tx._id,
                type: tx.type,
                value: tx.value,
                date: tx.date ? new Date(tx.date).toISOString().split('T')[0] : null,
                sourceModel: tx.sourceModel,
                sourceId: tx.sourceId,
                createdAt: tx.createdAt
            }))
        });
    } catch (e) {
        console.error("[leave-transactions][ERROR]", e);
        res.status(500).json({ error: e.message });
    }
});

// GET /leave-balance/:employeeId?date=
router.get("/leave-balance/:employeeId", async (req, res) => {
    try {
        const { employeeId } = req.params;
        const { date } = req.query;

        const employee = await Employee.findById(employeeId);
        if (!employee) return res.status(404).json({ error: "Employee not found" });

        const ownerId = employee.owner;
        const targetDate = date ? new Date(date) : new Date();
        const leaveYear = getLeaveYear(targetDate);

        const balanceData = await calculateMonthlyBalances(ownerId, employeeId, leaveYear);
        const fiscalMonth = getFiscalMonth(targetDate);
        const currentMonthBalance = fiscalMonth.year === leaveYear
            ? (balanceData.monthlyBalances[fiscalMonth.month]?.balance !== "-" ? balanceData.monthlyBalances[fiscalMonth.month]?.balance : balanceData.finalBalance)
            : balanceData.initialBalance;

        const leaveBalance = await LeaveYearBalance.findOne({ owner: ownerId, employee: employeeId, year: leaveYear });

        res.json({
            success: true,
            year: leaveYear,
            balance: {
                total: leaveBalance?.total,
                bonus: leaveBalance?.bonus || 0,
                usedPaid: balanceData.totalUsedPaid,
                usedUnpaid: balanceData.totalUsedUnpaid,
                remainingPaid: currentMonthBalance,
                available: currentMonthBalance
            }
        });
    } catch (e) {
        console.error("[leave-balance][ERROR]", e);
        res.status(500).json({ error: e.message });
    }
});

router.get("/available-years", async (req, res) => {
    try {
        const rawOwnerId = req.user.owner;
        const ownerId = Array.isArray(rawOwnerId) ? rawOwnerId[0] : rawOwnerId;
        const years = await LeaveYearBalance.distinct("year", { owner: ownerId });
        
        let yearList = years.filter(y => y != null);
        const currentYear = new Date().getFullYear();
        
        // Ensure 2025 and 2026 are always included as requested and for current cycle
        if (!yearList.includes(2025)) yearList.push(2025);
        if (!yearList.includes(2026)) yearList.push(2026);
        if (!yearList.includes(currentYear)) yearList.push(currentYear);
        
        const sortedYears = [...new Set(yearList)].sort((a, b) => b - a);
        res.json({ years: sortedYears });
    } catch (e) {
        res.json({ years: [2025, 2026, new Date().getFullYear()] });
    }
});

router.get("/employee/:employeeId/current", leaveYearBalanceController.getCurrentYearLeaveBalance);
router.put("/update-balance/:employeeId", leaveYearBalanceController.upsertLeaveBalance);
router.put("/admin/update-balance/:employeeId", leaveYearBalanceController.upsertLeaveBalance);

module.exports = router;