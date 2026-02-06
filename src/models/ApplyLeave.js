const mongoose = require("mongoose");
const { Schema } = mongoose;

const leaveSchema = new Schema(
  {
    employee: {
      type: Schema.Types.ObjectId,
      ref: "Employee",
      required: true,
      index: true,
    },
    supervisor: {
      type: Schema.Types.ObjectId,
      ref: "Employee",
      required: false,
    },
    appliedBy: {
      type: Schema.Types.ObjectId,
      ref: "Employee",
      required: true,
    },

    // Leave Dates Configuration
    dates: [
      {
        date: { type: Date, required: true },
        type: {
          type: String,
          enum: ["full", "half", "late", "early_leave"],
          default: "full",
        },
        hours: { type: Number, default: 8 },
        time: { type: String }, // For late arrival or early departure time (e.g., "10:30")
        _id: false,
      },
    ],

    // Leave Details
    leaveType: {
      type: String,
      enum: ["annual", "sick", "personal", "emergency", "late", "early_leave", "other"],
      required: true,
    },
    customLeaveType: {
      type: String,
      required: function () {
        return this.leaveType === "other";
      },
    },
    reason: {
      type: String,
      required: true,
      minlength: [10, "Reason must be at least 10 characters"],
    },

    // Status Tracking
    status: {
      type: String,
      enum: ["pending", "approved", "rejected", "cancelled", "auto_approved", "auto_rejected"],
      default: "pending",
      index: true,
    },
    policyAnalysis: {
      decision: {
        type: String,
        enum: ["approved", "rejected", "pending", "auto_approved", "auto_rejected"],
        default: "pending",
      },
      isAutoDecision: {
        type: Boolean,
        default: false,
      },
      reason: String,
      violations: [
        {
          type: {
            type: String,
            enum: ["ADVANCE_NOTICE", "PROBATION", "LEAVE_BALANCE", "SANDWICH_POLICY", "OTHER"]
          },
          message: String,
          impact: String,
        },
      ],
      rulesChecked: {
        paidLeaveAdvanceNoticeDays: Number,
        totalPaidLeavesPerYear: Number,
        hasSandwichPolicy: Boolean,
        probationPeriodMonths: Number,
        annualLeaveEntitlement: Number
      },
      analyzedAt: Date,
    },

    isPaid: {
      type: Boolean,
      default: true,
    },
    appliedDate: {
      type: Date,
      default: Date.now,
      required: true,
    },

    // Approval Details
    approvedBy: {
      type: Schema.Types.ObjectId,
      ref: "Employee",
    },
    approvedDate: { type: Date },
    rejectionReason: { type: String },
    rejectedBy: {
      type: Schema.Types.ObjectId,
      ref: "Employee",
    },
    rejectedDate: { type: Date },

    // Cancellation
    cancelledBy: {
      type: Schema.Types.ObjectId,
      ref: "Employee",
    },
    cancelledDate: { type: Date },
    cancellationReason: { type: String },

    // Calculated Fields
    totalDays: { type: Number, required: true },
    totalHours: { type: Number, required: true },
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },

    // Metadata
    isTrashed: { type: Boolean, default: false },
    trashedAt: { type: Date },
    trashedBy: { type: Schema.Types.ObjectId, ref: "Employee" },

    // Workflow
    workflowHistory: [
      {
        action: {
          type: String,
          enum: [
            "created",
            "submitted",
            "approved",
            "rejected",
            "cancelled",
            "updated",
            "auto_approved",
            "auto_rejected",
            "system_approved",
            "system_rejected"
          ],
        },
        performedBy: {
          type: Schema.Types.ObjectId,
          ref: "Employee",
        },
        performedByName: {
          type: String,
          default: "System"
        },
        timestamp: { type: Date, default: Date.now },
        notes: { type: String },
        policyOverride: { type: Boolean, default: false },
        _id: false,
      },
    ],
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  },
);

