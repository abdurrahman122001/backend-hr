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
          enum: ["full", "half"],
          default: "full",
        },
        hours: { type: Number, default: 8 },
        _id: false,
      },
    ],
    
    // Leave Details
    leaveType: {
      type: String,
      enum: ["annual", "sick", "personal", "emergency", "other"],
      required: true,
    },
    customLeaveType: {
      type: String,
      required: function() { return this.leaveType === "other"; },
    },
    reason: {
      type: String,
      required: true,
      minlength: [10, "Reason must be at least 10 characters"],
    },
    
    // Status Tracking
    status: {
      type: String,
      enum: ["pending", "approved", "rejected", "cancelled"],
      default: "pending",
      index: true,
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
          enum: ["created", "submitted", "approved", "rejected", "cancelled", "updated"],
        },
        performedBy: {
          type: Schema.Types.ObjectId,
          ref: "Employee",
        },
        timestamp: { type: Date, default: Date.now },
        notes: { type: String },
        _id: false,
      },
    ],
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Indexes for performance
leaveSchema.index({ employee: 1, startDate: 1, endDate: 1 });
leaveSchema.index({ status: 1, startDate: 1 });
leaveSchema.index({ appliedDate: -1 });
leaveSchema.index({ supervisor: 1, status: 1 });

// Virtual for formatted status
leaveSchema.virtual("statusFormatted").get(function() {
  const statusMap = {
    pending: { label: "Pending Approval", color: "warning" },
    approved: { label: "Approved", color: "success" },
    rejected: { label: "Rejected", color: "danger" },
    cancelled: { label: "Cancelled", color: "secondary" },
  };
  return statusMap[this.status] || { label: this.status, color: "secondary" };
});

// Virtual for leave type label
leaveSchema.virtual("leaveTypeLabel").get(function() {
  const typeMap = {
    annual: "Annual Leave",
    sick: "Sick Leave",
    personal: "Personal Leave",
    emergency: "Emergency Leave",
    other: this.customLeaveType || "Other Leave",
  };
  return typeMap[this.leaveType] || "Unknown";
});

// Pre-save middleware to update workflow history
leaveSchema.pre("save", function(next) {
  if (this.isNew) {
    this.workflowHistory.push({
      action: "created",
      performedBy: this.appliedBy,
      notes: "Leave request created",
    });
  } else if (this.isModified("status")) {
    let action = "updated";
    if (this.status === "approved") action = "approved";
    if (this.status === "rejected") action = "rejected";
    if (this.status === "cancelled") action = "cancelled";
    
    this.workflowHistory.push({
      action,
      performedBy: this.status === "approved" ? this.approvedBy : 
                   this.status === "rejected" ? this.rejectedBy : 
                   this.status === "cancelled" ? this.cancelledBy : this.appliedBy,
      notes: this.rejectionReason || this.cancellationReason || `Status changed to ${this.status}`,
    });
  }
  next();
});

// Static method to check for overlapping leaves
leaveSchema.statics.checkOverlap = async function(employeeId, startDate, endDate, excludeLeaveId = null) {
  const query = {
    employee: employeeId,
    status: { $in: ["pending", "approved"] },
    $or: [
      { startDate: { $lte: endDate }, endDate: { $gte: startDate } },
    ],
  };
  
  if (excludeLeaveId) {
    query._id = { $ne: excludeLeaveId };
  }
  
  return this.findOne(query);
};

// Static method to get leave summary for employee
leaveSchema.statics.getLeaveSummary = async function(employeeId, year = new Date().getFullYear()) {
  const startOfYear = new Date(year, 0, 1);
  const endOfYear = new Date(year, 11, 31, 23, 59, 59, 999);
  
  const leaves = await this.aggregate([
    {
      $match: {
        employee: mongoose.Types.ObjectId(employeeId),
        status: "approved",
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

const ApplyLeave = mongoose.model("ApplyLeave", leaveSchema);
module.exports = ApplyLeave;