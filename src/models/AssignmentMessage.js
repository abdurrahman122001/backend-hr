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
    sender:   { type: Schema.Types.ObjectId, ref: "Employee", required: true },
    receiver: { type: Schema.Types.ObjectId, ref: "Employee", required: true },

    // Content
    subject: { type: String },
    note:    { type: String },

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
AssignmentMessageSchema.index({ client: 1, sender: 1, receiver: 1, createdAt: -1 });

module.exports = mongoose.model("AssignmentMessage", AssignmentMessageSchema);
