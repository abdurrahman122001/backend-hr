/**
 * Backfill permanent feedback serial numbers.
 * ------------------------------------------
 * Before this change the "#N" on a feedback card was its position in the
 * current page of the list, so resolving or deleting an item renumbered every
 * item after it. Numbers now live on the document (`Bug.ticketNumber`) and are
 * handed out by FeedbackCounter.
 *
 * This script gives the existing feedback its numbers, oldest first per
 * company, so the historical order everyone is used to is preserved, and then
 * parks each company's counter above its highest number so new feedback
 * continues the sequence.
 *
 * Safe to re-run: documents that already have a number are left alone.
 *
 *   node migration-backfill-feedback-ticket-numbers.js
 */
require("dotenv").config();
const mongoose = require("mongoose");

const Bug = require("./src/models/Bug");
const Employee = require("./src/models/Employees");
const FeedbackCounter = require("./src/models/FeedbackCounter");

const MONGODB_URI =
  process.env.MONGODB_URI || "mongodb://localhost:27017/your_db";

const NO_OWNER = "__none__";

async function backfill() {
  const bugs = await Bug.find({})
    .select("_id reportedBy owner ticketNumber createdAt")
    .sort({ createdAt: 1, _id: 1 })
    .lean();

  console.log(`Found ${bugs.length} feedback item(s).`);
  if (!bugs.length) return;

  // Resolve the company for every reporter in one pass.
  const reporterIds = [
    ...new Set(bugs.filter((b) => b.reportedBy).map((b) => String(b.reportedBy))),
  ];
  const employees = await Employee.find({ _id: { $in: reporterIds } })
    .select("_id owner")
    .lean();
  const ownerByReporter = new Map(
    employees.map((e) => [String(e._id), e.owner ? String(e.owner) : null])
  );

  // Existing numbers per company become the floor for the counter.
  const highestByOwner = new Map();
  const pending = new Map(); // ownerKey -> bugs still needing a number

  for (const bug of bugs) {
    const ownerKey =
      (bug.owner && String(bug.owner)) ||
      ownerByReporter.get(String(bug.reportedBy)) ||
      NO_OWNER;

    if (typeof bug.ticketNumber === "number") {
      highestByOwner.set(
        ownerKey,
        Math.max(highestByOwner.get(ownerKey) || 0, bug.ticketNumber)
      );
      continue;
    }

    if (!pending.has(ownerKey)) pending.set(ownerKey, []);
    pending.get(ownerKey).push(bug);
  }

  const ops = [];
  for (const [ownerKey, list] of pending) {
    let seq = highestByOwner.get(ownerKey) || 0;
    for (const bug of list) {
      seq += 1;
      ops.push({
        updateOne: {
          filter: { _id: bug._id },
          update: {
            $set: {
              ticketNumber: seq,
              owner: ownerKey === NO_OWNER ? null : ownerKey,
            },
          },
        },
      });
    }
    highestByOwner.set(ownerKey, seq);
  }

  if (ops.length) {
    const result = await Bug.bulkWrite(ops, { ordered: false });
    console.log(`✔ Numbered ${result.modifiedCount} feedback item(s).`);
  } else {
    console.log("✔ Every feedback item already has a number.");
  }

  // Park each counter at or above the highest number in use, so the next
  // report continues the sequence instead of reusing a number.
  for (const [ownerKey, highest] of highestByOwner) {
    if (ownerKey === NO_OWNER) continue;
    const counter = await FeedbackCounter.findOne({ owner: ownerKey }).lean();
    if (!counter || (counter.seq || 0) < highest) {
      await FeedbackCounter.updateOne(
        { owner: ownerKey },
        { $set: { seq: highest } },
        { upsert: true }
      );
      console.log(`  counter for owner ${ownerKey} set to ${highest}`);
    }
  }
}

(async () => {
  try {
    console.log("Connecting to MongoDB...");
    await mongoose.connect(MONGODB_URI);
    console.log("✔ Connected.");

    await backfill();

    console.log("🎉 Feedback serial-number backfill complete.");
    await mongoose.disconnect();
    process.exit(0);
  } catch (error) {
    console.error("❌ Migration failed:", error);
    process.exit(1);
  }
})();
