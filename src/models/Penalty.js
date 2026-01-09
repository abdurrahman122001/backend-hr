const mongoose = require("mongoose");
const { Schema, model } = mongoose;

const PenaltySchema = new Schema(
  {
    owner: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    employee: {
      type: Schema.Types.ObjectId,
      ref: "Employee",
      required: true,
      index: true,
    },

    reportedBy: {
      type: Schema.Types.ObjectId,
      ref: "Employee",
      default: null,
    },

    isAnonymous: {
      type: Boolean,
      default: false,
    },

    severity: {
      type: String,
      enum: ["low", "medium", "high"],
      required: true,
    },

    amount: {
      type: Number,
      required: true,
      min: 0,
    },

    reason: {
      type: String,
      required: true,
      trim: true,
    },

    status: {
      type: String,
      enum: ["pending", "approved", "rejected"],
      default: "pending",
      index: true,
    },

    // Link to warning if generated from warning system
    warningGenerated: {
      type: Boolean,
      default: false,
    },
    
    warningConfig: {
      type: Schema.Types.ObjectId,
      ref: "WarningConfig",
    },
    
    warningCount: {
      type: Number,
      default: 0,
    }
  },
  { timestamps: true }
);

module.exports = model("Penalty", PenaltySchema);