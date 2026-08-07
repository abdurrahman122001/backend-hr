/**
 * One-time migration for the Google Chat thread-chat unread feature.
 *
 * Older ThreadChatMessage documents predate per-user readBy tracking, so
 * deploying unread badges makes old history appear as new unread threads. This
 * script marks existing messages as read for every participant they were
 * addressed to.
 *
 * Note it backfills per MISSING PARTICIPANT, not per empty readBy array: a
 * message read by two of its five receivers still badges the other three, so
 * skipping any document that already has a readBy entry (the original
 * behaviour) left exactly those messages behind and reported "scanned: 0".
 * Existing readBy entries are preserved with their original readAt.
 *
 * Idempotent — a second run updates nothing.
 *
 * Run from backend after loading the normal environment:
 *   node backfill-thread-chat-read.js               # backfill everything
 *   node backfill-thread-chat-read.js --dry-run     # report only, no writes
 *   node backfill-thread-chat-read.js --before=2026-08-01   # only older messages
 *   node backfill-thread-chat-read.js --owner=<ownerId>     # single org
 */
require("dotenv").config();
const mongoose = require("mongoose");
const ThreadChatMessage = require("./src/models/ThreadChatMessage");

const uri = process.env.MONGODB_URI || process.env.MONGO_URI;

function readFlag(name) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

const dryRun = process.argv.includes("--dry-run");
const beforeArg = readFlag("before");
const ownerArg = readFlag("owner");

function toObjectId(value) {
  if (!value) return null;
  if (value instanceof mongoose.Types.ObjectId) return value;
  const str = String(value);
  return mongoose.Types.ObjectId.isValid(str)
    ? new mongoose.Types.ObjectId(str)
    : null;
}

async function run() {
  if (!uri) {
    throw new Error("MONGODB_URI (or MONGO_URI) is required");
  }

  const query = { isDeleted: { $ne: true } };

  if (beforeArg) {
    const before = new Date(beforeArg);
    if (Number.isNaN(before.getTime())) {
      throw new Error(`--before must be a valid date, got "${beforeArg}"`);
    }
    query.createdAt = { $lt: before };
  }

  if (ownerArg) {
    const owner = toObjectId(ownerArg);
    if (!owner) throw new Error(`--owner must be a valid ObjectId, got "${ownerArg}"`);
    query.owner = owner;
  }

  await mongoose.connect(uri);
  console.log("Connected to MongoDB:", mongoose.connection.name);
  if (dryRun) console.log("DRY RUN — no documents will be modified");

  const cursor = ThreadChatMessage.find(query)
    .select("_id threadId sender receiver readBy")
    .lean()
    .cursor();

  let scanned = 0;
  let alreadyComplete = 0;
  let updated = 0;
  let entriesAdded = 0;
  const threadsTouched = new Set();
  const now = new Date();

  for await (const message of cursor) {
    scanned += 1;

    // Everyone who should count the message as read: the sender (never unread
    // for its author) plus every receiver it was addressed to.
    const participantIds = new Set();
    const sender = toObjectId(message.sender);
    if (sender) participantIds.add(String(sender));
    for (const receiver of message.receiver || []) {
      const id = toObjectId(receiver);
      if (id) participantIds.add(String(id));
    }

    if (participantIds.size === 0) continue;

    const alreadyRead = new Set(
      (message.readBy || [])
        .map((entry) => entry && entry.employee)
        .filter(Boolean)
        .map(String)
    );

    const missing = [...participantIds].filter((id) => !alreadyRead.has(id));
    if (missing.length === 0) {
      alreadyComplete += 1;
      continue;
    }

    entriesAdded += missing.length;
    threadsTouched.add(String(message.threadId));

    if (dryRun) {
      updated += 1;
      continue;
    }

    // $push preserves the readAt of anyone who genuinely read the message; the
    // $nin guard keeps concurrent reads during the migration from duplicating.
    const result = await ThreadChatMessage.updateOne(
      {
        _id: message._id,
        "readBy.employee": { $nin: missing.map(toObjectId) },
      },
      {
        $push: {
          readBy: {
            $each: missing.map((employee) => ({
              employee: toObjectId(employee),
              readAt: now,
            })),
          },
        },
      }
    );
    updated += result.modifiedCount || 0;
  }

  console.log(
    [
      "Thread chat read backfill complete.",
      `Scanned: ${scanned};`,
      `already fully read: ${alreadyComplete};`,
      `${dryRun ? "would update" : "updated"}: ${updated};`,
      `readBy entries added: ${entriesAdded};`,
      `threads touched: ${threadsTouched.size}`,
    ].join(" ")
  );
}

run()
  .catch((error) => {
    console.error("Thread chat read backfill failed:", error.message || error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
