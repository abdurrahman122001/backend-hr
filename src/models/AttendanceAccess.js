// backend/src/models/AttendanceAccess.js
const { Schema, model } = require('mongoose');

const AttendanceAccessSchema = new Schema(
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
        // Access types array – multiple rights can be selected at once
        // e.g. ['view', 'mark', 'edit', 'approve']
        accessTypes: [{
            type: String,
            enum: ['view', 'mark', 'edit', 'approve'],
            default: undefined,
        }],
        // Legacy single-value field (kept for backward-compat read)
        accessType: {
            type: String,
            enum: ['view', 'edit'],
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

// Returns the effective access types array: prefer new accessTypes, fall back to legacy accessType
function getEffectiveAccessTypes(doc) {
    const at = Array.isArray(doc.accessTypes) ? doc.accessTypes : [];
    if (at.length > 0) return at;
    if (doc.accessType) return [doc.accessType];
    return ['view']; // safe default
}

AttendanceAccessSchema.virtual('effectiveAccessTypes').get(function () {
    return getEffectiveAccessTypes(this);
});

AttendanceAccessSchema.set('toJSON', { virtuals: true });
AttendanceAccessSchema.set('toObject', { virtuals: true });

// One grant per employee per owner — upsert-friendly
AttendanceAccessSchema.index({ owner: 1, grantedTo: 1 }, { unique: true });

module.exports = model('AttendanceAccess', AttendanceAccessSchema);
