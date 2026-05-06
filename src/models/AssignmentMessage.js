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
    owner: { type: Schema.Types.ObjectId, ref: "User", required: true },
    client: {
      type: Schema.Types.ObjectId,
      ref: "ClientInfo",
      required: false,
    },
    threadId: {
      type: String,
      index: true,
    },
    sender: { type: Schema.Types.ObjectId, ref: "Employee", required: true },
    receiver: [
      { type: Schema.Types.ObjectId, ref: "Employee" },
    ],
    subject: { type: String },
    note: { type: String },
    approvalStatus: {
      type: String,
      enum: ["pending", "approved", "disapproved"],
      default: null,
    },

    // New fields for tracking client/company employee messages
    isFromClient: {
      type: Boolean,
      default: false,
    },
    isFromCompanyEmployee: {
      type: Boolean,
      default: false,
    },
    clientEmployeeName: {
      type: String,
    },
    clientEmployeeEmail: {
      type: String,
    },
    clientName: {
      type: String,
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
    cc: [
      {
        email: {
          type: String,
          // required: true, // Remove this temporarily for testing
          trim: true,
          lowercase: true,
        },
        name: {
          type: String,
          trim: true,
        },
        addedAt: {
          type: Date,
          default: Date.now,
        },
      },
    ],
    labels: [
      {
        label: {
          type: Schema.Types.ObjectId,
          ref: "EmailLabel",
          required: true,
        },
        appliedAt: {
          type: Date,
          default: Date.now,
        },
        appliedBy: {
          type: Schema.Types.ObjectId,
          ref: "Employee",
        },
      },
    ],

    isTrashed: { type: Boolean, default: false },
    trashedAt: { type: Date },
    trashedBy: { type: Schema.Types.ObjectId, ref: "Employee" },
    readBy: [
      {
        employee: {
          type: Schema.Types.ObjectId,
          ref: "Employee",
          required: true,
        },
        readAt: { type: Date, default: Date.now },
      },
    ],
    isSpam: { type: Boolean, default: false },
    spamReportedAt: { type: Date },
    spamReportedBy: { type: Schema.Types.ObjectId, ref: "Employee" },
    spamReportCount: { type: Number, default: 0 },
    spamReporters: [{ type: Schema.Types.ObjectId, ref: "Employee" }],
    intendedRecipients: [
      { type: Schema.Types.ObjectId, ref: "Employee" }
    ],
    approvedAt: { type: Date },
    approvedBy: { type: Schema.Types.ObjectId, ref: "Employee" },
    disapprovalNote: { type: String },
    disapprovedAt: { type: Date },
    disapprovedBy: { type: Schema.Types.ObjectId, ref: "Employee" },
    resubmittedAt: { type: Date },
    lastEditedBy: { type: Schema.Types.ObjectId, ref: "Employee" },
    lastEditedAt: { type: Date },
    attachments: [AttachmentSchema],
    emailMetadata: {
      messageId: String,
      from: String,
      to: String,
      date: Date,
      cc: [String],
      bcc: [String],
      headers: Schema.Types.Mixed, // Store full headers if needed
    },

    // Add source field to distinguish between manual and email messages
    source: {
      type: String,
      enum: ["manual", "email", "system"],
      default: "manual",
    },
    replyTo: {
      type: Schema.Types.ObjectId,
      ref: "AssignmentMessage",
      default: null,
    },
    isHrPolicy: { type: Boolean, default: false },
    isSystemMessage: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// Indexes
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
// New indexes for client/company employee tracking
AssignmentMessageSchema.index({ isFromClient: 1, createdAt: -1 });
AssignmentMessageSchema.index({ isFromCompanyEmployee: 1, createdAt: -1 });
AssignmentMessageSchema.index({ clientEmployeeEmail: 1, createdAt: -1 });
AssignmentMessageSchema.index({ "cc.email": 1, createdAt: -1 });

AssignmentMessageSchema.pre("save", function (next) {
  if (!this.threadId) {
    let threadId;

    if (this.client) {
      const clientId = this.client.toString();
      const subject = this.subject || "no_subject";
      const normalizedSubject = subject
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "_")
        .substring(0, 50);
      threadId = `thread_${clientId}_${normalizedSubject}_${Date.now()}`;
    } else if (this.isFromClient || this.isFromCompanyEmployee) {
      // Special thread ID for client/company employee messages
      const subject = this.subject || "external_message";
      const normalizedSubject = subject
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "_")
        .substring(0, 50);

      if (this.clientEmployeeEmail) {
        threadId = `external_${this.clientEmployeeEmail
          }_${normalizedSubject}_${Date.now()}`;
      } else if (this.clientName) {
        threadId = `external_${this.clientName
          }_${normalizedSubject}_${Date.now()}`;
      } else {
        threadId = `external_${normalizedSubject}_${Date.now()}`;
      }
    } else {
      const participants = [
        this.sender.toString(),
        ...this.receiver.map((r) => r.toString()),
      ]
        .sort()
        .join("_")
        .substring(0, 100);

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

AssignmentMessageSchema.pre("save", function (next) {
  if (!this.receiver || this.receiver.length === 0) {
    const error = new Error("At least one receiver is required");
    return next(error);
  }

  if (!Array.isArray(this.receiver)) {
    this.receiver = [this.receiver];
  }

  next();
});

module.exports = mongoose.model("AssignmentMessage", AssignmentMessageSchema);
