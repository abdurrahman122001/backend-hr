const mongoose = require("mongoose");
const { Schema, model } = mongoose;

const WarningConfigSchema = new Schema(
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

    description: {
      type: String,
      trim: true,
    },

    maxWarnings: {
      type: Number,
      required: true,
      min: 1,
      default: 3,
    },

    penaltyAmount: {
      type: Number,
      required: true,
      min: 0,
      default: 200,
    },

    severity: {
      type: String,
      enum: ["low", "medium", "high"],
      required: true,
      default: "medium",
    },

    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

// Prevent duplicate warning names for same owner
WarningConfigSchema.index({ owner: 1, name: 1 }, { unique: true });

module.exports = model("WarningConfig", WarningConfigSchema);