/**
 * One-off: backfill `location`/`city`/`country` on TrustedDevice docs that
 * don't have it yet, using getGeoFromIp (which falls back to the server's own
 * geo for local/private IPs). Re-runnable.
 *
 * Run:  node backfill-device-geo.js
 */
require("dotenv").config();
const mongoose = require("mongoose");
const TrustedDevice = require("./src/models/TrustedDevice");
const { getGeoFromIp } = require("./src/utils/geoIp");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);

  const devices = await TrustedDevice.find({
    $or: [{ location: { $exists: false } }, { location: null }, { location: "" }],
  });

  let updated = 0;
  for (const d of devices) {
    const geo = await getGeoFromIp(d.ip);
    if (geo && geo.location) {
      d.city = geo.city;
      d.country = geo.country;
      d.location = geo.location;
      await d.save();
      updated++;
    }
    await sleep(300); // stay under ip-api free rate limit (~45/min)
  }

  console.log(`✅ Backfilled location for ${updated}/${devices.length} devices.`);
  await mongoose.disconnect();
})().catch((e) => {
  console.error("❌ Backfill failed:", e);
  process.exit(1);
});
