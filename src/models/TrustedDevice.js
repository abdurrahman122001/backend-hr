const mongoose = require("mongoose");
const Schema = mongoose.Schema;

/**
 * Trusted device for an employee — extracted out of the embedded
 * Employee.trustedDevices array into its own collection so devices can be
 * queried/managed independently. One document per (employee, device).
 */
const TrustedDeviceSchema = new Schema(
  {
    employee: {
      type: Schema.Types.ObjectId,
      ref: "Employee",
      required: true,
      index: true,
    },
    owner: { type: Schema.Types.ObjectId, ref: "User" },
    deviceId: { type: String }, // permanent token (browser cookie anchor)
    deviceFingerprint: { type: String },
    deviceName: { type: String }, // friendly device name/model (best-effort)
    userAgent: { type: String },
    ip: { type: String },
    // Best-effort IP geolocation captured at sign-in time.
    city: { type: String },
    country: { type: String },
    location: { type: String }, // display string e.g. "Karachi, Pakistan"
    addedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

TrustedDeviceSchema.index({ employee: 1, deviceFingerprint: 1 });
TrustedDeviceSchema.index({ employee: 1, deviceId: 1 });

module.exports = mongoose.model("TrustedDevice", TrustedDeviceSchema);
