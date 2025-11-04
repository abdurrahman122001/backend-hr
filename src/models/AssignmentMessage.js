// models/AssignmentMessage.js
const mongoose = require("mongoose");
const { Schema } = mongoose;

const AttachmentSchema = new Schema(
  {
    filename: String,
    originalName: String,
    mimetype: String,
    size: Number,
    url: String,
    uploadedAt: { type: Date, default: Date.now },
    uploadedBy: { type: Schema.Types.ObjectId, ref: "Employee" },
  },
  { _id: true }
);

const AssignmentMessageSchema = new Schema(
  {
    // Organization / data ownership scope
    owner: { type: Schema.Types.ObjectId, ref: "User", required: true },

    // Conversation scope
    client: {
      type: Schema.Types.ObjectId,
      ref: "ClientInfo",
      required: false,
    },
    // Thread identification
    threadId: {
      type: String,
      index: true,
    },

    // Participants
    sender: { type: Schema.Types.ObjectId, ref: "Employee", required: true },
    receiver: [
      { type: Schema.Types.ObjectId, ref: "Employee", required: true },
    ],

    subject: { type: String },
    note: { type: String },
    approvalStatus: {
      type: String,
      enum: ["pending", "approved", "disapproved"],
      default: null,
    },

    // Scheduling fields
    isScheduled: { type: Boolean, default: false },
    starred: {
      type: Boolean,
      default: false,
    },
    starredBy: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Employee",
      },
    ],
    scheduledFor: { type: Date },
    scheduledAt: { type: Date },
    scheduledBy: { type: Schema.Types.ObjectId, ref: "Employee" },
    sentAt: { type: Date },
    status: {
      type: String,
      enum: ["draft", "scheduled", "sent", "cancelled"],
      default: "sent",
    },
    isTrashed: { type: Boolean, default: false },
    trashedAt: { type: Date },
    trashedBy: { type: Schema.Types.ObjectId, ref: "Employee" },

    // Spam fields
    isSpam: { type: Boolean, default: false },
    spamReportedAt: { type: Date },
    spamReportedBy: { type: Schema.Types.ObjectId, ref: "Employee" },
    spamReportCount: { type: Number, default: 0 },
    spamReporters: [{ type: Schema.Types.ObjectId, ref: "Employee" }],

    approvedAt: { type: Date },
    approvedBy: { type: Schema.Types.ObjectId, ref: "Employee" },
    disapprovalNote: { type: String }, // For disapproved messages
    disapprovedAt: { type: Date },
    disapprovedBy: { type: Schema.Types.ObjectId, ref: "Employee" },
    resubmittedAt: { type: Date }, // For when disapproved messages are resubmitted
    lastEditedBy: { type: Schema.Types.ObjectId, ref: "Employee" },
    lastEditedAt: { type: Date },

    // Files
    attachments: [AttachmentSchema],

    replyTo: {
      type: Schema.Types.ObjectId,
      ref: "AssignmentMessage",
      default: null,
    },

    // NEW: Add HR policy flag
    isHrPolicy: { type: Boolean, default: false },
    isSystemMessage: { type: Boolean, default: false },
  },
  { timestamps: true }
);

/** Helpful query patterns */
AssignmentMessageSchema.index({ owner: 1, createdAt: -1 });
AssignmentMessageSchema.index({ client: 1, createdAt: -1 });
AssignmentMessageSchema.index({ sender: 1, createdAt: -1 });
AssignmentMessageSchema.index({ receiver: 1, createdAt: -1 });
AssignmentMessageSchema.index({ status: 1, scheduledFor: 1 });
AssignmentMessageSchema.index({ isScheduled: 1, scheduledFor: 1 });
AssignmentMessageSchema.index({ threadId: 1, createdAt: -1 });
AssignmentMessageSchema.index({
  client: 1,
  sender: 1,
  receiver: 1,
  createdAt: -1,
});

// 🔥 FIXED: Pre-save middleware with proper threadId generation for both client-based and direct messages
AssignmentMessageSchema.pre("save", function (next) {
  // Only generate threadId if not already set
  if (!this.threadId) {
    let threadId;

    if (this.client) {
      // Client-based message: use client + subject
      const clientId = this.client.toString();
      const subject = this.subject || "no_subject";
      const normalizedSubject = subject
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "_")
        .substring(0, 50);
      threadId = `thread_${clientId}_${normalizedSubject}_${Date.now()}`;
    } else {
      // Direct message (no client): use participants + subject
      const participants = [
        this.sender.toString(),
        ...this.receiver.map((r) => r.toString()),
      ]
        .sort()
        .join("_")
        .substring(0, 100); // Limit length

      const subject = this.subject || "direct_message";
      const normalizedSubject = subject
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "_")
        .substring(0, 50);

      threadId = `direct_${participants}_${normalizedSubject}_${Date.now()}`;
    }

    this.threadId = threadId;
  }
  next();
});

// 🔥 NEW: Add validation to ensure receiver is always an array with at least one element
AssignmentMessageSchema.pre("save", function (next) {
  if (!this.receiver || this.receiver.length === 0) {
    const error = new Error("At least one receiver is required");
    return next(error);
  }

  // Ensure receiver is always treated as an array
  if (!Array.isArray(this.receiver)) {
    this.receiver = [this.receiver];
  }

  next();
});

module.exports = mongoose.model("AssignmentMessage", AssignmentMessageSchema);
