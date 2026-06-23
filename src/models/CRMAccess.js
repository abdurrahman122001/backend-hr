// backend/src/models/CRMAccess.js
const { Schema, model } = require('mongoose');

/**
 * CRMAccess
 * Grants an employee access to the standalone CRM app, where they can
 * compose/send WhatsApp & Email messages on behalf of a client and
 * add/update clients.
 *
 * Access is ALL-OR-NOTHING (no accessTypes). The top of the org hierarchy
 * (EmployeeHierarchy.rootManager) implicitly has access without a grant —
 * see backend/src/utils/crmAccess.js.
 *
 * Follows the same delegation pattern as PayrollAccess / AttendanceAccess.
 */
const CRMAccessSchema = new Schema(
    {
        owner: {
            type: Schema.Types.ObjectId,
            ref: 'User',
            required: true,
            index: true,
        },
        // The employee who is GRANTED CRM access
        grantedTo: {
            type: Schema.Types.ObjectId,
            ref: 'Employee',
            required: true,
        },
        // Who granted this access (HR/admin user)
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
CRMAccessSchema.index({ owner: 1, grantedTo: 1 }, { unique: true, sparse: true });

module.exports = model('CRMAccess', CRMAccessSchema);
