const mongoose = require("mongoose");
const { Schema, model } = mongoose;

const EmployeeWarningSchema = new Schema(
  {
    owner: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    employee: {
      type: Schema.Types.ObjectId,
      ref: "Employee",
      required: true,
      index: true,
    },

    warning: {
      type: Schema.Types.ObjectId,
      ref: "WarningConfig",
      required: true,
    },

    reportedBy: {
      type: Schema.Types.ObjectId,
      ref: "Employee",
      default: null,
    },

    reason: {
      type: String,
      required: true,
      trim: true,
    },

    notes: {
      type: String,
      trim: true,
    },

    status: {
      type: String,
      enum: ["active", "resolved"],
      default: "active",
    },
  },
  { timestamps: true }
);

// Index for counting warnings per employee per warning type
EmployeeWarningSchema.index({ 
  owner: 1, 
  employee: 1, 
  warning: 1, 
  status: 1 
});

module.exports = model("EmployeeWarning", EmployeeWarningSchema);