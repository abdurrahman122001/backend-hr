// models/Space.js
const mongoose = require("mongoose");
const { Schema } = mongoose;

const TaskSpaceSchema = new Schema(
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

    name: {
      type: String,
      required: true,
    },

    visibleTo: [
      {
        type: Schema.Types.ObjectId,
        ref: "Employee",
      },
    ],
    status: {
      type: String,
      enum: ["todo", "in_progress", "pending", "complete"],
      default: "todo",
    },
    isArchived: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);

module.exports =
  mongoose.models.TaskSpace || mongoose.model("TaskSpace", TaskSpaceSchema);
