require("dotenv").config();
const mongoose = require("mongoose");

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;

  const msg = await db
    .collection("assignmentmessages")
    .findOne(
      { threadId: "thread_hello_worlds_1785348815011", clientEmployeeEmail: "aliahmed@gmail.com" },
      { projection: { client: 1, clientEmployeeName: 1, clientEmployeeEmail: 1 } },
    );
  console.log("message client ref:", msg && msg.client, "\n");

  const client = await db
    .collection("clientinfos")
    .findOne({ _id: msg.client });
  console.log("client:", client.clientName, "| email:", client.clientEmail);

  console.log("\nclient-level contacts:");
  for (const c of client.companyEmployees || []) {
    console.log(`  name="${c.name}" designation="${c.designation}" email="${c.email || "-"}"`);
  }
  for (const b of client.businesses || []) {
    console.log(`\nbusiness "${b.businessName}" (email=${b.email || "-"}) contacts:`);
    for (const c of b.companyEmployees || []) {
      console.log(`  name="${c.name}" designation="${c.designation}" email="${c.email || "-"}"`);
    }
  }

  await mongoose.disconnect();
})().catch(async (e) => {
  console.error("probe failed:", e.message);
  try { await mongoose.disconnect(); } catch {}
});
