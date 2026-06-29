/**
 * One-off migration: move embedded Employee.trustedDevices[] into the standalone
 * TrustedDevice collection, then $unset the embedded field.
 *
 * Safe to re-run: it skips devices already present (matched by employee +
 * deviceId/deviceFingerprint). Reads the embedded array via the native driver so
 * it still works after the field is removed from the Mongoose schema.
 *
 * Run:  node migrate-trusted-devices.js
 */
require("dotenv").config();
const mongoose = require("mongoose");
const TrustedDevice = require("./src/models/TrustedDevice");

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;

  const employees = await db
    .collection("employees")
    .find({ trustedDevices: { $exists: true, $ne: [] } })
    .toArray();

  let empCount = 0;
  let deviceCount = 0;
  let skipped = 0;

  for (const emp of employees) {
    for (const d of emp.trustedDevices || []) {
      const or = [];
      if (d.deviceId) or.push({ deviceId: d.deviceId });
      if (d.deviceFingerprint) or.push({ deviceFingerprint: d.deviceFingerprint });

      if (or.length) {
        const exists = await TrustedDevice.findOne({ employee: emp._id, $or: or });
        if (exists) {
          skipped++;
          continue;
        }
      }

      await TrustedDevice.create({
        employee: emp._id,
        owner: emp.owner,
        deviceId: d.deviceId,
        deviceFingerprint: d.deviceFingerprint,
        deviceName: d.deviceName,
        userAgent: d.userAgent,
        ip: d.ip,
        addedAt: d.addedAt || emp.createdAt || new Date(),
      });
      deviceCount++;
    }
    empCount++;
  }

  // Remove the now-migrated embedded field from every employee document.
  const unset = await db
    .collection("employees")
    .updateMany(
      { trustedDevices: { $exists: true } },
      { $unset: { trustedDevices: "" } }
    );

  console.log(
    `✅ Migration complete. Employees scanned: ${empCount}, devices migrated: ${deviceCount}, skipped (already migrated): ${skipped}, embedded field removed from: ${unset.modifiedCount} employees.`
  );

  await mongoose.disconnect();
})().catch((e) => {
  console.error("❌ Migration failed:", e);
  process.exit(1);
});
