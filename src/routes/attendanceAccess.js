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

        // Normalise each grant so the frontend always receives accessTypes[]
        const normalised = grants.map(g => ({
            ...g,
            accessTypes: Array.isArray(g.accessTypes) && g.accessTypes.length > 0
                ? g.accessTypes
                : (g.accessType ? [g.accessType] : ['view']),
        }));

        res.json(normalised);
    } catch (err) {
        console.error('[ATTENDANCE-ACCESS] GET error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * POST /api/attendance-access
 * Grant or update attendance access for one or more employees
 * Body: { grantedTo: empId | empId[], accessTypes: ['view','mark','edit','approve'], scope?: [empId,...], notes? }
 */
router.post('/', requireAuth, async (req, res) => {
    try {
        const ownerId = req.user.owner || req.user._id;
        let { grantedTo, accessTypes, accessType, scope, notes } = req.body;

        // Legacy single value → promote to array
        if (!accessTypes && accessType) {
            accessTypes = [accessType];
        }
        if (!Array.isArray(accessTypes) || accessTypes.length === 0) {
            accessTypes = ['view'];
        }

        // Validate
        const validTypes = ['view', 'mark', 'edit', 'approve'];
        const invalid = accessTypes.filter(t => !validTypes.includes(t));
        if (invalid.length > 0) {
            return res.status(400).json({ error: `Invalid access type(s): ${invalid.join(', ')}` });
        }

        if (!grantedTo) {
            return res.status(400).json({ error: 'grantedTo (employee) is required.' });
        }

        // Support both single employee and array input
        const grantedToList = Array.isArray(grantedTo) ? grantedTo : [grantedTo];

        const results = [];
        for (const empId of grantedToList) {
            const grant = await AttendanceAccess.findOneAndUpdate(
                { owner: ownerId, grantedTo: empId },
                {
                    $set: {
                        owner: ownerId,
                        grantedTo: empId,
                        accessTypes,
                        scope: Array.isArray(scope) ? scope : [],
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

            results.push(populated);
        }

        res.json({ message: `${results.length} grant(s) created/updated.`, grants: results });
    } catch (err) {
        console.error('[ATTENDANCE-ACCESS] POST error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * PATCH /api/attendance-access/:id
 * Update an existing grant (e.g., change accessTypes or scope)
 */
router.patch('/:id', requireAuth, async (req, res) => {
    try {
        const ownerId = req.user.owner || req.user._id;
        let { accessTypes, accessType, scope, notes, active } = req.body;

        // Legacy single value → promote to array
        if (accessTypes === undefined && accessType) {
            accessTypes = [accessType];
        }
        if (accessTypes !== undefined && !Array.isArray(accessTypes)) {
            accessTypes = [accessTypes];
        }

        const update = {};
        if (accessTypes !== undefined) update.accessTypes = accessTypes;
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

        res.json({
            message: 'Access updated.',
            grant: {
                ...grant,
                accessTypes: Array.isArray(grant.accessTypes) && grant.accessTypes.length > 0
                    ? grant.accessTypes
                    : (grant.accessType ? [grant.accessType] : ['view']),
            },
        });
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

        const accessTypes = Array.isArray(grant.accessTypes) && grant.accessTypes.length > 0
            ? grant.accessTypes
            : (grant.accessType ? [grant.accessType] : ['view']);

        res.json({
            hasAccess: true,
            accessTypes,
            accessType: accessTypes[0], // backward-compat single value
            scope: grant.scope || [],     // [] means all employees
            notes: grant.notes,
        });
    } catch (err) {
        console.error('[ATTENDANCE-ACCESS] my-access error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

module.exports = router;
