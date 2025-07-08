// backend/src/models/Designation.js
const { Schema, model } = require("mongoose");
const DesignationSchema = new Schema({
  owner: { type: Schema.Types.ObjectId, ref: "User", required: true },
  name: { type: String, required: true, unique: true, trim: true },
  department: { type: Schema.Types.ObjectId, ref: "Department", default: null }, // This is your link
}, { timestamps: true });
module.exports = model("Designation", DesignationSchema);
