// backend/src/routes/crmAccess.js
const express = require('express');
const router = express.Router();
const CRMAccess = require('../models/CRMAccess');
const requireAuth = require('../middleware/auth');
const requireEmpAuth = require('../middleware/empAuth');
const { isRootManager } = require('../utils/crmAccess');
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
// ADMIN ROUTES (HR portal — admin auth)
// ─────────────────────────────────────────────────────────────

/**
 * GET /api/crm-access
 * List all CRM access grants for the current owner.
 */
router.get('/', requireAuth, async (req, res) => {
    try {
        const ownerId = req.user.owner || req.user._id;
        const grants = await CRMAccess.find({ owner: ownerId })
            .populate('grantedTo', 'name companyEmail designation department')
            .sort({ createdAt: -1 })
            .lean();
        // CRM access is all-or-nothing — surface a synthetic accessTypes so the
        // shared UnifiedAccessManager renders a "CRM Access" badge.
        const normalised = grants.map((g) => ({ ...g, accessTypes: ['access'], scope: [] }));
        res.json(normalised);
    } catch (err) {
        console.error('[CRM-ACCESS] GET error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * POST /api/crm-access
 * Grant CRM access to one or more employees.
 * Body: { grantedTo: empId | empId[], notes? }
 */
router.post('/', requireAuth, async (req, res) => {
    try {
        const ownerId = req.user.owner || req.user._id;
        const { grantedTo, notes } = req.body;

        if (!grantedTo) {
            return res.status(400).json({ error: 'grantedTo (employee) is required.' });
        }

        const grantedToList = Array.isArray(grantedTo) ? grantedTo : [grantedTo];

        const results = [];
        for (const empId of grantedToList) {
            const grant = await CRMAccess.findOneAndUpdate(
                { owner: ownerId, grantedTo: empId },
                {
                    $set: {
                        owner: ownerId,
                        grantedTo: empId,
                        notes: notes || '',
                        grantedBy: req.user._id,
                        active: true,
                    },
                },
                { upsert: true, new: true, setDefaultsOnInsert: true }
            );

            const populated = await CRMAccess.findById(grant._id)
                .populate('grantedTo', 'name companyEmail designation department')
                .lean();
            results.push(populated);
        }

        res.json({ message: `${results.length} grant(s) created/updated.`, grants: results });
    } catch (err) {
        console.error('[CRM-ACCESS] POST error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * PATCH /api/crm-access/:id
 * Update an existing grant (e.g., toggle active or edit notes).
 */
router.patch('/:id', requireAuth, async (req, res) => {
    try {
        const ownerId = req.user.owner || req.user._id;
        const { notes, active } = req.body;

        const update = {};
        if (notes !== undefined) update.notes = notes;
        if (active !== undefined) update.active = active;

        const grant = await CRMAccess.findOneAndUpdate(
            { _id: req.params.id, owner: ownerId },
            { $set: update },
            { new: true }
        ).populate('grantedTo', 'name companyEmail designation department');

        if (!grant) return res.status(404).json({ error: 'Grant not found.' });
        res.json({ message: 'CRM access updated.', grant });
    } catch (err) {
        console.error('[CRM-ACCESS] PATCH error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * DELETE /api/crm-access/:id
 * Revoke CRM access.
 */
router.delete('/:id', requireAuth, async (req, res) => {
    try {
        const ownerId = req.user.owner || req.user._id;
        const deleted = await CRMAccess.findOneAndDelete({
            _id: req.params.id,
            owner: ownerId,
        });
        if (!deleted) return res.status(404).json({ error: 'Grant not found.' });
        res.json({ message: 'CRM access revoked.' });
    } catch (err) {
        console.error('[CRM-ACCESS] DELETE error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ─────────────────────────────────────────────────────────────
// EMPLOYEE ROUTE (employee portal — emp auth)
// ─────────────────────────────────────────────────────────────

/**
 * GET /api/crm-access/my-access
 * Called by every frontend header and by the CRM app gate.
 * Returns { hasAccess, isRootManager }.
 */
router.get('/my-access', requireEmpAuth, async (req, res) => {
    try {
        const employeeId = req.employee._id;
        const rawOwnerId = req.employee.owner;
        const ownerId = Array.isArray(rawOwnerId) ? rawOwnerId[0] : rawOwnerId;

        const ownerObjectId = (ownerId && ObjectId.isValid(ownerId)) ? new ObjectId(ownerId) : ownerId;

        const root = await isRootManager(ownerObjectId, employeeId);
        if (root) {
            return res.json({ hasAccess: true, isRootManager: true });
        }

        const grants = await CRMAccess.find({ owner: ownerObjectId, active: true })
            .select('grantedTo')
            .lean();
        const grant = grants.find((g) => safeIdEquals(g.grantedTo, employeeId));

        res.json({ hasAccess: !!grant, isRootManager: false });
    } catch (err) {
        console.error('[CRM-ACCESS] my-access error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

module.exports = router;
