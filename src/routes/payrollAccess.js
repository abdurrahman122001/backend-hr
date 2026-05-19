// backend/src/routes/payrollAccess.js
const express = require('express');
const router = express.Router();
const PayrollAccess = require('../models/PayrollAccess');
const Employee = require('../models/Employees');
const SalarySlip = require('../models/SalarySlip');
const Attendance = require('../models/Attendance');
const LeaveYearBalance = require('../models/LeaveYearBalance');
const LeaveTransaction = require('../models/LeaveTransaction');
const requireAuth = require('../middleware/auth');
const requireEmpAuth = require('../middleware/empAuth');
const Salary = require('../models/Salaries');
const ObjectId = require('mongoose').Types.ObjectId;

function safeIdEquals(a, b) {
    if (!a || !b) return false;
    try {
        return a.toString() === b.toString();
    } catch (e) {
        return false;
    }
}

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

async function findCurrentGrant(employeeId, rawOwnerId) {
    const ownerId = Array.isArray(rawOwnerId) ? rawOwnerId[0] : rawOwnerId;
    const ownerObjectId = (ownerId && ObjectId.isValid(ownerId)) ? new ObjectId(ownerId) : ownerId;
    const grants = await PayrollAccess.find({ owner: ownerObjectId, active: true }).populate('scope', '_id').lean();
    return grants.find(g => safeIdEquals(g.grantedTo, employeeId));
}

// ─────────────────────────────────────────────────────────────
// ADMIN ROUTES (HR portal — uses admin auth middleware)
// ─────────────────────────────────────────────────────────────

/**
 * GET /api/payroll-access
 * List all payroll access grants for the current owner
 */
