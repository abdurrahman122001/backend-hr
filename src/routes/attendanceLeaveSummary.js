const express = require("express");
const router = express.Router();
const requireAuth = require("../middleware/auth");
const Employee = require("../models/Employees");
const LeaveYearBalance = require("../models/LeaveYearBalance");
const LeaveTransaction = require("../models/LeaveTransaction");
const { getLeaveYear } = require("../utils/leaveEntitlement");
const leaveYearBalanceController = require("../controllers/leaveYearBalanceController");
const empAuth = require("../middleware/empAuth");

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

// CHANGE THIS: Make day 25 count for NEXT month
function getFiscalMonth(date) {
    const d = new Date(date);
    const day = d.getUTCDate();
    const month = d.getUTCMonth();
    const year = d.getUTCFullYear();


    const months = [
        "January", "February", "March", "April", "May", "June",
        "July", "August", "September", "October", "November", "December"
    ];

    // CHANGE: If day is 25th OR LATER → belongs to NEXT month's fiscal period
    if (day >= 26) {
        if (month === 11) {
            return { month: "January", year: year + 1 };
        } else {
            return { month: months[month + 1], year };
        }
    } else {
        // Day 1-24 → Current month's fiscal period
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
        const totalEntitled = (employee?.leaveEntitlement?.total) + (employee?.leaveEntitlement?.bonus || 0);
        return {
            initialBalance: totalEntitled,
            monthlyBalances: {},
            totalUsedPaid: 0,
            totalUsedUnpaid: 0
        };
    }

    const initialBalance = (leaveBalance.total || 0) + (leaveBalance.bonus || 0);

    // 2. Get current FISCAL month (not calendar month)
    const now = new Date();
    const currentFiscalMonth = getFiscalMonth(now); // Use your fiscal month logic
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
            { type: "PAID_LEAVE_CREDITED" }
        ]
    }).sort({ date: 1 }).lean();

    // 4. Group transactions by fiscal month
    const months = [
        "January", "February", "March", "April", "May", "June",
        "July", "August", "September", "October", "November", "December"
    ];

    // Initialize monthly data
    const monthlyData = {};
    months.forEach(month => {
        monthlyData[month] = {
            paidUsed: 0,
            unpaidUsed: 0,
            bonusAdded: 0
        };
    });

    // 5. Aggregate transactions by fiscal month
    for (const tx of transactions) {
        const fiscalMonth = getFiscalMonth(tx.date);
        const monthName = fiscalMonth.month;

        switch (tx.type) {
            case "PAID_LEAVE_USED":
                monthlyData[monthName].paidUsed += tx.value || 0;
                break;
            case "UNPAID_LEAVE_USED":
                monthlyData[monthName].unpaidUsed += tx.value || 0;
                break;
            case "BONUS_EARNED":
                monthlyData[monthName].bonusAdded += tx.value || 0;
                break;
            case "PAID_LEAVE_REVERSED":
                monthlyData[monthName].paidUsed -= tx.value || 0; // Subtract reversals
                break;
            case "UNPAID_LEAVE_REVERSED":
                monthlyData[monthName].unpaidUsed -= tx.value || 0; // Subtract reversals
                break;
        }
    }

    // 6. Calculate running balance month by month (CLOSING BALANCES)
    const monthlyBalances = {};
    let runningBalance = initialBalance;
    let totalUsedPaid = 0;
    let totalUsedUnpaid = 0;

    // Get month index for comparison
    const monthIndexMap = {};
    months.forEach((month, index) => {
        monthIndexMap[month] = index;
    });

    for (const month of months) {
        const monthData = monthlyData[month];
        totalUsedPaid += monthData.paidUsed;
        totalUsedUnpaid += monthData.unpaidUsed;

        // Check if this month is in the future (using FISCAL months)
        const isFutureMonth = (
            leaveYear > currentYear ||
            (leaveYear === currentYear && monthIndexMap[month] > monthIndexMap[currentMonthName])
        );

        if (isFutureMonth) {
            // Future month → show "-"
            monthlyBalances[month] = {
                balance: "-",
                paidUsed: "-",
                unpaidUsed: "-",
                bonusAdded: "-",
                isFuture: true
            };
        } else {
            // Past or current month → calculate balance
            const balanceBeforeMonth = runningBalance;
            runningBalance = runningBalance - monthData.paidUsed;
            runningBalance += monthData.bonusAdded;

            monthlyBalances[month] = {
                balance: runningBalance, // This is CLOSING balance for the month
                paidUsed: monthData.paidUsed,
                unpaidUsed: monthData.unpaidUsed,
                bonusAdded: monthData.bonusAdded,
                isFuture: false
            };
        }
    }

    return {
        initialBalance,
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

        // 1. Fetch employee
        const employee = await Employee.findById(employeeId);
        if (!employee) {
            return res.status(404).json({ error: "Employee not found" });
        }

        const ownerId = employee.owner;
        const leaveYear = getLeaveYear(new Date(`${year}-${month}-01`));

        // 2. Calculate monthly balances from transactions
        const balanceData = await calculateMonthlyBalances(ownerId, employeeId, leaveYear);
        const monthBalance = balanceData.monthlyBalances[month] || {
            balance: balanceData.initialBalance,
            paidUsed: 0,
            unpaidUsed: 0
        };

        // 3. Get leave balance record for total entitlement
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
        const usedPaidMonth = monthBalance.paidUsed;
        const usedUnpaidMonth = monthBalance.unpaidUsed;
        const balance = monthBalance.balance; // Closing balance for this month

        res.json({
            Annual: {
                total,
                bonus,
                totalWithBonus,
                usedPaidYTD,
                usedUnpaidYTD,
                usedPaidMonth,
                usedUnpaidMonth,
                balance
            }
        });
    } catch (e) {
        console.error("[leave-summary][ERROR]", e);
        res.status(500).json({ error: e.message });
    }
});

