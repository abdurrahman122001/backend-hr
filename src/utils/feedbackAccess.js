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
    try {
        if (!employeeOrId) return false;

        const employeeId = toId(employeeOrId._id || employeeOrId);
        if (!employeeId) return false;

        // Trust the caller's object when it already carries the flags, so the
        // common path costs no extra query.
        let employee = employeeOrId;
        if (employee.isAdmin === undefined || !employee.owner) {
            employee = await Employee.findById(employeeId)
                .select('_id isAdmin role owner')
                .lean();
        }
        if (!employee) return false;

        if (employee.isAdmin === true) return true;

        const role = String(employee.role || '').toLowerCase();
        if (role === 'owner' || role === 'admin' || role === 'super-admin') {
            return true;
        }

        const ownerId = toId(employee.owner);
        if (!ownerId) return false;

        const grant = await FeedbackAccess.exists({
            owner: ownerId,
            grantedTo: employeeId,
            active: true,
        });
        return !!grant;
    } catch (err) {
        console.error('[FEEDBACK-ACCESS] hasFeedbackAccess error:', err.message);
        return false;
    }
}

module.exports = { hasFeedbackAccess };
