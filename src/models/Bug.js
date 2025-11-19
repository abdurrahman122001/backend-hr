const mongoose = require("mongoose");
const { Schema } = mongoose;

const BugSchema = new Schema(
  {
    title: { type: String, required: true },
    description: { type: String, required: true },

    priority: {
      type: String,
      enum: ["low", "medium", "high"],
      default: "medium",
    },

    status: {
      type: String,
      enum: ["open", "pending_approval", "resolved"],
      default: "open",
    },

    reportedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Employee",
      required: true,
    },

    department: {
      type: String,
      required: true,
    },

    approvalRequired: {
      type: Boolean,
      default: false, // set true when R&D resolves
    },

    approvedByReporter: {
      type: Boolean,
      default: false, // reporter approves
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Bug", BugSchema);
