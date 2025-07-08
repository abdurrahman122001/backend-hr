const mongoose = require("mongoose");

const SalarySettingsSchema = new mongoose.Schema(
  {
    owner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true, // one settings doc per user
    },
    enabledPersonalFields: { type: [String], default: [] },
    enabledEmploymentFields: { type: [String], default: [] },
    enabledSalaryFields: {
      type: [String],
      default: [], // start empty
    },
    enabledDeductionFields: {
      type: [String],
      default: [],
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("SalarySettings", SalarySettingsSchema);
