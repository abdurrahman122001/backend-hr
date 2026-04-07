// backend/src/routes/payrollAccess.js
const express = require('express');
const router = express.Router();
const PayrollAccess = require('../models/PayrollAccess');
const Employee = require('../models/Employees');
const requireAuth = require('../middleware/auth');
const requireEmpAuth = require('../middleware/empAuth');
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
        const ownerId = req.employee.owner;

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
        const ownerId = req.employee.owner.toString();

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

        const SalarySlip = require('../models/SalarySlip');
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
            const Salary = require('../models/Salaries');
            
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

        const ObjectId = require('mongoose').Types.ObjectId;
        const empObjectId = new ObjectId(employeeId);
        const ownerObjectId = new ObjectId(ownerId);

        const SalarySlip = require('../models/SalarySlip');
        
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
        const SalarySlip = require('../models/SalarySlip');
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

module.exports = router;
