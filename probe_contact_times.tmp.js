require("dotenv").config();
const mongoose = require("mongoose");

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;
  const client = await db
    .collection("clientinfos")
    .findOne({ _id: new mongoose.Types.ObjectId("6a58c8f6fee0987377cdbeff") });

  const show = (c, where) => {
    // A subdocument _id embeds its creation time, which survives later edits to
    // the fields — unlike addedAt, which the form may rewrite.
    const oidTime = c._id ? new Date(c._id.getTimestamp()).toISOString().slice(0, 16) : "?";
    console.log(
      `${where.padEnd(18)} name="${c.name}" email="${c.email || "-"}" ` +
        `addedAt=${c.addedAt ? new Date(c.addedAt).toISOString().slice(0, 16) : "-"} ` +
        `_id_created=${oidTime}`,
    );
  };

  for (const c of client.companyEmployees || []) show(c, "client-level");
  for (const b of client.businesses || [])
    for (const c of b.companyEmployees || []) show(c, `biz:${b.businessName}`);

  console.log("\nclient doc updatedAt:", client.updatedAt);
  console.log("the messages in question were sent 2026-07-30T12:29 - 12:31 UTC");

  await mongoose.disconnect();
})().catch(async (e) => {
  console.error("probe failed:", e.message);
  try { await mongoose.disconnect(); } catch {}
});