// GET /leave-summary-history/:employeeId?year=
router.get("/leave-summary-history/:employeeId", async (req, res) => {
    try {
        const { employeeId } = req.params;
        const { year } = req.query;

        if (!year) {
            return res.status(400).json({ error: "year is required" });
        }

        // 1. Fetch employee
        const employee = await Employee.findById(employeeId);
        if (!employee) {
            return res.status(404).json({ error: "Employee not found" });
        }

        const ownerId = employee.owner;
        const leaveYear = getLeaveYear(new Date(`${year}-01-01`));

        // 2. Calculate monthly balances from transactions
        const balanceData = await calculateMonthlyBalances(ownerId, employeeId, leaveYear);

        const months = [
            "January", "February", "March", "April", "May", "June",
            "July", "August", "September", "October", "November", "December"
        ];

        // 3. Build history array
        const history = months.map(month => {
            const monthData = balanceData.monthlyBalances[month] || {
                balance: "-",
                paidUsed: "-",
                unpaidUsed: "-",
                isFuture: true
            };

            return {
                month,
                usedPaid: monthData.paidUsed,
                usedMonth: monthData.paidUsed,
                balance: monthData.balance,
                unpaidUsed: monthData.unpaidUsed
            };
        });

        res.json({
            total: balanceData.initialBalance,
            initialBalance: balanceData.initialBalance,
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
        if (!employee) {
            return res.status(404).json({ error: "Employee not found" });
        }

        const ownerId = employee.owner;
        const query = {
            owner: ownerId,
            employee: employeeId
        };

        // If year is provided, get leave year
        if (year) {
            const targetYear = getLeaveYear(new Date(`${year}-01-01`));
            const leaveBalance = await LeaveYearBalance.findOne({
                owner: ownerId,
                employee: employeeId,
                year: targetYear
            });

            if (leaveBalance) {
                query.leaveYearBalance = leaveBalance._id;
            }
        }

        // If month is provided, filter by date range
        if (month && year) {
            const { from, to } = getMonthRange(parseInt(year), month);
            query.date = {
                $gte: new Date(from),
                $lte: new Date(to)
            };
        }

        const transactions = await LeaveTransaction.find(query)
            .sort({ date: -1, createdAt: -1 })
            .lean();

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
        if (!employee) {
            return res.status(404).json({ error: "Employee not found" });
        }

        const ownerId = employee.owner;
        const targetDate = date ? new Date(date) : new Date();
        const leaveYear = getLeaveYear(targetDate);

        // Calculate up-to-date balance including transactions
        const balanceData = await calculateMonthlyBalances(ownerId, employeeId, leaveYear);

        // Determine which month's balance to show based on target date
        const fiscalMonth = getFiscalMonth(targetDate);
        const currentMonthBalance = fiscalMonth.year === leaveYear
            ? balanceData.monthlyBalances[fiscalMonth.month]?.balance || balanceData.initialBalance
            : balanceData.initialBalance;

        const leaveBalance = await LeaveYearBalance.findOne({
            owner: ownerId,
            employee: employeeId,
            year: leaveYear
        });

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
        const employees = await Employee.find();

        if (!employees || employees.length === 0) {
            const currentYear = new Date().getFullYear();
            return res.json({ years: [currentYear] });
        }

        const ownerId = employees[0].owner;

        const years = await LeaveYearBalance.distinct("year", {
            owner: ownerId
        });

        const yearList = years
            .filter(y => y !== null && y !== undefined)
            .sort((a, b) => b - a);

        if (yearList.length === 0) {
            const currentYear = new Date().getFullYear();
            return res.json({ years: [currentYear] });
        }

        res.json({ years: yearList });
    } catch (e) {
        console.error("[available-years][ERROR]", e);
        const currentYear = new Date().getFullYear();
        res.json({ years: [currentYear] });
    }
});

router.get(
  "/employee/:employeeId/current",
  empAuth,
  leaveYearBalanceController.getCurrentYearLeaveBalance
);


router.put(
  "/update-balance/:employeeId", requireAuth,
  leaveYearBalanceController.upsertLeaveBalance
);


module.exports = router;