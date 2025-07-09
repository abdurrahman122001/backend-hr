const mongoose = require("mongoose");
const { Schema, model } = mongoose;

const GratuitySetting = new Schema({
  owner: { type: Schema.Types.ObjectId, ref: "User", required: true },
  gratuityDaysPaid: { type: Number, default: 21 }, // Default for all employees
  // You can add more company-wide settings here
}, { timestamps: true });

module.exports = model("GratuitySetting", GratuitySetting);
