const mongoose = require("mongoose");

const EmployeeSessionSchema = new mongoose.Schema(
  {
    employeeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Employee",
      required: true,
    },
    loginTime: { type: Date, default: Date.now },
    logoutTime: { type: Date },
    deviceFingerprint: { type: String },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model("EmployeeSession", EmployeeSessionSchema);
