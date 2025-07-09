const { Schema, model } = require("mongoose");

const PFSettingSchema = new Schema({
  pfRate:    { type: Number, default: 8.33 }, // Default PF % (applies to all unless overridden)
  years:     { type: Number, default: 1 },    // Default number of years
  updatedBy: { type: Schema.Types.ObjectId, ref: "User" }
}, { timestamps: true });

module.exports = model("PFSetting", PFSettingSchema);
