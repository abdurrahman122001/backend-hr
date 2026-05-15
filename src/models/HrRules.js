const mongoose = require("mongoose");
const { Schema } = mongoose;

const hrRulesSchema = new Schema(
  {
    owner: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    graceMinutes: {
      type: Number,
      default: 0,
    },
    halfDayLateArrivalHours: {
      type: Number,
      default: 4,
    },
    halfDayEarlyDepartureHours: {
      type: Number,
      default: 4,
    },
    applyThreeLatesDeduction: {
      type: Boolean,
      default: false,
    },
    nonWorkingDays: {
      type: [String],
      enum: ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"],
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("HrRules", hrRulesSchema);