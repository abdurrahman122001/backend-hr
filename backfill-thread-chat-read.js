/**
 * One-time migration for the Google Chat thread-chat unread feature.
 *
 * Older ThreadChatMessage documents predate per-user readBy tracking. This
 * script marks those existing messages as read for every participant they
 * were addressed to, so deploying unread badges does not make old history
 * appear as new unread threads. It is idempotent and does not touch messages
 * that already contain a readBy entry for that employee.
 *
 * Run from backend after loading the normal environment:
 *   node backfill-thread-chat-read.js
 */
require("dotenv").config();
const mongoose = require("mongoose");
const ThreadChatMessage = require("./src/models/ThreadChatMessage");

const uri = process.env.MONGODB_URI || process.env.MONGO_URI;

async function run() {
  if (!uri) {
    throw new Error("MONGODB_URI (or MONGO_URI) is required");
  }

  await mongoose.connect(uri);
  console.log("Connected to MongoDB:", mongoose.connection.name);

  const cursor = ThreadChatMessage.find({
    isDeleted: { $ne: true },
    $or: [
      { readBy: { $exists: false } },
      { readBy: { $size: 0 } },
    ],
  }).select("_id sender receiver readBy").cursor();

  let scanned = 0;
  let updated = 0;
  const now = new Date();

  for await (const message of cursor) {
    scanned += 1;
    const participantIds = new Set();
    if (message.sender) participantIds.add(String(message.sender));
    for (const receiver of message.receiver || []) {
      if (receiver) participantIds.add(String(receiver));
    }

    if (participantIds.size === 0) continue;

    const readBy = [...participantIds].map((employee) => ({
      employee: new mongoose.Types.ObjectId(employee),
      readAt: now,
    }));

    const result = await ThreadChatMessage.updateOne(
      { _id: message._id, $or: [{ readBy: { $exists: false } }, { readBy: { $size: 0 } }] },
      { $set: { readBy } },
    );
    updated += result.modifiedCount || 0;
  }

  console.log(`Thread chat read backfill complete. Scanned: ${scanned}; updated: ${updated}`);
}

run()
  .catch((error) => {
    console.error("Thread chat read backfill failed:", error.message || error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