// Indexes for performance
leaveSchema.index({ employee: 1, startDate: 1, endDate: 1 });
leaveSchema.index({ status: 1, startDate: 1 });
leaveSchema.index({ appliedDate: -1 });
leaveSchema.index({ supervisor: 1, status: 1 });
leaveSchema.index({ "policyAnalysis.isAutoDecision": 1 });

// Virtual for formatted status
leaveSchema.virtual("statusFormatted").get(function () {
  const statusMap = {
    pending: { label: "Pending Approval", color: "warning" },
    approved: { label: "Approved", color: "success" },
    rejected: { label: "Rejected", color: "danger" },
    cancelled: { label: "Cancelled", color: "secondary" },
    auto_approved: { label: "Auto-Approved", color: "success" },
    auto_rejected: { label: "Auto-Rejected", color: "danger" },
  };
  return statusMap[this.status] || { label: this.status, color: "secondary" };
});

// Virtual for leave type label
leaveSchema.virtual("leaveTypeLabel").get(function () {
  const typeMap = {
    annual: "Annual Leave",
    sick: "Sick Leave",
    personal: "Personal Leave",
    emergency: "Emergency Leave",
    late: "Late Arrival",
    early_leave: "Early Departure",
    other: this.customLeaveType || "Other Leave",
  };
  return typeMap[this.leaveType] || "Unknown";
});

// Virtual for decision type (auto/manual)
leaveSchema.virtual("decisionType").get(function () {
  if (this.policyAnalysis?.isAutoDecision) {
    return "auto";
  }
  if (this.status === "auto_approved" || this.status === "auto_rejected") {
    return "auto";
  }
  return "manual";
});

// Virtual for display status (combines status and auto-decision)
leaveSchema.virtual("displayStatus").get(function () {
  if (this.status === "auto_approved") return "Auto-Approved";
  if (this.status === "auto_rejected") return "Auto-Rejected";
  return this.status.charAt(0).toUpperCase() + this.status.slice(1);
});

// Pre-save middleware to update workflow history
leaveSchema.pre("save", function (next) {
  if (this.isNew) {
    this.workflowHistory.push({
      action: "created",
      performedBy: this.appliedBy,
      notes: "Leave request created",
    });
  }

  // Handle auto-decision workflow history
  if (this.isModified("policyAnalysis") && this.policyAnalysis?.isAutoDecision) {
    if (this.policyAnalysis.decision === "auto_approved") {
      this.workflowHistory.push({
        action: "auto_approved",
        performedBy: null,
        performedByName: "System (HR Policy)",
        notes: this.policyAnalysis.reason || "Auto-approved by HR policy system",
        timestamp: new Date(),
      });
    } else if (this.policyAnalysis.decision === "auto_rejected") {
      this.workflowHistory.push({
        action: "auto_rejected",
        performedBy: null,
        performedByName: "System (HR Policy)",
        notes: this.policyAnalysis.reason || "Auto-rejected by HR policy system",
        timestamp: new Date(),
      });
    }
  }

  // Handle status changes
  if (this.isModified("status")) {
    let action = "updated";
    let performedByName = "Unknown";

    if (this.status === "approved") {
      action = "approved";
      performedByName = "Supervisor";
    } else if (this.status === "rejected") {
      action = "rejected";
      performedByName = "Supervisor";
    } else if (this.status === "cancelled") {
      action = "cancelled";
      performedByName = "Employee";
    } else if (this.status === "auto_approved") {
      action = "auto_approved";
      performedByName = "System";
    } else if (this.status === "auto_rejected") {
      action = "auto_rejected";
      performedByName = "System";
    }

    this.workflowHistory.push({
      action,
      performedBy: this.getPerformedByForStatus(),
      performedByName,
      notes: this.getStatusChangeNotes(),
      timestamp: new Date(),
    });
  }
  next();
});

// Helper method to get who performed the status change
leaveSchema.methods.getPerformedByForStatus = function () {
  switch (this.status) {
    case "approved":
      return this.approvedBy;
    case "rejected":
      return this.rejectedBy;
    case "cancelled":
      return this.cancelledBy;
    case "auto_approved":
    case "auto_rejected":
      return null; // System action
    default:
      return this.appliedBy;
  }
};

