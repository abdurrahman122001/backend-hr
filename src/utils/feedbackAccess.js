// backend/src/utils/feedbackAccess.js
const mongoose = require('mongoose');
const FeedbackAccess = require('../models/FeedbackAccess');
const Employee = require('../models/Employees');

const ObjectId = mongoose.Types.ObjectId;

function toId(v) {
    if (Array.isArray(v)) v = v[0];
    if (!v) return null;
    try {
        return ObjectId.isValid(v) ? new ObjectId(v) : v;
    } catch (e) {
        return v;
    }
}

/**
 * hasFeedbackAccess
 * True when this employee may see every feedback in the organisation:
 *   • isAdmin employees and owners — implicit, they grant the rights in the
 *     first place, so requiring them to grant themselves would be circular
 *   • anyone holding an active FeedbackAccess grant
 *
 * Accepts the `req.employee` object (or an id). Returns false rather than
 * throwing, so a lookup failure denies rather than opening the org up.
 */
async function hasFeedbackAccess(employeeOrId) {
    const { hasAccess } = await getFeedbackAccess(employeeOrId);
    return hasAccess;
}

/**
 * getFeedbackAccess
 * The full picture for one employee: { hasAccess, canResolve, isAdmin }.
 *
 *   • hasAccess  — may see every feedback in the organisation
 *   • canResolve — may additionally resolve anyone's feedback
 *
 * isAdmin employees and owners get both implicitly. For a granted employee the
 * rights come from the grant's accessTypes; a grant with none stored predates
 * that field and was view-only, so it is read as ["view"].
 *
 * Never throws: a lookup failure denies rather than opening the org up.
 */
async function getFeedbackAccess(employeeOrId) {
    const denied = { hasAccess: false, canResolve: false, isAdmin: false };
    try {
        if (!employeeOrId) return denied;

        const employeeId = toId(employeeOrId._id || employeeOrId);
        if (!employeeId) return denied;

        // Trust the caller's object when it already carries the flags, so the
        // common path costs no extra query.
        let employee = employeeOrId;
        if (employee.isAdmin === undefined || !employee.owner) {
            employee = await Employee.findById(employeeId)
                .select('_id isAdmin role owner')
                .lean();
        }
        if (!employee) return denied;

        if (employee.isAdmin === true) {
            return { hasAccess: true, canResolve: true, isAdmin: true };
        }

        const role = String(employee.role || '').toLowerCase();
        if (role === 'owner' || role === 'admin' || role === 'super-admin') {
            return { hasAccess: true, canResolve: true, isAdmin: false };
        }

        const ownerId = toId(employee.owner);
        if (!ownerId) return denied;

        const grant = await FeedbackAccess.findOne({
            owner: ownerId,
            grantedTo: employeeId,
            active: true,
        })
            .select('accessTypes')
            .lean();
        if (!grant) return denied;

        const types = Array.isArray(grant.accessTypes) && grant.accessTypes.length
            ? grant.accessTypes
            : ['view'];  // pre-accessTypes grants were view-only

        return {
            hasAccess: true,
            canResolve: types.includes('resolve'),
            isAdmin: false,
        };
    } catch (err) {
        console.error('[FEEDBACK-ACCESS] getFeedbackAccess error:', err.message);
        return denied;
    }
}

module.exports = { hasFeedbackAccess, getFeedbackAccess };
