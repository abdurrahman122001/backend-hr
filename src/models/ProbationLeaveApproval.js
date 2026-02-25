const mongoose = require("mongoose");
const { Schema, model } = mongoose;

const ProbationLeaveApprovalSchema = new Schema(
    {
        owner: {
            type: Schema.Types.ObjectId,
            ref: "User",
            required: true,
            index: true,
        },
        employee: {
            type: Schema.Types.ObjectId,
            ref: "Employee",
            required: true,
            index: true,
        },
        // Probation details
        joiningDate: { type: Date, required: true },
        probationDays: { type: Number, required: true },
        probationEndDate: { type: Date, required: true },

        // Calculated leave details
        calculatedLeaves: { type: Number, required: true },
        leaveYear: { type: Number, required: true },

        // Status: pending → approved / rejected / extended
        status: {
            type: String,
            enum: ["pending", "approved", "rejected", "extended"],
            default: "pending",
            index: true,
        },

        // Extension tracking
        extensions: [
            {
                extensionDays: { type: Number, required: true },
                extendedBy: { type: Schema.Types.ObjectId, ref: "User" },
                extendedByName: { type: String },
                extendedAt: { type: Date, default: Date.now },
                reason: { type: String },
                newProbationEndDate: { type: Date, required: true },
                // After extension ends, recalculated leaves
                recalculatedLeaves: { type: Number, default: null },
            },
        ],

        // Total extension days accumulated
        totalExtensionDays: { type: Number, default: 0 },

        // The effective probation end date (original + all extensions)
        effectiveProbationEndDate: { type: Date, required: true },

        // Approval/Rejection details
        approvedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
        approvedByName: { type: String, default: null },
        approvedAt: { type: Date, default: null },
        rejectedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
        rejectedByName: { type: String, default: null },
        rejectedAt: { type: Date, default: null },
        rejectionReason: { type: String, default: null },

        // Final credited leaves (may differ from calculated if extended)
        finalCreditedLeaves: { type: Number, default: null },

        // Whether the leave has been credited to LeaveYearBalance
        leaveCredited: { type: Boolean, default: false },

        // Workflow history for audit trail
        workflowHistory: [
            {
                action: {
                    type: String,
                    enum: [
                        "created",
                        "approved",
                        "rejected",
                        "extended",
                        "recalculated",
                        "leave_credited",
                    ],
                },
                performedBy: { type: Schema.Types.ObjectId, ref: "User" },
                performedByName: { type: String, default: "System" },
                timestamp: { type: Date, default: Date.now },
                notes: { type: String },
                data: { type: Schema.Types.Mixed },
                _id: false,
            },
        ],
    },
    { timestamps: true }
);

// Indexes
ProbationLeaveApprovalSchema.index({ owner: 1, employee: 1, status: 1 });
ProbationLeaveApprovalSchema.index({ owner: 1, status: 1 });
ProbationLeaveApprovalSchema.index({ effectiveProbationEndDate: 1, status: 1 });

module.exports = model("ProbationLeaveApproval", ProbationLeaveApprovalSchema);
