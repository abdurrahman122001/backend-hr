// backend/src/routes/attendanceAccess.js
const express = require('express');
const router = express.Router();
const AttendanceAccess = require('../models/AttendanceAccess');
const Employee = require('../models/Employees');
const requireAuth = require('../middleware/auth');
const requireEmpAuth = require('../middleware/empAuth');

// ─────────────────────────────────────────────────────────────
// ADMIN ROUTES (HR portal — uses admin auth middleware)
// ─────────────────────────────────────────────────────────────

/**
 * GET /api/attendance-access
 * List all access grants for the current owner
 */
router.get('/', requireAuth, async (req, res) => {
    try {
        const ownerId = req.user.owner || req.user._id;
        const grants = await AttendanceAccess.find({ owner: ownerId })
            .populate('grantedTo', 'name companyEmail designation department')
            .populate('scope', 'name companyEmail designation department')
            .sort({ createdAt: -1 })
            .lean();
        res.json(grants);
    } catch (err) {
        console.error('[ATTENDANCE-ACCESS] GET error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * POST /api/attendance-access
 * Grant or update attendance access for an employee
 * Body: { grantedTo, accessType: 'view'|'edit', scope?: [empId, ...], notes? }
 */
router.post('/', requireAuth, async (req, res) => {
    try {
        const ownerId = req.user.owner || req.user._id;
        const { grantedTo, accessType, scope, notes } = req.body;

        if (!grantedTo || !['view', 'edit'].includes(accessType)) {
            return res.status(400).json({ error: 'grantedTo and valid accessType (view|edit) are required.' });
        }

        const grant = await AttendanceAccess.findOneAndUpdate(
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

        const populated = await AttendanceAccess.findById(grant._id)
            .populate('grantedTo', 'name companyEmail designation department')
            .populate('scope', 'name companyEmail designation department')
            .lean();

        res.json({ message: 'Access granted successfully.', grant: populated });
    } catch (err) {
        console.error('[ATTENDANCE-ACCESS] POST error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * PATCH /api/attendance-access/:id
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

        const grant = await AttendanceAccess.findOneAndUpdate(
            { _id: req.params.id, owner: ownerId },
            { $set: update },
            { new: true }
        )
            .populate('grantedTo', 'name companyEmail designation department')
            .populate('scope', 'name companyEmail designation department');

        if (!grant) return res.status(404).json({ error: 'Grant not found.' });
        res.json({ message: 'Access updated.', grant });
    } catch (err) {
        console.error('[ATTENDANCE-ACCESS] PATCH error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * DELETE /api/attendance-access/:id
 * Revoke attendance access
 */
router.delete('/:id', requireAuth, async (req, res) => {
    try {
        const ownerId = req.user.owner || req.user._id;
        const deleted = await AttendanceAccess.findOneAndDelete({
            _id: req.params.id,
            owner: ownerId,
        });
        if (!deleted) return res.status(404).json({ error: 'Grant not found.' });
        res.json({ message: 'Access revoked.' });
    } catch (err) {
        console.error('[ATTENDANCE-ACCESS] DELETE error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ─────────────────────────────────────────────────────────────
// EMPLOYEE ROUTES (Employee portal — uses emp auth middleware)
// ─────────────────────────────────────────────────────────────

/**
 * GET /api/attendance-access/my-access
 * Called by employee dashboard to check if this employee has attendance access
 */
router.get('/my-access', requireEmpAuth, async (req, res) => {
    try {
        const employeeId = req.employee._id;
        const ownerId = req.employee.owner;

        const grant = await AttendanceAccess.findOne({
            owner: ownerId,
            grantedTo: employeeId,
            active: true,
        })
            .populate('scope', 'name companyEmail designation department')
            .lean();

        if (!grant) {
            return res.json({ hasAccess: false });
        }

        res.json({
            hasAccess: true,
            accessType: grant.accessType,
            scope: grant.scope || [],     // [] means all employees
            notes: grant.notes,
        });
    } catch (err) {
        console.error('[ATTENDANCE-ACCESS] my-access error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

module.exports = router;
