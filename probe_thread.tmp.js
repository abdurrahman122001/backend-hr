// Walk one thread to see whether the wrong contact name is inherited or written.
require("dotenv").config();
const mongoose = require("mongoose");

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;
  const col = db.collection("assignmentmessages");

  const newest = await col
    .find({ client: { $exists: true, $ne: null }, clientEmployeeName: "Abdur Rahman" })
    .sort({ createdAt: -1 })
    .limit(1)
    .toArray();
  if (!newest.length) return console.log("no matching message");

  const threadId = newest[0].threadId;
  console.log("threadId:", threadId, "\n");

  const msgs = await col
    .find({ threadId })
    .sort({ createdAt: 1 })
    .project({
      createdAt: 1,
      sender: 1,
      senderType: 1,
      isFromClient: 1,
      isFromCompanyEmployee: 1,
      clientEmployeeName: 1,
      clientEmployeeEmail: 1,
      source: 1,
      inboundMessageId: 1,
    })
    .toArray();

  const ids = [...new Set(msgs.map((m) => String(m.sender)).filter((x) => x && x !== "undefined"))];
  const emps = await db
    .collection("employees")
    .find({ _id: { $in: ids.map((i) => new mongoose.Types.ObjectId(i)) } })
    .project({ name: 1, role: 1 })
    .toArray();
  const byId = Object.fromEntries(emps.map((e) => [String(e._id), e]));

  for (const m of msgs) {
    const s = byId[String(m.sender)] || {};
    console.log(
      [
        new Date(m.createdAt).toISOString().slice(0, 16),
        `sender=${s.name || m.sender}`,
        `fromClient=${!!m.isFromClient}`,
        `fromCompEmp=${!!m.isFromCompanyEmployee}`,
        `ceName=${m.clientEmployeeName || "-"}`,
        `ceEmail=${m.clientEmployeeEmail || "-"}`,
        m.inboundMessageId ? "INBOUND" : "",
      ].join(" | "),
    );
  }

  await mongoose.disconnect();
})().catch(async (e) => {
  console.error("probe failed:", e.message);
  try { await mongoose.disconnect(); } catch {}
});
