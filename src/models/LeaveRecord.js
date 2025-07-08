const mongoose = require("mongoose");

const LeaveBreakupSchema = new mongoose.Schema({
  type: { type: String, required: true },
  entitled: { type: Number, default: 0 },
  availedYTD: { type: Number, default: 0 },
  availedFTM: { type: Number, default: 0 },
  balance: { type: Number, default: 0 },
}, { _id: false });

const LeaveRecordSchema = new mongoose.Schema({
  owner: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, unique: true },
  asBreakup: { type: Boolean, default: false },
  breakups: { type: [LeaveBreakupSchema], default: [] },
  totalEntitled: { type: Number, default: 0 },
  totalAvailedYTD: { type: Number, default: 0 },
  totalAvailedFTM: { type: Number, default: 0 },
  totalBalance: { type: Number, default: 0 },
}, { timestamps: true });

module.exports = mongoose.model("LeaveRecord", LeaveRecordSchema);
