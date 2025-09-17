// backend/src/models/EmployeeDoc.js
const mongoose = require("mongoose");

const EmployeeDocSchema = new mongoose.Schema(
  {
    employee: { type: mongoose.Schema.Types.ObjectId, ref: "Employees", required: true, index: true },
    type: {
      type: String,
      enum: ["nda", "contract", "salary_certificate", "experience_letter"],
      required: true,
      index: true,
    },
    data: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

EmployeeDocSchema.index({ employee: 1, type: 1 }, { unique: true });

module.exports = mongoose.model("EmployeeDoc", EmployeeDocSchema);
