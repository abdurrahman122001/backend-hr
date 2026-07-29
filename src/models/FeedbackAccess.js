// backend/src/models/FeedbackAccess.js
const { Schema, model } = require('mongoose');

/**
 * FeedbackAccess
 * Grants an employee the org-wide "All Feedbacks" view in the Request Center —
 * every feedback raised in the organisation, not just their own.
 *
 * Access is ALL-OR-NOTHING (no accessTypes). Owners and isAdmin employees have
 * it implicitly and never need a grant — see backend/src/utils/feedbackAccess.js.
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
