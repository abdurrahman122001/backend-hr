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
    owner: { type: Schema.Types.ObjectId, ref: "User", required: true }, // Employee.owner
    manager: { type: Schema.Types.ObjectId, ref: "Employee", required: true },
    client: { type: Schema.Types.ObjectId, ref: "ClientInfo", required: true },
    toEmployee: { type: Schema.Types.ObjectId, ref: "Employee", required: true },
    subject: { type: String },
    note: { type: String },
    attachments: [AttachmentSchema],
  },
  { timestamps: true }
);

// helpful query patterns
AssignmentMessageSchema.index({ client: 1, toEmployee: 1, createdAt: -1 });
AssignmentMessageSchema.index({ manager: 1, createdAt: -1 });
AssignmentMessageSchema.index({ owner: 1, createdAt: -1 });

module.exports = mongoose.model("AssignmentMessage", AssignmentMessageSchema);
