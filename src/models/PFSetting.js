const { Schema, model } = require("mongoose");

const PFSettingSchema = new Schema({
  // Tenant key. PF settings are read "latest row wins", so without this every
  // company would share whichever row was updated most recently.
  owner:     { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
  pfRate:    { type: Number, default: 8.33 }, // Default PF % (applies to all unless overridden)
  years:     { type: Number, default: 1 },    // Default number of years
  updatedBy: { type: Schema.Types.ObjectId, ref: "User" }
}, { timestamps: true });

// Supports the "latest setting for this company" lookup used across payroll.
PFSettingSchema.index({ owner: 1, updatedAt: -1 });

module.exports = model("PFSetting", PFSettingSchema);
