// backend/src/models/FeedbackAccess.js
const { Schema, model } = require('mongoose');

/**
 * FeedbackAccess
 * Grants an employee the org-wide "All Feedbacks" view in the Request Center —
 * every feedback raised in the organisation, not just their own.
 *
 * Two rights, both optional extras on top of each other:
 *   • view    — see every feedback in the org ("All Feedbacks")
 *   • resolve — additionally resolve any employee's feedback, not just read it
 *
 * Owners and isAdmin employees have both implicitly and never need a grant —
 * see backend/src/utils/feedbackAccess.js.
 *
 * Deliberately the same shape as CRMAccess / PayrollAccess / AttendanceAccess so
 * the shared UnifiedAccessManager UI works against it unchanged.
 */
const FeedbackAccessSchema = new Schema(
    {
        owner: {
            type: Schema.Types.ObjectId,
            ref: 'User',
            required: true,
            index: true,
        },
        // The employee who is GRANTED access to all feedbacks
        grantedTo: {
            type: Schema.Types.ObjectId,
            ref: 'Employee',
            required: true,
        },
        // Who granted it (an owner or an isAdmin employee)
        grantedBy: {
            type: Schema.Types.ObjectId,
            ref: 'User',
        },
        /**
         * Rights held. Grants created before this field existed have none
         * stored, and every one of those was a view-only grant, so readers must
         * treat an empty array as ["view"] rather than as "no rights".
         */
        accessTypes: {
            type: [{ type: String, enum: ['view', 'resolve'] }],
            default: ['view'],
        },
        active: {
            type: Boolean,
            default: true,
        },
        notes: String,
    },
    { timestamps: true }
);

// One grant per employee per owner — upsert-friendly
FeedbackAccessSchema.index({ owner: 1, grantedTo: 1 }, { unique: true, sparse: true });

module.exports = model('FeedbackAccess', FeedbackAccessSchema);