router.get('/', requireAuth, async (req, res) => {
    try {
        const ownerId = req.user.owner || req.user._id;
        const grants = await PayrollAccess.find({ owner: ownerId })
            .populate('grantedTo', 'name companyEmail designation department')
            .populate('scope', 'name companyEmail designation department')
            .sort({ createdAt: -1 })
            .lean();
        res.json(grants);
    } catch (err) {
        console.error('[PAYROLL-ACCESS] GET error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * POST /api/payroll-access
 * Grant or update payroll access for an employee
 * Body: { grantedTo, accessType: 'view'|'edit', scope?: [empId, ...], notes? }
 */
router.post('/', requireAuth, async (req, res) => {
    try {
        const ownerId = req.user.owner || req.user._id;
        const { grantedTo, accessType, scope, notes } = req.body;

        console.log('[PAYROLL-ACCESS] POST - Granting access:', {
            ownerId: ownerId.toString(),
            grantedTo,
            accessType,
            scopeCount: scope ? scope.length : 0,
        });

        if (!grantedTo || !['view', 'edit'].includes(accessType)) {
            return res.status(400).json({ error: 'grantedTo and valid accessType (view|edit) are required.' });
        }

        const grant = await PayrollAccess.findOneAndUpdate(
            { owner: ownerId, grantedTo },
            {
                $set: {
                    owner: ownerId,
                    grantedTo,
                    accessType,
                    scope: scope || [],
                    notes: notes || '',
                    grantedBy: req.user._id,
                    active: true,
                },
            },
            { upsert: true, new: true, setDefaultsOnInsert: true }
        );

        console.log('[PAYROLL-ACCESS] Grant created/updated:', {
            grantId: grant._id.toString(),
            active: grant.active,
            accessType: grant.accessType,
        });

        const populated = await PayrollAccess.findById(grant._id)
            .populate('grantedTo', 'name companyEmail designation department')
            .populate('scope', 'name companyEmail designation department')
            .lean();

        res.json({ message: 'Payroll access granted successfully.', grant: populated });
    } catch (err) {
        console.error('[PAYROLL-ACCESS] POST error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * PATCH /api/payroll-access/:id
 * Update an existing grant (e.g., change accessType or scope)
 */
router.patch('/:id', requireAuth, async (req, res) => {
    try {
        const ownerId = req.user.owner || req.user._id;
        const { accessType, scope, notes, active } = req.body;

        const update = {};
        if (accessType !== undefined) update.accessType = accessType;
        if (scope !== undefined) update.scope = scope;
        if (notes !== undefined) update.notes = notes;
        if (active !== undefined) update.active = active;

        const grant = await PayrollAccess.findOneAndUpdate(
            { _id: req.params.id, owner: ownerId },
            { $set: update },
            { new: true }
        )
            .populate('grantedTo', 'name companyEmail designation department')
            .populate('scope', 'name companyEmail designation department');

        if (!grant) return res.status(404).json({ error: 'Grant not found.' });
        res.json({ message: 'Payroll access updated.', grant });
    } catch (err) {
        console.error('[PAYROLL-ACCESS] PATCH error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * DELETE /api/payroll-access/:id
 * Revoke payroll access
 */
router.delete('/:id', requireAuth, async (req, res) => {
    try {
        const ownerId = req.user.owner || req.user._id;
        const deleted = await PayrollAccess.findOneAndDelete({
            _id: req.params.id,
            owner: ownerId,
        });
        if (!deleted) return res.status(404).json({ error: 'Grant not found.' });
        res.json({ message: 'Payroll access revoked.' });
    } catch (err) {
        console.error('[PAYROLL-ACCESS] DELETE error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ─────────────────────────────────────────────────────────────
// EMPLOYEE ROUTES (Employee portal — uses emp auth middleware)
// ─────────────────────────────────────────────────────────────

/**
 * GET /api/payroll-access/my-access
 * Called by employee dashboard to check if this employee has payroll access
 */
router.get('/my-access', requireEmpAuth, async (req, res) => {
    try {
        const employeeId = req.employee._id;
        const rawOwnerId = req.employee.owner;
        const ownerId = Array.isArray(rawOwnerId) ? rawOwnerId[0] : rawOwnerId;

        console.log('[PAYROLL-ACCESS] my-access check:', {
            employeeId: employeeId.toString(),
            ownerId: ownerId.toString(),
        });

        // Fetch all active grants for the owner and then match in JS to avoid ObjectId/string mismatches
        const ownerObjectId = (ownerId && ObjectId.isValid(ownerId)) ? new ObjectId(ownerId) : ownerId;
        const grants = await PayrollAccess.find({ owner: ownerObjectId, active: true })
            .populate('scope', 'name companyEmail designation department')
            .lean();

        const grant = grants.find(g => safeIdEquals(g.grantedTo, employeeId));

        if (!grant) {
            console.log('[PAYROLL-ACCESS] No active grant found. Available grants count:', grants.length);
            console.log('[PAYROLL-ACCESS] Looking for employeeId:', employeeId.toString ? employeeId.toString() : employeeId);
            grants.forEach((g, idx) => {
                const grantedToStr = g.grantedTo && g.grantedTo.toString ? g.grantedTo.toString() : String(g.grantedTo);
                const matches = safeIdEquals(g.grantedTo, employeeId);
                console.log(`[PAYROLL-ACCESS] Grant ${idx}:`, {
                    grantedTo: grantedToStr,
                    employeeIdMatch: matches,
                    active: g.active,
                    accessType: g.accessType,
                });
            });
            return res.json({ hasAccess: false });
        }

        console.log('[PAYROLL-ACCESS] Grant matched:', {
            accessType: grant.accessType,
            hasScope: grant.scope && grant.scope.length > 0,
            scopeCount: grant.scope ? grant.scope.length : 0,
        });

        res.json({ hasAccess: true, accessType: grant.accessType, scope: grant.scope || [], notes: grant.notes });
    } catch (err) {
        console.error('[PAYROLL-ACCESS] my-access error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * GET /api/payroll-access/my-access-debug
 * Debug helper for troubleshooting token/grant mismatches
 */
router.get('/my-access-debug', requireEmpAuth, async (req, res) => {
    try {
        const employeeId = req.employee._id;
        const ownerId = req.employee.owner;

        console.log('[PAYROLL-ACCESS-DBG] my-access-debug called:', { employeeId: employeeId.toString(), ownerId: ownerId.toString() });

        const grants = await PayrollAccess.find({ owner: ownerId }).lean();

        const grantSummary = grants.map(g => ({
            _id: g._id,
            grantedTo: g.grantedTo && g.grantedTo.toString ? g.grantedTo.toString() : g.grantedTo,
            accessType: g.accessType,
            active: g.active,
            scopeCount: g.scope ? g.scope.length : 0,
            matchesStrict: g.grantedTo && g.grantedTo.toString ? (g.grantedTo.toString() === employeeId.toString()) : (g.grantedTo === employeeId),
            matchesLoose: String(g.grantedTo) === String(employeeId),
        }));

        return res.json({
            employeeId: employeeId.toString(),
            ownerId: ownerId.toString(),
            grantsCount: grants.length,
            grants: grantSummary,
        });
    } catch (err) {
        console.error('[PAYROLL-ACCESS-DBG] error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * GET /api/payroll-access/my-salary-slips
 * Fetch salary slips based on payroll access level
 * - If employee has payroll access grant, fetch ALL employees' slips (or scoped subset)
 * - Otherwise, return 403 (no access)
 * Fetches from both SalarySlip and Salary models
 */
router.get('/my-salary-slips', requireEmpAuth, async (req, res) => {
    try {
        const employeeId = req.employee._id.toString();
        const rawOwnerId = req.employee.owner;
        const ownerId = Array.isArray(rawOwnerId) ? rawOwnerId[0] : rawOwnerId;

        console.log('[PAYROLL-ACCESS] my-salary-slips request:', {
            employeeId,
            ownerId,
        });

        // Check if requester has payroll access
        // Fetch active grants for the owner and match by id string to avoid type mismatch issues
        const ownerObjectId = (ownerId && ObjectId.isValid(ownerId)) ? new ObjectId(ownerId) : ownerId;
        const grants = await PayrollAccess.find({ owner: ownerObjectId, active: true }).populate('scope', '_id').lean();
        const grant = grants.find(g => safeIdEquals(g.grantedTo, employeeId));

        if (!grant) {
            console.log('[PAYROLL-ACCESS] No payroll access grant found for employee:', employeeId);
            return res.status(403).json({ error: 'No payroll access' });
        }

            console.log('[PAYROLL-ACCESS] Access grant resolved:', { grantId: grant._id, accessType: grant.accessType });

        // reuse ownerObjectId computed above

        // Build employee filter based on scope
        let employeeFilter = {};
        
        if (grant.scope && grant.scope.length > 0) {
            // Scope is restricted to specific employees
            const scopeIds = grant.scope.map((emp) => {
                try {
                    return new ObjectId(emp._id || emp);
                } catch (e) {
                    return emp._id || emp;
                }
            });
            employeeFilter = { $in: scopeIds };
            console.log('[PAYROLL-ACCESS] Using scoped access for employees:', scopeIds);
        } else {
            // Empty scope = access to all employees
            console.log('[PAYROLL-ACCESS] Using unrestricted access (all employees)');
            employeeFilter = { $ne: null }; // Match any employee
        }

        // Fetch salary slips for all employees (or scoped subset)
        let salaryData = await SalarySlip.find({
            owner: ownerObjectId,
            employee: employeeFilter,
        })
            .populate('employee', 'name companyEmail designation department')
            .sort({ 'year': -1, 'month': -1 })
            .lean();

        console.log('[PAYROLL-ACCESS] Found salary slips:', salaryData.length);

        // If no slips found in SalarySlip, try Salary model
        if (salaryData.length === 0) {
            console.log('[PAYROLL-ACCESS] No salary slips found, checking Salary model');
            
            const salaryRecords = await Salary.find({
                owner: ownerObjectId,
                employee: employeeFilter,
            })
                .populate('employee', 'name companyEmail designation department')
                .sort({ createdAt: -1 })
                .lean();

            if (salaryRecords && salaryRecords.length > 0) {
                salaryData = salaryRecords.map(rec => ({
                    ...rec,
                    month: rec.month || new Date().toISOString(),
                    status: rec.status || 'draft',
                    payrollPeriod: rec.payrollPeriod || null,
                }));
                console.log('[PAYROLL-ACCESS] Found salary records:', salaryData.length);
            }
        }

        res.json({
            salarySlips: salaryData || [],
            accessType: grant.accessType,  // 'view' or 'edit'
            scope: grant.scope && grant.scope.length > 0 ? 'restricted' : 'all', // Show scope type
        });
    } catch (err) {
        console.error('[PAYROLL-ACCESS] my-salary-slips error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * GET /api/payroll-access/debug-slips/:employeeId
 * DEBUG endpoint to check what salary slips exist for an employee
 */
router.get('/debug-slips/:employeeId', requireAuth, async (req, res) => {
    try {
        const { employeeId } = req.params;
        const ownerId = req.user.owner || req.user._id;

        console.log('[DEBUG-SLIPS] Checking slips for employee:', { employeeId, ownerId });

        const empObjectId = new ObjectId(employeeId);
        const ownerObjectId = new ObjectId(ownerId);
        
        // Check total count
        const totalCount = await SalarySlip.countDocuments({});
        const ownerCount = await SalarySlip.countDocuments({ owner: ownerObjectId });
        const empCount = await SalarySlip.countDocuments({ employee: empObjectId });
        const bothCount = await SalarySlip.countDocuments({ owner: ownerObjectId, employee: empObjectId });
        
        // Get the actual slips for this employee
        const slips = await SalarySlip.find({ owner: ownerObjectId, employee: empObjectId })
            .populate('employee', 'name companyEmail')
            .sort({ year: -1, month: -1 })
            .lean();

        res.json({
            counts: {
                totalSlipsInDB: totalCount,
                slipsForOwner: ownerCount,
                slipsForEmployee: empCount,
                slipsForBoth: bothCount
            },
            slips: slips.map(s => ({
                _id: s._id,
                month: s.month,
                year: s.year,
                employeeName: s.employee?.name,
                status: s.isLocked ? 'locked' : 'draft',
                createdAt: s.createdAt
            }))
        });
    } catch (err) {
        console.error('[DEBUG-SLIPS] error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});


router.get('/salary-slips/:employeeId', requireEmpAuth, async (req, res) => {
    try {
        const { employeeId } = req.params;
        const requesterId = req.employee._id;
        const ownerId = req.employee.owner;

        // First check if requester has payroll access
        // Resolve grant robustly by fetching active grants for owner and matching in JS
        const ownerObjectId = (ownerId && ObjectId.isValid(ownerId)) ? new ObjectId(ownerId) : ownerId;
        const grants = await PayrollAccess.find({ owner: ownerObjectId, active: true }).lean();
        const grant = grants.find(g => safeIdEquals(g.grantedTo, requesterId));

        if (!grant) return res.status(403).json({ error: 'No payroll access' });

        // Check scope: if scope is empty, they can view all employees
        const scopeList = grant.scope || [];
        const canViewEmployee = scopeList.length === 0 || scopeList.some(s => safeIdEquals(s, employeeId));

        if (!canViewEmployee && requesterId.toString() !== employeeId) {
            return res.status(403).json({ error: 'No access to this employee payroll' });
        }

        // Fetch salary slips for the target employee
        const salarySlips = await SalarySlip.find({
            owner: ownerId,
            employee: employeeId,
        })
            .populate('employee', 'name companyEmail designation department')
            .sort({ createdAt: -1 })
            .lean();

        res.json({
            salarySlips: salarySlips || [],
            accessType: grant.accessType,  // 'view' or 'edit'
        });
    } catch (err) {
        console.error('[PAYROLL-ACCESS] salary-slips error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});


/**
 * GET /api/payroll-access/attendance-range?from=YYYY-MM-DD&to=YYYY-MM-DD
 * Fetch attendance records for all employees within payroll scope for a date range.
 * Allows employee-portal payroll access users to run full calculations like the admin dashboard.
 */
router.get('/attendance-range', requireEmpAuth, async (req, res) => {
    try {
        const employeeId = req.employee._id;
        const rawOwnerId = req.employee.owner;
        const ownerId = Array.isArray(rawOwnerId) ? rawOwnerId[0] : rawOwnerId;
        const { from, to } = req.query;

        if (!from || !to) {
            return res.status(400).json({ error: 'from and to query params are required (YYYY-MM-DD)' });
        }

        const ownerObjectId = (ownerId && ObjectId.isValid(ownerId)) ? new ObjectId(ownerId) : ownerId;
        const grants = await PayrollAccess.find({ owner: ownerObjectId, active: true }).populate('scope', '_id').lean();
        const grant = grants.find(g => safeIdEquals(g.grantedTo, employeeId));

        if (!grant) {
            return res.status(403).json({ error: 'No payroll access' });
        }
        const query = { owner: ownerObjectId, date: { $gte: from, $lte: to } };

        if (grant.scope && grant.scope.length > 0) {
            const scopeIds = grant.scope.map(emp => {
                try { return new ObjectId(emp._id || emp); } catch (e) { return emp._id || emp; }
            });
            query.employee = { $in: scopeIds };
        }

        const records = await Attendance.find(query).lean();
        res.json(records);
    } catch (err) {
        console.error('[PAYROLL-ACCESS] attendance-range error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * GET /api/payroll-access/leave-summary-batch?month=April&year=2026
 * Fetch leave balances + current-month usage for all employees within payroll scope.
 * Returns: { leaveMap: { [empId]: { Annual: { remainingPaid, usedPaidMonth, total, bonus } } } }
 */
router.get('/leave-summary-batch', requireEmpAuth, async (req, res) => {
    try {
        const employeeId = req.employee._id;
        const rawOwnerId = req.employee.owner;
        const ownerId = Array.isArray(rawOwnerId) ? rawOwnerId[0] : rawOwnerId;
        const { month, year } = req.query;

        if (!month || !year) {
            return res.status(400).json({ error: 'month and year are required' });
        }

        const ownerObjectId = (ownerId && ObjectId.isValid(ownerId)) ? new ObjectId(ownerId) : ownerId;
        const grants = await PayrollAccess.find({ owner: ownerObjectId, active: true }).populate('scope', '_id').lean();
        const grant = grants.find(g => safeIdEquals(g.grantedTo, employeeId));

        if (!grant) {
            return res.status(403).json({ error: 'No payroll access' });
        }

        const yearNum = Number(year);
        const months = ["January","February","March","April","May","June","July","August","September","October","November","December"];
        const monthIndex = months.indexOf(month);

        // Fiscal month range: 26th of previous month → 25th of current month
        const prevMonthIndex = monthIndex === 0 ? 11 : monthIndex - 1;
        const prevYear = monthIndex === 0 ? yearNum - 1 : yearNum;
        const from = monthIndex === 0
            ? `${yearNum}-01-01`
            : `${prevYear}-${String(prevMonthIndex + 1).padStart(2, '0')}-26`;
        const to = `${yearNum}-${String(monthIndex + 1).padStart(2, '0')}-25`;

        const leaveBalanceQuery = { owner: ownerObjectId, year: yearNum };
        if (grant.scope && grant.scope.length > 0) {
            const scopeIds = grant.scope.map(emp => {
                try { return new ObjectId(emp._id || emp); } catch (e) { return emp._id || emp; }
            });
            leaveBalanceQuery.employee = { $in: scopeIds };
        }

        const leaveBalances = await LeaveYearBalance.find(leaveBalanceQuery).lean();
        const leaveBalanceIds = leaveBalances.map(lb => lb._id);

        // Batch fetch month transactions for all employees in one query
        const monthTxns = await LeaveTransaction.find({
            owner: ownerObjectId,
            leaveYearBalance: { $in: leaveBalanceIds },
            type: { $in: ['PAID_LEAVE_USED', 'PAID_LEAVE_REVERSED'] },
            date: { $gte: new Date(from), $lte: new Date(to + 'T23:59:59.999Z') }
        }).lean();

        const leaveMap = {};
        for (const lb of leaveBalances) {
            const empId = String(lb.employee);
            const lbId = String(lb._id);
            const empTxns = monthTxns.filter(tx => String(tx.leaveYearBalance) === lbId);

            let usedPaidMonth = 0;
            empTxns.forEach(tx => {
                if (tx.type === 'PAID_LEAVE_USED') usedPaidMonth += tx.value || 0;
                if (tx.type === 'PAID_LEAVE_REVERSED') usedPaidMonth -= tx.value || 0;
            });

            leaveMap[empId] = {
                Annual: {
                    total: lb.total || 0,
                    bonus: lb.bonus || 0,
                    remainingPaid: lb.remainingPaid || 0,
                    usedPaidMonth
                }
            };
        }

        res.json({ leaveMap });
    } catch (err) {
        console.error('[PAYROLL-ACCESS] leave-summary-batch error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * GET /api/payroll-access/leave-summary/:employeeId?month=&year=
 * Fetch individual leave summary (mirrors admin logic) but for payroll access users.
 */
router.get('/leave-summary/:targetId', requireEmpAuth, async (req, res) => {
    try {
        const { targetId } = req.params;
        const { month, year } = req.query;
        const requesterId = req.employee._id;
        const rawOwnerId = req.employee.owner;
        const ownerId = Array.isArray(rawOwnerId) ? rawOwnerId[0] : rawOwnerId;

        if (!month || !year) return res.status(400).json({ error: 'month and year are required' });

        const grant = await findCurrentGrant(requesterId, ownerId);
        if (!grant) return res.status(403).json({ error: 'No payroll access' });

        // Check scope
        const scopeIds = (grant.scope || []).map(s => String(s._id || s));
        const canAccess = scopeIds.length === 0 || scopeIds.includes(String(targetId));
        if (!canAccess && String(targetId) !== String(requesterId)) {
            return res.status(403).json({ error: 'No access to this employee' });
        }

        // Use the full calculation logic from the internal helper below

        const balanceData = await calculateMonthlySummaryInternal(ownerId, targetId, Number(year));
        const monthBalance = balanceData.monthlyBalances[month] || { balance: balanceData.initialBalance, paidUsed: 0, unpaidUsed: 0 };

        const leaveBalance = await LeaveYearBalance.findOne({ owner: ownerId, employee: targetId, year: Number(year) });
        const total = leaveBalance?.total || 0;
        const bonus = leaveBalance?.bonus || 0;
        
        res.json({
            Annual: {
                total,
                bonus,
                totalWithBonus: total + bonus,
                usedPaidYTD: balanceData.totalUsedPaid,
                usedUnpaidYTD: balanceData.totalUsedUnpaid,
                usedPaidMonth: monthBalance.paidUsed || 0,
                usedUnpaidMonth: monthBalance.unpaidUsed || 0,
                balance: monthBalance.balance,
                remainingPaid: leaveBalance?.remainingPaid || 0
            }
        });
    } catch (err) {
        console.error('[PAYROLL-ACCESS] leave-summary error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Internal helper for leave summary (replicated from attendanceLeaveSummary.js logic)
async function calculateMonthlySummaryInternal(ownerId, employeeId, leaveYear) {
    const leaveBalance = await LeaveYearBalance.findOne({ owner: ownerId, employee: employeeId, year: leaveYear });
    if (!leaveBalance) {
        // Fallback for missing balance record
        const employee = await Employee.findById(employeeId).lean();
        const profileYear = employee?.leaveEntitlement?.bonusYear;
        let totalEntitled = 0;
        if (profileYear === leaveYear) {
            totalEntitled = employee?.leaveEntitlement?.total || 0;
        }
        return { initialBalance: totalEntitled, monthlyBalances: {}, totalUsedPaid: 0, totalUsedUnpaid: 0, finalBalance: totalEntitled };
    }

    const transactions = await LeaveTransaction.find({
        owner: ownerId,
        employee: employeeId,
        leaveYearBalance: leaveBalance._id,
        type: { $in: ["PAID_LEAVE_USED", "UNPAID_LEAVE_USED", "BONUS_EARNED", "PAID_LEAVE_REVERSED", "UNPAID_LEAVE_REVERSED", "PAID_LEAVE_CREDITED", "ADJUSTMENT"] }
    }).sort({ date: 1 }).lean();

    const months = ["January","February","March","April","May","June","July","August","September","October","November","December"];
    const monthlyData = {};
    months.forEach(m => { monthlyData[m] = { paidUsed: 0, unpaidUsed: 0, bonusAdded: 0, credited: 0 }; });

    for (const tx of transactions) {
        const d = new Date(tx.date);
        const day = d.getUTCDate();
        const month = d.getUTCMonth();
        
        let mName;
        if (day >= 26) {
            if (month === 11) mName = "January";
            else mName = months[month + 1];
        } else {
            mName = months[month];
        }

        if (!monthlyData[mName]) continue;
        if (tx.type === "PAID_LEAVE_USED") monthlyData[mName].paidUsed += tx.value || 0;
        if (tx.type === "PAID_LEAVE_REVERSED") monthlyData[mName].paidUsed -= tx.value || 0;
        if (tx.type === "UNPAID_LEAVE_USED") monthlyData[mName].unpaidUsed += tx.value || 0;
        if (tx.type === "UNPAID_LEAVE_REVERSED") monthlyData[mName].unpaidUsed -= tx.value || 0;
        if (tx.type === "BONUS_EARNED" || tx.type === "ADJUSTMENT") monthlyData[mName].bonusAdded += tx.value || 0;
        if (tx.type === "PAID_LEAVE_CREDITED") monthlyData[mName].credited += tx.value || 0;
    }

    let runningBalance = leaveBalance.total || 0;
    let totalUsedPaid = 0;
    let totalUsedUnpaid = 0;
    const monthlyBalances = {};

    for (const m of months) {
        const md = monthlyData[m];
        totalUsedPaid += md.paidUsed;
        totalUsedUnpaid += md.unpaidUsed;
        
        // balance = prev_balance + credits - used + bonus
        runningBalance = runningBalance + (md.credited || 0) - md.paidUsed + md.bonusAdded;
        monthlyBalances[m] = { balance: runningBalance, paidUsed: md.paidUsed, unpaidUsed: md.unpaidUsed };
    }

    return { initialBalance: leaveBalance.total || 0, monthlyBalances, totalUsedPaid, totalUsedUnpaid, finalBalance: runningBalance };
}

/**
 * GET /api/payroll-access/locked-salary-slips
 * Fetch locked salary slips for the current employee for the past payroll month.
 * Employees can view their own locked slips from the previous month.
 * Returns only display data (not encrypted fields).
 */
router.get('/locked-salary-slips', requireEmpAuth, async (req, res) => {
    try {
        const employeeId = req.employee._id;
        const ownerId = req.employee.owner;

        console.log('[PAYROLL-ACCESS] locked-salary-slips request:', {
            employeeId: employeeId.toString(),
            ownerId: ownerId.toString(),
        });

        const ownerObjectId = (ownerId && ObjectId.isValid(ownerId)) ? new ObjectId(ownerId) : ownerId;

        // Calculate past month (fiscal month: 26th to 25th)
        const now = new Date();
        let pastMonth, pastYear;

        // If today is between 1st-25th, use previous calendar month
        // If today is between 26th-31st, use current calendar month
        if (now.getDate() < 26) {
            // Go back one month
            const prevDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
            pastMonth = prevDate.toLocaleString('en-US', { month: 'long' });
            pastYear = prevDate.getFullYear().toString();
        } else {
            // Use current month
            pastMonth = now.toLocaleString('en-US', { month: 'long' });
            pastYear = now.getFullYear().toString();
        }

        console.log('[PAYROLL-ACCESS] Fetching locked slips for past month:', { pastMonth, pastYear });

        // Fetch locked salary slips for this employee for the past month
        const lockedSlips = await SalarySlip.find({
            owner: ownerObjectId,
            employee: employeeId,
            month: pastMonth,
            year: pastYear,
            isLocked: true,
        })
            .populate('employee', 'name designation department companyEmail joiningDate')
            .lean();

        console.log('[PAYROLL-ACCESS] Found locked slips:', lockedSlips.length);

        // Return only necessary display data (not encrypted fields)
        const displaySlips = lockedSlips.map(slip => ({
            _id: slip._id,
            month: slip.month,
            year: slip.year,
            isLocked: true,
            employee: slip.employee,
            createdAt: slip.createdAt,
            updatedAt: slip.updatedAt,
            // Include summary fields for display (non-encrypted)
            // These will be decrypted on frontend if needed
            grossSalary: slip.grossSalary,
            totalDeductions: slip.totalDeductions,
            netPayable: slip.netPayable,
            // Include all encrypted fields for decryption on frontend
            basic: slip.basic,
            dearnessAllowance: slip.dearnessAllowance,
            houseRentAllowance: slip.houseRentAllowance,
            conveyanceAllowance: slip.conveyanceAllowance,
            medicalAllowance: slip.medicalAllowance,
            utilityAllowance: slip.utilityAllowance,
            autoAllowance: slip.autoAllowance,
            fuelAllowance: slip.fuelAllowance,
            dislocationAllowance: slip.dislocationAllowance,
            overtimeCompensation: slip.overtimeCompensation,
            leaveEncashment: slip.leaveEncashment,
            bonus: slip.bonus,
            arrears: slip.arrears,
            incentive: slip.incentive,
            othersAllowances: slip.othersAllowances,
            loanBenefits: slip.loanBenefits,
            eobiDeduction: slip.eobiDeduction,
            sessiDeduction: slip.sessiDeduction,
            providentFundDeduction: slip.providentFundDeduction,
            gratuityFundDeduction: slip.gratuityFundDeduction,
            taxDeduction: slip.taxDeduction,
            leaveDeductions: slip.leaveDeductions,
            lateDeductions: slip.lateDeductions,
            advanceSalaryDeductions: slip.advanceSalaryDeductions,
            vehicleLoanDeduction: slip.vehicleLoanDeduction,
            otherLoanDeductions: slip.otherLoanDeductions,
            medicalInsurance: slip.medicalInsurance,
            lifeInsurance: slip.lifeInsurance,
            penalties: slip.penalties,
            othersDeductions: slip.othersDeductions,
            totalAllowances: slip.totalAllowances,
        }));

        res.json({
            lockedSlips: displaySlips,
            pastMonth,
            pastYear,
            hasLockedSlips: displaySlips.length > 0,
        });
    } catch (err) {
        console.error('[PAYROLL-ACCESS] locked-salary-slips error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

module.exports = router;

