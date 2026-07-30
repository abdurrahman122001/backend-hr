// Who sends these client replies, and what client-contact context got stored?
require("dotenv").config();
const mongoose = require("mongoose");

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;

  const me = await db
    .collection("employees")
    .findOne(
      { companyEmail: "docs@mavensadvisor.com" },
      { projection: { name: 1, role: 1, isAdmin: 1, owner: 1 } },
    );
  console.log("account:", me);

  const recent = await db
    .collection("assignmentmessages")
    .find({ client: { $exists: true, $ne: null } })
    .sort({ createdAt: -1 })
    .limit(8)
    .project({
      createdAt: 1,
      sender: 1,
      isFromClient: 1,
      isFromCompanyEmployee: 1,
      clientEmployeeName: 1,
      clientEmployeeEmail: 1,
      senderType: 1,
      subject: 1,
    })
    .toArray();

  const empIds = [...new Set(recent.map((m) => String(m.sender)))];
  const emps = await db
    .collection("employees")
    .find({ _id: { $in: empIds.map((i) => new mongoose.Types.ObjectId(i)) } })
    .project({ name: 1, role: 1 })
    .toArray();
  const byId = Object.fromEntries(emps.map((e) => [String(e._id), e]));

  console.log("\nrecent client messages (newest first):");
  for (const m of recent) {
    const s = byId[String(m.sender)] || {};
    console.log(
      [
        new Date(m.createdAt).toISOString().slice(0, 16),
        `sender=${s.name || m.sender} (role=${s.role || "?"})`,
        `isFromClient=${!!m.isFromClient}`,
        `isFromCompanyEmployee=${!!m.isFromCompanyEmployee}`,
        `clientEmployeeName=${m.clientEmployeeName || "-"}`,
        `senderType=${m.senderType || "-"}`,
      ].join(" | "),
    );
  }

  await mongoose.disconnect();
})().catch(async (e) => {
  console.error("probe failed:", e.message);
  try { await mongoose.disconnect(); } catch {}
});
