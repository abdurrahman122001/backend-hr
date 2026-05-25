const mongoose = require("mongoose");
const bcrypt = require("bcrypt");

const userSchema = new mongoose.Schema(
  {
    username: { type: String, required: true, unique: true },
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    role: {
      type: String,
      enum: ["super-admin", "admin", "hr", "employee"],
      default: "employee",
    },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    owner: { type: mongoose.Schema.Types.ObjectId, ref: "User" }, // For tenant isolation
    resetPasswordToken: { type: String },
    resetPasswordExpires: { type: Date },
    tokenVersion: { type: Number, default: 0 },
    // Two-Factor Authentication
    twoFactorSecret: { type: String, select: false },   // TOTP secret (hidden by default)
    twoFactorEnabled: { type: Boolean, default: false },
    twoFactorPendingSecret: { type: String, select: false }, // secret during setup, before verified
  },
  { timestamps: true }
);

// Pre-save hook to hash password if changed
userSchema.pre("save", async function (next) {
  if (!this.isModified("password")) return next();
  try {
    this.password = await bcrypt.hash(this.password, 10);
    next();
  } catch (err) {
    next(err);
  }
});

// Add comparePassword method
userSchema.methods.comparePassword = function (candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

module.exports = mongoose.model("User", userSchema);
