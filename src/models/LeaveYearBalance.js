const mongoose = require("mongoose");
const { Schema, model } = mongoose;

const LeaveYearBalanceSchema = new Schema(
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

    year: {
      type: Number,
      required: true,
      index: true,
    },

    total: {
      type: Number,
      default: 0,
    },

    bonus: {
      type: Number,
      default: 0,
    },
    bonusHoursAccumulated: {
      type: Number,
      default: 0,
    },

    usedPaid: {
      type: Number,
      default: 0,
    },

    usedUnpaid: {
      type: Number,
      default: 0,
    },

    remainingPaid: {
      type: Number,
      default: 0,
    },

    lastRecalculatedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

LeaveYearBalanceSchema.index(
  { owner: 1, employee: 1, year: 1 },
  { unique: true }
);

LeaveYearBalanceSchema.pre("save", function (next) {
  this.remainingPaid = (this.total + this.bonus) - this.usedPaid;
  next();
});

module.exports = model("LeaveYearBalance", LeaveYearBalanceSchema);
