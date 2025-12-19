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

  const EditHistorySchema = new Schema(
    {
      previousMessage: String,
      previousSubject: String,
      previousApprovalStatus: {
        type: String,
        enum: ["pending", "approved", "disapproved", null],
      },
      editedAt: { type: Date, default: Date.now },
      editedBy: { type: Schema.Types.ObjectId, ref: "Employee" },
    },
    { _id: true }
  );

  const WhatsAppMessageSchema = new Schema(
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
        default: null,
      },
      isForwarded: { type: Boolean, default: false },
      originalMessage: { type: Schema.Types.ObjectId, ref: "WhatsAppMessage" },
      forwardedBy: { type: Schema.Types.ObjectId, ref: "Employee" },

      // Edit tracking fields
      isEdited: { type: Boolean, default: false },
      editedAt: { type: Date },
      editedBy: { type: Schema.Types.ObjectId, ref: "Employee" },
      editHistory: [EditHistorySchema],

      // Scheduling fields
      isScheduled: { type: Boolean, default: false },
      scheduledFor: { type: Date }, // When the message should be sent
      scheduledAt: { type: Date }, // When the message was scheduled
      scheduledBy: { type: Schema.Types.ObjectId, ref: "Employee" }, // Who scheduled it
      sentAt: { type: Date }, // When it was actually sent
      status: {
        type: String,
        enum: ["draft", "scheduled", "sent", "cancelled"],
        default: "sent",
      },
      seenBy: [
        {
          employee: { type: Schema.Types.ObjectId, ref: "Employee" },
        },
      ],
      isReply: { type: Boolean, default: false },
      repliedTo: {
        type: Schema.Types.ObjectId,
        ref: "WhatsAppMessage",
        default: null,
      },
      replyContent: {
        type: {
          originalMessage: String,
          originalSender: { type: Schema.Types.ObjectId, ref: "Employee" },
          originalAttachments: [AttachmentSchema],
          preview: String,
        },
        default: null,
      },

      // Files
      attachments: [AttachmentSchema],
    },
    { timestamps: true }
  );

  /** Helpful query patterns */
  WhatsAppMessageSchema.index({ owner: 1, createdAt: -1 });
  WhatsAppMessageSchema.index({ client: 1, createdAt: -1 });
  WhatsAppMessageSchema.index({ sender: 1, createdAt: -1 });
  WhatsAppMessageSchema.index({ receiver: 1, createdAt: -1 });
  WhatsAppMessageSchema.index({ status: 1, scheduledFor: 1 });
  WhatsAppMessageSchema.index({ isScheduled: 1, scheduledFor: 1 });
  WhatsAppMessageSchema.index({ approvalStatus: 1, createdAt: -1 });
  WhatsAppMessageSchema.index({
    client: 1,
    sender: 1,
    receiver: 1,
    createdAt: -1,
  });

  module.exports = mongoose.model("WhatsAppMessage", WhatsAppMessageSchema);
