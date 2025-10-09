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
    client: { type: Schema.Types.ObjectId, ref: "ClientInfo", required: true },

    // Participants
    sender: { type: Schema.Types.ObjectId, ref: "Employee", required: true },
    receiver: [
      { type: Schema.Types.ObjectId, ref: "Employee", required: true },
    ], // Array of receivers

    subject: { type: String },
    note: { type: String },
    approvalStatus: {
      type: String,
      enum: ["pending", "approved", "disapproved"],
      default: null
    },

    // Scheduling fields
    isScheduled: { type: Boolean, default: false },
    starred: {
      type: Boolean,
      default: false
    },
    starredBy: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: "Employee"
    }],
    scheduledFor: { type: Date }, // When the message should be sent
    scheduledAt: { type: Date }, // When the message was scheduled
    scheduledBy: { type: Schema.Types.ObjectId, ref: "Employee" }, // Who scheduled it
    sentAt: { type: Date }, // When it was actually sent
    status: {
      type: String,
      enum: ["draft", "scheduled", "sent", "cancelled"],
      default: "sent"
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
    // Files
    attachments: [AttachmentSchema],
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
AssignmentMessageSchema.index({
  client: 1,
  sender: 1,
  receiver: 1,
  createdAt: -1,
});

module.exports = mongoose.model("AssignmentMessage", AssignmentMessageSchema);