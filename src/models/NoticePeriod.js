const mongoose = require("mongoose");

const NoticePeriodSchema = new mongoose.Schema(
  {
    ownerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true, // ensures ONLY ONE universal notice period per owner
    },
    noticePeriodInDays: {
      type: Number,
      required: true,
      default: 30, // you can change this default
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("NoticePeriod", NoticePeriodSchema);
