// models/Task.js
const mongoose = require("mongoose");
const { Schema, model } = mongoose;

const AttachmentSchema = new Schema(
  {
    filename: { type: String, required: true },        // stored on disk
    originalName: { type: String, required: true },    // user-facing
    mimetype: { type: String, required: true },
    size: { type: Number, required: true },
    url: { type: String, required: true },             // public URL (/uploads/…)
    uploadedBy: { type: Schema.Types.ObjectId, ref: "Employee", required: true },
    uploadedAt: { type: Date, default: Date.now },
  },
  { _id: true }
);

const TaskSchema = new Schema(
  {
    owner: { type: Schema.Types.ObjectId, ref: "User", required: true },
    client: { type: Schema.Types.ObjectId, ref: "ClientInfo", required: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "Employee", required: true },
    assignedTo: { type: Schema.Types.ObjectId, ref: "Employee" },

    title: { type: String, required: true, trim: true },
    description: { type: String, default: "" },
    priority: { type: String, enum: ["low", "medium", "high", "urgent"], default: "medium" },
    status: { type: String, enum: ["todo", "in_progress", "review", "done"], default: "todo" },
    dueDate: { type: Date },

    attachments: { type: [AttachmentSchema], default: [] }, // ⬅️ NEW
  },
  { timestamps: true }
);

module.exports = model("Task", TaskSchema);
