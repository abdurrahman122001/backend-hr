// backend/src/routes/feedbackAccess.js
//
// Who may see the org-wide "All Feedbacks" tab in the Request Center.
// Mirrors routes/crmAccess.js so the shared UnifiedAccessManager UI can drive
// it with no changes.
const express = require('express');
const router = express.Router();
const FeedbackAccess = require('../models/FeedbackAccess');
const requireAuth = require('../middleware/auth');
const requireEmpAuth = require('../middleware/empAuth');
const { hasFeedbackAccess } = require('../utils/feedbackAccess');

/**
 * Only an owner or an isAdmin employee may hand this right out. requireAuth
 * already maps an isAdmin employee token to role "admin", so both arrive here
 * the same way — but a plain employee token also passes requireAuth, and must
 * not be able to grant itself access.
 */
function requireGrantor(req, res, next) {
    const role = String(req.user?.role || '').toLowerCase();
    if (role === 'admin' || role === 'super-admin' || role === 'owner') {
        return next();
    }
    return res.status(403).json({ error: 'Only an admin can manage feedback access.' });
}

// ─────────────────────────────────────────────────────────────
// ADMIN ROUTES
// ─────────────────────────────────────────────────────────────

/** GET /api/feedback-access — list all grants for the current owner. */
router.get('/', requireAuth, requireGrantor, async (req, res) => {
    try {
        const ownerId = req.user.owner || req.user._id;
        const grants = await FeedbackAccess.find({ owner: ownerId })
            .populate('grantedTo', 'name companyEmail designation department')
            .sort({ createdAt: -1 })
            .lean();
        // All-or-nothing, like CRM access: surface a synthetic accessTypes so
        // the shared manager renders a single badge.
        const normalised = grants.map((g) => ({ ...g, accessTypes: ['access'], scope: [] }));
        res.json(normalised);
    } catch (err) {
        console.error('[FEEDBACK-ACCESS] GET error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * POST /api/feedback-access — grant to one or more employees.
 * Body: { grantedTo: empId | empId[], notes? }
 */
router.post('/', requireAuth, requireGrantor, async (req, res) => {
    try {
        const ownerId = req.user.owner || req.user._id;
        const { grantedTo, notes } = req.body;

        if (!grantedTo) {
            return res.status(400).json({ error: 'grantedTo (employee) is required.' });
        }

        const grantedToList = Array.isArray(grantedTo) ? grantedTo : [grantedTo];

        const results = [];
        for (const empId of grantedToList) {
            const grant = await FeedbackAccess.findOneAndUpdate(
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

            const populated = await FeedbackAccess.findById(grant._id)
                .populate('grantedTo', 'name companyEmail designation department')
                .lean();
            results.push(populated);
        }

        res.json({ message: `${results.length} grant(s) created/updated.`, grants: results });
    } catch (err) {
        console.error('[FEEDBACK-ACCESS] POST error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

/** PATCH /api/feedback-access/:id — toggle active / edit notes. */
router.patch('/:id', requireAuth, requireGrantor, async (req, res) => {
    try {
        const ownerId = req.user.owner || req.user._id;
        const { notes, active } = req.body;

        const update = {};
        if (notes !== undefined) update.notes = notes;
        if (active !== undefined) update.active = active;

        const grant = await FeedbackAccess.findOneAndUpdate(
            { _id: req.params.id, owner: ownerId },
            { $set: update },
            { new: true }
        ).populate('grantedTo', 'name companyEmail designation department');

        if (!grant) return res.status(404).json({ error: 'Grant not found.' });
        res.json({ message: 'Feedback access updated.', grant });
    } catch (err) {
        console.error('[FEEDBACK-ACCESS] PATCH error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

/** DELETE /api/feedback-access/:id — revoke. */
router.delete('/:id', requireAuth, requireGrantor, async (req, res) => {
    try {
        const ownerId = req.user.owner || req.user._id;
        const deleted = await FeedbackAccess.findOneAndDelete({
            _id: req.params.id,
            owner: ownerId,
        });
        if (!deleted) return res.status(404).json({ error: 'Grant not found.' });
        res.json({ message: 'Feedback access revoked.' });
    } catch (err) {
        console.error('[FEEDBACK-ACCESS] DELETE error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// ─────────────────────────────────────────────────────────────
// EMPLOYEE ROUTE — drives the "All Feedbacks" tab
// ─────────────────────────────────────────────────────────────

/** GET /api/feedback-access/my-access → { hasAccess, isAdmin } */
router.get('/my-access', requireEmpAuth, async (req, res) => {
    try {
        const hasAccess = await hasFeedbackAccess(req.employee);
        res.json({ hasAccess, isAdmin: req.employee?.isAdmin === true });
    } catch (err) {
        console.error('[FEEDBACK-ACCESS] my-access error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

module.exports = router;
