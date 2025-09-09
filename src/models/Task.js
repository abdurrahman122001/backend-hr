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

// Keep schema + UI + controller in sync:
const TASK_STATUS = ["todo", "in_progress", "blocked", "pending_review", "done"];
const TASK_PRIORITY = ["low", "medium", "high", "urgent"];

const TaskSchema = new Schema(
  {
    owner: { type: Schema.Types.ObjectId, ref: "User", required: true },
    client: { type: Schema.Types.ObjectId, ref: "ClientInfo", required: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "Employee", required: true },
    assignedTo: { type: Schema.Types.ObjectId, ref: "Employee" },

    title: { type: String, required: true, trim: true },
    description: { type: String, default: "" },

    priority: {
      type: String,
      enum: TASK_PRIORITY,
      default: "medium",
    },

    // IMPORTANT: includes "pending_review" and "blocked"
    status: {
      type: String,
      enum: TASK_STATUS,
      default: "todo",
      set: (v) => (v === "review" ? "pending_review" : v), // map legacy value
    },

    dueDate: { type: Date },

    attachments: { type: [AttachmentSchema], default: [] },
  },
  { timestamps: true }
);

// Extra safety in case status is assigned after setters or via updates
TaskSchema.pre("validate", function (next) {
  if (this.status === "review") this.status = "pending_review";
  next();
});

module.exports = model("Task", TaskSchema);
