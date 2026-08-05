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
    // "client" when the message arrived via email from the client — in that case
    // `sender` holds a ClientInfo id and populate("sender") returns null; the UI
    // must fall back to clientEmployeeName / clientName for display.
    senderType: {
      type: String,
      enum: ["employee", "client"],
      default: "employee",
    },
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

    // Forwarded message: delivered ONLY to its explicit receivers, never
    // shared org-wide / by role hierarchy / to everyone assigned to the client.
    isForward: {
      type: Boolean,
      default: false,
    },

    /**
     * A copy of an earlier message, duplicated into a forward's own thread so
     * the recipient receives the whole conversation rather than one orphaned
     * message.
     *
     * These carry their ORIGINAL sender so the transcript reads correctly, which
     * means every list query keyed on `sender` (the Sent folder above all) would
     * otherwise show them to people who never sent them, and the client-scoped
     * Client Box would show the client's mail twice. So: list queries exclude
     * them, and only the thread view (getMessagesByThread) reads them back.
     */
    isForwardedCopy: {
      type: Boolean,
      default: false,
      index: true,
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
    // Set when a CRM-access user picked a specific isAdmin colleague in the
    // composer's "From" field, so `sender` is that colleague rather than the
    // person typing.
    //
    // The UI otherwise assumes any CRM/manager message inside a client thread
    // REPRESENTS the client, and swaps in the client's name and photo purely
    // from the sender's role. That assumption is wrong here — an explicit
    // internal identity was chosen — and `isFromClient: false` alone cannot
    // distinguish this case from an ordinary message. Hence an explicit flag.
    sentOnBehalfOfAdmin: {
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
    // Carbon copy, listed as its own field rather than folded into `cc`.
    //
    // NOTE: by product decision this is NOT blind — every viewer of the message
    // sees the BCC list, the same way they see `cc`. Both fields are therefore
    // normally selectable and are returned on every read path. If BCC ever has
    // to become genuinely blind again, the change is to mark both `select:
    // false` and disclose them only to the sender; delivery would be unaffected
    // because that works off `bccReceiver` matching, not projection.
    bcc: {
      type: [
        {
          _id: false,
          email: { type: String, trim: true, lowercase: true },
          name: { type: String, trim: true },
          addedAt: { type: Date, default: Date.now },
        },
      ],
      default: [],
    },
    // Internal employees resolved from `bcc`. Kept OUT of `receiver` so the To
    // list stays exactly who the sender addressed directly; inbox and thread
    // queries match on this field as well, which is how delivery reaches BCC'd
    // employees. Populated on read so the UI can show their real identity
    // (company email, name) instead of just the typed address.
    bccReceiver: {
      type: [{ type: Schema.Types.ObjectId, ref: "Employee" }],
      default: [],
      index: true,
    },
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
    // PER-USER trash: the employees who moved this message to their Bin. Only
    // they see it in the Bin tab; everyone else still sees it normally.
    trashedBy: [{ type: Schema.Types.ObjectId, ref: "Employee" }],
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
    // Tracks each approval step taken (one entry per approver who clicked approve)
    approvalChain: {
      type: [
        {
          approver: { type: Schema.Types.ObjectId, ref: "Employee" },
          approvedAt: { type: Date },
          hierarchyLevel: { type: Number },
          _id: false,
        },
      ],
      default: [],
    },
    // Full ordered approval chain (set at message creation): displayed in Message Info
    plannedApprovalChain: {
      type: [{ type: Schema.Types.ObjectId, ref: "Employee" }],
      default: [],
    },
    resubmittedAt: { type: Date },
    lastEditedBy: { type: Schema.Types.ObjectId, ref: "Employee" },
    lastEditedAt: { type: Date },
    attachments: [AttachmentSchema],
    emailMetadata: {
      messageId: String,
      from: String,
      fromName: String,
      to: String,
      date: Date,
      cc: [String],
      bcc: [String],
      // RFC-2822 threading headers so replies stay in the same email thread
      inReplyTo: String,
      references: String,
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

// Compound indexes for common inbox/sent/trash query patterns (major perf boost)
AssignmentMessageSchema.index({ owner: 1, isTrashed: 1, isSpam: 1, createdAt: -1 });
AssignmentMessageSchema.index({ receiver: 1, isTrashed: 1, isSpam: 1, createdAt: -1 });
AssignmentMessageSchema.index({ owner: 1, approvalStatus: 1, createdAt: -1 });
AssignmentMessageSchema.index({ sender: 1, isTrashed: 1, isSpam: 1, createdAt: -1 });

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
  // Drafts don't need a receiver yet
  if (this.status === "draft") return next();

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
