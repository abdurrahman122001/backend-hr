const mongoose = require("mongoose");
const { Schema } = mongoose;

const WorkspaceSchema = new Schema(
  {
    owner: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    name: {
      type: String,
      required: true,
      trim: true,
    },

    description: String,

    members: [
      {
        employee: {
          type: Schema.Types.ObjectId,
          ref: "Employee",
          required: true,
        },
        role: {
          type: String,
          enum: ["admin", "member"],
          default: "member",
        },
      },
    ],

    isArchived: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);

module.exports =
  mongoose.models.Workspace || mongoose.model("Workspace", WorkspaceSchema);
