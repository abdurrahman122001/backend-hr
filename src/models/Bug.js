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

// Virtual for image URLs
bugSchema.virtual("imageUrls").get(function () {
  return this.images.map((image) => `/api/bugs/images/${image.filename}`);
});

module.exports = mongoose.model("Bug", bugSchema);
