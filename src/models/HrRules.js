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
    minimumHalfDayPresenceHours: {
      type: Number,
      default: 3,
    },
    nonWorkingDays: {
      type: [String],
      enum: ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"],
    },
    lateMarksForDayOff: {
      type: Number,
      default: 3,
    },
    probationMonths: {
      type: Number,
      default: 3,
    },
    probationExtensionMonths: {
      type: Number,
      default: 3,
    },
    noticePeriodDays: {
      type: Number,
      default: 30,
    },
    annualPaidLeaves: {
      type: Number,
      default: 22,
    },
    leaveApprovalNoticeDays: {
      type: Number,
      default: 7,
    },
    dressCode: {
      type: String,
      default: "",
    },
    checkedPoints: {
      type: [String],
      default: ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13"]
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("HrRules", hrRulesSchema);