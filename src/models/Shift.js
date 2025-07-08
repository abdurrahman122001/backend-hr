// models/Shift.js
const { Schema, model } = require("mongoose");

const ShiftSchema = new Schema({
  owner:        { type: Schema.Types.ObjectId, ref: 'User', required: true },
  name:         { type: String, required: true },
  timezone:     { type: String, required: true },
  start:        { type: String, required: true }, 
  end:          { type: String, required: true }, 
  graceMinutes: { type: Number }, 
  graceTime:    { type: String },
  isHourly:     { type: Boolean, default: false },
  setHours:     { type: Number },
  allowMultipleShifts: { type: Boolean, default: false },
}, { timestamps: true });

module.exports = model("Shift", ShiftSchema);
