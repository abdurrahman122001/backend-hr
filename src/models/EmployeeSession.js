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
    date: { type: String, required: true }, // YYYY-MM-DD format for uniqueness per day
    shiftId: { type: mongoose.Schema.Types.ObjectId, ref: "Shift" },
    shiftName: { type: String },
    shiftStartTime: { type: String }, // HH:mm format
    shiftEndTime: { type: String }, // HH:mm format
    actualLoginTime: { type: String }, // HH:mm format in shift timezone
    actualLogoutTime: { type: String }, // HH:mm format in shift timezone
    totalHours: { type: Number, default: 0 }, // in hours
    status: { 
      type: String, 
      enum: ["present", "late", "half-day", "absent", "early-leave"], 
      default: "present" 
    },
    isAutoLogout: { type: Boolean, default: false },
    isLoginAfter6PM: { type: Boolean, default: false }, // New field to track login after 6 PM
  },
  { timestamps: true }
);

// Compound index to ensure only one active session per employee per day
EmployeeSessionSchema.index({ employeeId: 1, date: 1, active: true }, { unique: true });
EmployeeSessionSchema.index({ employeeId: 1, date: 1 });

module.exports = mongoose.model("EmployeeSession", EmployeeSessionSchema);