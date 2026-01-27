// helpers/leaveSummary.js

const Attendance = require("../models/Attendance");
const Employee = require("../models/Employees");
const ProbationPeriod = require("../models/ProbationPeriod");
const LeaveYearBalance = require("../models/LeaveYearBalance");
const LeaveTransaction = require("../models/LeaveTransaction");

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
    const fromPaidAbsent = paidAbsents;

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

// Get fiscal month for a date (26th to 25th rule)
// Day 1-25 = current calendar month's fiscal period
// Day 26-31 = next month's fiscal period
function getFiscalMonth(date) {
    const d = new Date(date);
    const day = d.getUTCDate();
    const month = d.getUTCMonth();
    const year = d.getUTCFullYear();

    const months = [
        "January", "February", "March", "April", "May", "June",
        "July", "August", "September", "October", "November", "December"
    ];

    // If day is 26th or later → belongs to NEXT month's fiscal period
    if (day >= 26) {
        if (month === 11) {
            return { month: "January", year: year + 1 };
        } else {
            return { month: months[month + 1], year };
        }
    } else {
        // Day 1-25 → Current month's fiscal period
        return { month: months[month], year };
    }
}

// Calculate monthly balances from LeaveTransaction records
// This mirrors the logic in attendanceLeaveSummary.js router
async function calculateMonthlyBalancesFromTransactions(ownerId, employeeId, leaveYear) {
    // 1. Get leave balance for the year
    const leaveBalance = await LeaveYearBalance.findOne({
        owner: ownerId,
        employee: employeeId,
        year: leaveYear
    });

    if (!leaveBalance) {
        const employee = await Employee.findById(employeeId).lean();
        const totalEntitled = employee?.leaveEntitlement?.total || 0;
        return {
            initialBalance: totalEntitled,
            bonus: 0,
            monthlyBalances: {},
            totalUsedPaid: 0,
            totalUsedUnpaid: 0
        };
    }

    const initialBalance = leaveBalance.total || 0;
    const bonus = leaveBalance.bonus || 0;

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
                monthlyData[monthName].paidUsed -= tx.value || 0;
                break;
            case "UNPAID_LEAVE_REVERSED":
                monthlyData[monthName].unpaidUsed -= tx.value || 0;
                break;
        }
    }

    // 6. Calculate running balance month by month
    const monthlyBalances = {};
    let runningBalance = initialBalance;
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

        // Check if this month is in the future
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
                isFuture: true
            };
        } else {
            runningBalance = runningBalance - monthData.paidUsed;
            runningBalance += monthData.bonusAdded;

            monthlyBalances[month] = {
                balance: runningBalance,
                paidUsed: monthData.paidUsed,
                unpaidUsed: monthData.unpaidUsed,
                bonusAdded: monthData.bonusAdded,
                isFuture: false
            };
        }
    }

    return {
        initialBalance,
        bonus,
        monthlyBalances,
        totalUsedPaid,
        totalUsedUnpaid,
        finalBalance: runningBalance
    };
}

// Calculate YTD and monthly leave using LeaveTransaction records
// This is the function used by the email slip to get correct values
async function calculateYTDLeaveFromTransactions(employeeId, year, month) {
    // 1. Fetch employee to get owner
    const employee = await Employee.findById(employeeId);
    if (!employee) {
        return { ytdUsed: 0, monthUsed: 0, balance: 0, entitled: 0, bonus: 0 };
    }

    const ownerId = employee.owner;
    const leaveYear = Number(year);

    // 2. Get leave balance record
    const leaveBalance = await LeaveYearBalance.findOne({
        owner: ownerId,
        employee: employeeId,
        year: leaveYear
    });

    const entitled = leaveBalance?.total || employee.leaveEntitlement?.total || 0;
    const bonus = leaveBalance?.bonus || 0;

    // 3. Calculate monthly balances
    const balanceData = await calculateMonthlyBalancesFromTransactions(ownerId, employeeId, leaveYear);

    // 4. Get data for the specific month
    const monthData = balanceData.monthlyBalances[month];
    
    if (!monthData || monthData.isFuture) {
        return {
            ytdUsed: 0,
            monthUsed: 0,
            balance: entitled,
            entitled,
            bonus
        };
    }

    // 5. Calculate YTD used up to and including this month
    const months = [
        "January", "February", "March", "April", "May", "June",
        "July", "August", "September", "October", "November", "December"
    ];
    const monthIndex = months.indexOf(month);
    
    let ytdUsed = 0;
    for (let i = 0; i <= monthIndex; i++) {
        const mData = balanceData.monthlyBalances[months[i]];
        if (mData && !mData.isFuture && typeof mData.paidUsed === 'number') {
            ytdUsed += mData.paidUsed;
        }
    }

    return {
        ytdUsed,
        monthUsed: typeof monthData.paidUsed === 'number' ? monthData.paidUsed : 0,
        balance: typeof monthData.balance === 'number' ? monthData.balance : entitled,
        entitled,
        bonus
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
    calculateLeaveSummaryHistory,
    getFiscalMonth,
    calculateMonthlyBalancesFromTransactions,
    calculateYTDLeaveFromTransactions
};
