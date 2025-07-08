// backend/src/models/FontSetting.js
const mongoose = require("mongoose");

const fontSettingSchema = new mongoose.Schema(
  {
    owner: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, unique: true },
    fontFamily: { type: String, default: "Inter, sans-serif" }
  },
  { timestamps: true }
);

module.exports = mongoose.model("FontSetting", fontSettingSchema);
