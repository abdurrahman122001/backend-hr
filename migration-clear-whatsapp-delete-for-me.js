/**
 * Clear legacy WhatsApp "delete for me" hides.
 * -------------------------------------------
 * `WhatsAppMessage.deletedForUsers` holds the people who hid a message from
 * their own view. Deleting is now only allowed while a message is still pending
 * approval — once it is approved or disapproved neither delete option is offered
 * to anyone, the sender included. Any hide recorded against an approved or
 * disapproved message therefore predates that rule and should no longer apply:
 * this script drops those entries so the messages are visible again to everyone
 * in the thread.
 *
 * Pending / no-approval-flow messages are left alone — those hides are still
 * legitimate under the current rules.
 *
 * Prints what it would change and exits. Pass --apply to actually write, and
 * --all to also clear hides on pending messages (a full reset).
 *
 * Safe to re-run: a second --apply run finds nothing left to do.
 *
 *   node migration-clear-whatsapp-delete-for-me.js                # dry run
 *   node migration-clear-whatsapp-delete-for-me.js --apply        # commit
 *   node migration-clear-whatsapp-delete-for-me.js --apply --all  # commit, every status
 *
 * Point it at another environment by overriding the connection string:
 *
 *   MONGODB_URI="mongodb+srv://…/live-db" node migration-clear-whatsapp-delete-for-me.js
 */
require("dotenv").config();
const mongoose = require("mongoose");
const fs = require("fs");
const path = require("path");

const WhatsAppMessage = require("./src/models/WhatsAppMessage");
const Employee = require("./src/models/Employees");

const MONGODB_URI =
  process.env.MONGODB_URI || "mongodb://localhost:27017/your_db";

const APPLY = process.argv.includes("--apply");
const ALL = process.argv.includes("--all");

async function run() {
  const query = { deletedForUsers: { $exists: true, $ne: [] } };
  if (!ALL) {
    // Only the statuses the current rules say can never be hidden.
    query.approvalStatus = { $in: ["approved", "disapproved"] };
  }

  const affected = await WhatsAppMessage.find(query)
    .select("_id note message sender receiver approvalStatus deletedForUsers createdAt")
    .sort({ createdAt: 1 })
    .lean();

  console.log(
    `Found ${affected.length} message(s) with a "delete for me" hide` +
      (ALL ? "." : " on an approved/disapproved message.")
  );
  if (!affected.length) return;

  // Resolve names once so the report is readable.
  const ids = new Set();
  affected.forEach((m) => {
    if (m.sender) ids.add(String(m.sender));
    (m.deletedForUsers || []).forEach((u) => ids.add(String(u)));
  });
  const people = await Employee.find({ _id: { $in: [...ids] } })
    .select("_id name companyEmail")
    .lean();
  const nameOf = (id) => {
    const p = people.find((x) => String(x._id) === String(id));
    return p ? `${p.name} <${p.companyEmail}>` : `${id} (no longer an employee)`;
  };

  for (const m of affected) {
    console.log(`\n  ${m._id}  [${m.approvalStatus}]  ${m.createdAt.toISOString()}`);
    console.log(`    text     : ${JSON.stringify(String(m.note || m.message || "").slice(0, 80))}`);
    console.log(`    sender   : ${nameOf(m.sender)}`);
    console.log(`    hidden by: ${(m.deletedForUsers || []).map(nameOf).join(" | ")}`);
  }

  if (!APPLY) {
    console.log("\nDry run — nothing written. Re-run with --apply to commit.");
    return;
  }

  // Keep the before-state so the hides can be restored if this was a mistake.
  const backupPath = path.join(
    __dirname,
    `delete-for-me-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.json`
  );
  fs.writeFileSync(
    backupPath,
    JSON.stringify(
      affected.map((m) => ({
        _id: String(m._id),
        deletedForUsers: (m.deletedForUsers || []).map(String),
      })),
      null,
      2
    )
  );
  console.log(`\nBacked up before-state -> ${backupPath}`);

  const res = await WhatsAppMessage.updateMany(
    { _id: { $in: affected.map((m) => m._id) } },
    { $set: { deletedForUsers: [] } },
    { timestamps: false }
  );
  console.log(`Cleared ${res.modifiedCount} of ${res.matchedCount} matched message(s).`);
}

(async () => {
  await mongoose.connect(MONGODB_URI);
  console.log(`Connected to ${mongoose.connection.name}\n`);
  try {
    await run();
  } finally {
    await mongoose.disconnect();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
