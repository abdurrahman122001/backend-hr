// src/models/SpecificNonWorkingDay.js

const { Schema, model } = require("mongoose");

const SpecificNonWorkingDaySchema = new Schema(
  {
    owner: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    date: {
      type: String, // ISO date string: 'YYYY-MM-DD'
      required: true,
    },
    reason: {
      type: String,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

// Index on owner and date for efficient queries
SpecificNonWorkingDaySchema.index({ owner: 1, date: 1 }, { unique: true });

module.exports = model("SpecificNonWorkingDay", SpecificNonWorkingDaySchema);
