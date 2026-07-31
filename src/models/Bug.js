// models/Bug.js
const mongoose = require("mongoose");

const bugSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      required: true,
      trim: true,
    },
    priority: {
      type: String,
      enum: ["low", "medium", "high"],
      default: "medium",
    },
    status: {
      type: String,
      enum: ["open", "pending_approval", "resolved"],
      default: "open",
    },
    reportedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Employee",
      required: true,
    },
    department: {
      type: String,
      required: true,
    },
    // Who is meant to act on this feedback. Set after the fact from the
    // Feedbacks page by an admin / feedback-resolve grantee, not by the
    // reporter at submit time. null = unassigned.
    assignedTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Employee",
      default: null,
    },
    assignedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Employee",
      default: null,
    },
    assignedAt: {
      type: Date,
      default: null,
    },
    // Employee who performed (or requested, for the R&D approval flow) the
    // latest resolution. Cleared whenever feedback is reopened.
    resolvedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Employee",
      default: null,
    },
    resolvedAt: {
      type: Date,
      default: null,
    },
    images: [
      {
        filename: {
          type: String,
          required: true,
        },
        originalName: {
          type: String,
          required: true,
        },
        path: {
          type: String,
          required: true,
        },
        mimetype: {
          type: String,
          required: true,
        },
        size: {
          type: Number,
          required: true,
        },
        uploadDate: {
          type: Date,
          default: Date.now,
        },
      },
    ],
    approvalRequired: {
      type: Boolean,
      default: false,
    },
    approvedByReporter: {
      type: Boolean,
      default: false,
    },
    rewardAdded: {
      type: Boolean,
      default: false,
    },

    rewardAmount: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Indexes to keep bug queries off full collection scans.
// - Employee/owner views filter by reportedBy (+ optional status) and sort by createdAt.
// - Admin/R&D views filter by status (or nothing) and sort by createdAt.
bugSchema.index({ reportedBy: 1, status: 1, createdAt: -1 });
bugSchema.index({ status: 1, createdAt: -1 });
bugSchema.index({ createdAt: -1 });
// "What is assigned to me / to this person" filtering on the Feedbacks page.
bugSchema.index({ assignedTo: 1, createdAt: -1 });

// Assignee is wanted on every read path (employee list, org-wide list, detail,
// owner dashboard), so populate it here rather than repeating it at each of the
// dozen call sites in the controller. Document-level .populate() calls after a
// save are NOT queries and do not hit this hook — those populate explicitly.
const ASSIGNEE_FIELDS = "name companyEmail department designation photographUrl";
bugSchema.pre(/^find/, function autoPopulateAssignee(next) {
  this.populate({ path: "assignedTo", select: ASSIGNEE_FIELDS });
  next();
});

// Virtual for image URLs
bugSchema.virtual("imageUrls").get(function () {
  return this.images.map((image) => `/api/bugs/images/${image.filename}`);
});

module.exports = mongoose.model("Bug", bugSchema);
module.exports.ASSIGNEE_FIELDS = ASSIGNEE_FIELDS;
