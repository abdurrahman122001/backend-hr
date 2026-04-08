// backend/src/models/PayrollAccess.js
const { Schema, model } = require('mongoose');

/**
 * PayrollAccess
 * Grants an employee the ability to view or edit payroll records
 * on behalf of the admin, without needing admin credentials.
 * Follows the same pattern as AttendanceAccess
 */
const PayrollAccessSchema = new Schema(
    {
        owner: {
            type: Schema.Types.ObjectId,
            ref: 'User',
            required: true,
            index: true,
        },
        // The employee who is GRANTED access
        grantedTo: {
            type: Schema.Types.ObjectId,
            ref: 'Employee',
            required: true,
        },
        // Access level: 'view' = read-only, 'edit' = view + edit payroll
        accessType: {
            type: String,
            enum: ['view', 'edit'],
            default: 'view',
        },
        // Optional: restrict to specific employees. Empty = access to ALL employees.
        scope: [
            {
                type: Schema.Types.ObjectId,
                ref: 'Employee',
            },
        ],
        // Who granted this access (HR user)
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
PayrollAccessSchema.index(
    { owner: 1, grantedTo: 1 },
    { unique: true, sparse: true }
);

module.exports = model('PayrollAccess', PayrollAccessSchema);