// Helper method to get notes for status change
leaveSchema.methods.getStatusChangeNotes = function () {
  if (this.rejectionReason) {
    return `Rejected: ${this.rejectionReason}`;
  }
  if (this.cancellationReason) {
    return `Cancelled: ${this.cancellationReason}`;
  }
  if (this.status === "auto_approved" || this.status === "auto_rejected") {
    return this.policyAnalysis?.reason || `Auto-${this.status.replace('auto_', '')} by system`;
  }
  return `Status changed to ${this.status}`;
};

// Static method to check for overlapping leaves
leaveSchema.statics.checkOverlap = async function (
  employeeId,
  startDate,
  endDate,
  excludeLeaveId = null,
) {
  const query = {
    employee: employeeId,
    status: { $in: ["pending", "approved", "auto_approved"] },
    $or: [{ startDate: { $lte: endDate }, endDate: { $gte: startDate } }],
  };

  if (excludeLeaveId) {
    query._id = { $ne: excludeLeaveId };
  }

  return this.findOne(query);
};

// Static method to get leave summary for employee - FIXED
leaveSchema.statics.getLeaveSummary = async function (
  employeeId,
  year = new Date().getFullYear(),
) {
  const startOfYear = new Date(year, 0, 1);
  const endOfYear = new Date(year, 11, 31, 23, 59, 59, 999);

  // Convert employeeId to ObjectId properly
  let employeeObjectId;
  try {
    // Check if it's already an ObjectId
    if (mongoose.isObjectIdOrHexString(employeeId)) {
      employeeObjectId = new mongoose.Types.ObjectId(employeeId);
    } else {
      employeeObjectId = employeeId;
    }
  } catch (error) {
    console.error('Invalid employeeId:', employeeId, error);
    return {};
  }

  const leaves = await this.aggregate([
    {
      $match: {
        employee: employeeObjectId,
        status: { $in: ["approved", "auto_approved"] },
        startDate: { $gte: startOfYear },
        endDate: { $lte: endOfYear },
      },
    },
    {
      $group: {
        _id: "$leaveType",
        totalDays: { $sum: "$totalDays" },
        totalHours: { $sum: "$totalHours" },
        count: { $sum: 1 },
      },
    },
  ]);

  return leaves.reduce((acc, curr) => {
    acc[curr._id] = curr;
    return acc;
  }, {});
};

// Static method to get auto-decision statistics - FIXED
leaveSchema.statics.getAutoDecisionStats = async function (ownerId, startDate, endDate) {
  let ownerObjectId;
  try {
    if (mongoose.isObjectIdOrHexString(ownerId)) {
      ownerObjectId = new mongoose.Types.ObjectId(ownerId);
    } else {
      ownerObjectId = ownerId;
    }
  } catch (error) {
    console.error('Invalid ownerId:', ownerId, error);
    return [];
  }

  const match = {
    "employeeData.owner": ownerObjectId,
    "policyAnalysis.isAutoDecision": true,
  };

  if (startDate) match.appliedDate = { $gte: new Date(startDate) };
  if (endDate) match.appliedDate = { $lte: new Date(endDate) };

  return this.aggregate([
    {
      $lookup: {
        from: "employees",
        localField: "employee",
        foreignField: "_id",
        as: "employeeData",
      },
    },
    { $unwind: "$employeeData" },
    { $match: match },
    {
      $group: {
        _id: "$policyAnalysis.decision",
        count: { $sum: 1 },
        totalDays: { $sum: "$totalDays" },
        avgNoticeDays: {
          $avg: {
            $divide: [
              { $subtract: ["$startDate", "$appliedDate"] },
              1000 * 60 * 60 * 24
            ]
          }
        }
      },
    },
  ]);
};

const ApplyLeave = mongoose.model("ApplyLeave", leaveSchema);
module.exports = ApplyLeave;