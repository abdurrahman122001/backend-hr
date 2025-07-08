const mongoose = require("mongoose");

const ProbationPeriodSchema = new mongoose.Schema({
  days: { type: Number, required: true, min: 30 },
  // By default, these benefits are applied after probation
  leaveAfterProbation: { type: Boolean, default: true },
  providentFundAfterProbation: { type: Boolean, default: true },
  gratuityFundAfterProbation: { type: Boolean, default: true },
  // Optionally allow during probation
  leaveDuringProbation: { type: Boolean, default: false },
  providentFundDuringProbation: { type: Boolean, default: false },
  gratuityFundDuringProbation: { type: Boolean, default: false },
  owner: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
}, { timestamps: true });

module.exports = mongoose.model("ProbationPeriod", ProbationPeriodSchema);
