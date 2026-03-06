const mongoose = require("mongoose");
const { Schema, model } = mongoose;

const LeaveTransactionSchema = new Schema(
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

    leaveYearBalance: {
      type: Schema.Types.ObjectId,
      ref: "LeaveYearBalance",
      required: true,
      index: true,
    },

    year: {
      type: Number,
      required: true,
      index: true,
    },

    date: {
      type: Date,
      required: true,
      index: true,
    },
    type: {
      type: String,
      enum: [
        "PAID_LEAVE_USED",
        "UNPAID_LEAVE_USED",
        "BONUS_EARNED",
        "ADJUSTMENT",
        "PAID_LEAVE_REVERSED",
        "UNPAID_LEAVE_REVERSED",
        "PAID_LEAVE_CREDITED",
      ],
      required: true,
      index: true,
    },

    value: {
      type: Number,
      required: true,
    },

    sourceModel: {
      type: String,
      default: null,
    },

    sourceId: {
      type: Schema.Types.ObjectId,
      default: null,
    },

    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    reason: {
      type: String,
      default: null,
    },
  },
  { timestamps: true }
);

LeaveTransactionSchema.index(
  { owner: 1, employee: 1, year: 1, date: 1 }
);



module.exports = model("LeaveTransaction", LeaveTransactionSchema);
