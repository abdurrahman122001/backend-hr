// models/Task.js
const mongoose = require("mongoose");
const { Schema, model } = mongoose;

const TaskSchema = new Schema(
  {
    owner: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    workspace: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
      index: true,
    },

    space: {
      type: Schema.Types.ObjectId,
      ref: "Space",
      required: true,
      index: true,
    },

    title: {
      type: String,
      required: true,
      trim: true,
    },

    description: String,

    status: {
      type: String,
      enum: ["pending", "in_progress", "review_approved", "closed"],
      default: "pending",
    },

    priority: {
      type: String,
      enum: ["low", "medium", "high", "urgent"],
      default: "medium",
    },

    assignees: [
      {
        type: Schema.Types.ObjectId,
        ref: "Employee",
      },
    ],
    dueDate: Date,

    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "Employee",
      required: true,
    },
  },
  { timestamps: true }
);

TaskSchema.index({ owner: 1, space: 1 });

module.exports = mongoose.models.Task || mongoose.model("Task", TaskSchema);
