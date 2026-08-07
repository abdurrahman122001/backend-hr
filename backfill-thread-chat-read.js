/**
 * One-time migration for read/view badges on Message documents
 * (Conversation-based direct/group chat + Space channels).
 *
 * Deploying per-user readBy/viewedBy tracking makes old history appear as new
 * unread messages, so this script catches every existing message up.
 *
 * It backfills per MISSING PARTICIPANT, not per empty readBy/viewedBy array:
 * a message read by two of its five participants still badges the other
 * three, so skipping any document that already has *any* readBy entry would
 * leave those messages behind. Existing readBy/viewedBy entries are
 * preserved with their original readAt/viewedAt.
 *
 * Audience per message:
 *   - readBy   -> conversation.participants (only when message.conversation
 *                 is set — covers both direct and group conversations).
 *                 The sender is included: a message is trivially "read" by
 *                 its own author.
 *   - viewedBy -> space.members when message.space is set, otherwise
 *                 conversation.participants when message.isGroupMessage is
 *                 true. Mirrors the condition in Message.methods.addView.
 *                 viewCount is recomputed from the resulting array length.
 *
 * Idempotent — a second run updates nothing.
 *
 * Run from backend after loading the normal environment:
 *   node backfill-thread-chat-read.js                        # backfill everything
 *   node backfill-thread-chat-read.js --dry-run               # report only, no writes
 *   node backfill-thread-chat-read.js --before=2026-08-01      # only older messages
 *   node backfill-thread-chat-read.js --employee=<employeeId>  # only that employee's conversations/spaces
 */
require("dotenv").config();
const mongoose = require("mongoose");
const { Message, Conversation, Space } = require("./src/models/Chat");

const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
const BATCH_SIZE = 500;

function readFlag(name) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

const dryRun = process.argv.includes("--dry-run");
const beforeArg = readFlag("before");
const employeeArg = readFlag("employee");

function toObjectId(value) {
  if (!value) return null;
  if (value instanceof mongoose.Types.ObjectId) return value;
  const str = String(value);
  return mongoose.Types.ObjectId.isValid(str) ? new mongoose.Types.ObjectId(str) : null;
}

async function loadAudienceMaps(employeeFilter) {
  const convFilter = employeeFilter ? { participants: employeeFilter } : {};
  const spaceFilter = employeeFilter ? { members: employeeFilter } : {};

  const [conversations, spaces] = await Promise.all([
    Conversation.find(convFilter, { participants: 1 }).lean(),
    Space.find(spaceFilter, { members: 1 }).lean(),
  ]);

  const conversationParticipants = new Map();
  for (const c of conversations) {
    conversationParticipants.set(String(c._id), (c.participants || []).map(String));
  }

  const spaceMembers = new Map();
  for (const s of spaces) {
    spaceMembers.set(String(s._id), (s.members || []).map(String));
  }

  return { conversationParticipants, spaceMembers };
}

async function flush(ops) {
  if (!ops.length) return;
  if (!dryRun) {
    await Message.bulkWrite(ops, { ordered: false });
  }
  ops.length = 0;
}

async function run() {
  if (!uri) {
    throw new Error("MONGODB_URI (or MONGO_URI) is required");
  }

  const employeeFilter = employeeArg ? toObjectId(employeeArg) : null;
  if (employeeArg && !employeeFilter) {
    throw new Error(`--employee must be a valid ObjectId, got "${employeeArg}"`);
  }

  const query = { isDeleted: { $ne: true } };

  if (beforeArg) {
    const before = new Date(beforeArg);
    if (Number.isNaN(before.getTime())) {
      throw new Error(`--before must be a valid date, got "${beforeArg}"`);
    }
    query.createdAt = { $lt: before };
  }

  await mongoose.connect(uri);
  console.log("Connected to MongoDB:", mongoose.connection.name);
  if (dryRun) console.log("DRY RUN — no documents will be modified");

  const { conversationParticipants, spaceMembers } = await loadAudienceMaps(employeeFilter);
  console.log(
    `Loaded ${conversationParticipants.size} conversations, ${spaceMembers.size} spaces` +
      (employeeFilter ? ` (scoped to employee ${employeeFilter})` : "")
  );

  if (employeeFilter) {
    const convIds = [...conversationParticipants.keys()].map(toObjectId);
    const spaceIds = [...spaceMembers.keys()].map(toObjectId);
    query.$or = [{ conversation: { $in: convIds } }, { space: { $in: spaceIds } }];
  }

  const cursor = Message.find(query)
    .select("_id sender conversation space isGroupMessage readBy viewedBy createdAt")
    .lean()
    .cursor();

  let scanned = 0;
  let alreadyComplete = 0;
  let readUpdated = 0;
  let viewUpdated = 0;
  let readEntriesAdded = 0;
  let viewEntriesAdded = 0;
  const ops = [];

  for await (const message of cursor) {
    scanned += 1;

    const senderId = toObjectId(message.sender);
    const senderKey = senderId ? String(senderId) : null;
    const createdAt = message.createdAt || new Date();

    const update = {};
    const push = {};
    const nin = []; // guard fields for the concurrency-safe filter

    // ---- readBy backfill ----
    if (message.conversation) {
      const participantIds = conversationParticipants.get(String(message.conversation)) || [];
      const audience = new Set(participantIds);
      if (senderKey) audience.add(senderKey); // sender always counts as having read it

      const alreadyRead = new Set(
        (message.readBy || []).map((e) => e && e.employee).filter(Boolean).map(String)
      );

      const missing = [...audience].filter((id) => !alreadyRead.has(id));
      if (missing.length > 0) {
        push.readBy = {
          $each: missing.map((employee) => ({ employee: toObjectId(employee), readAt: createdAt })),
        };
        nin.push({ "readBy.employee": { $nin: missing.map(toObjectId) } });
        readUpdated += 1;
        readEntriesAdded += missing.length;
      }
    }

    // ---- viewedBy backfill ----
    if (message.space || message.isGroupMessage) {
      const audienceIds = message.space
        ? spaceMembers.get(String(message.space)) || []
        : conversationParticipants.get(String(message.conversation)) || [];
      const audience = new Set(audienceIds);
      if (senderKey) audience.add(senderKey);

      const alreadyViewed = new Set(
        (message.viewedBy || []).map((e) => e && e.employee).filter(Boolean).map(String)
      );

      const missing = [...audience].filter((id) => !alreadyViewed.has(id));
      if (missing.length > 0) {
        push.viewedBy = {
          $each: missing.map((employee) => ({ employee: toObjectId(employee), viewedAt: createdAt })),
        };
        update.viewCount = alreadyViewed.size + missing.length;
        nin.push({ "viewedBy.employee": { $nin: missing.map(toObjectId) } });
        viewUpdated += 1;
        viewEntriesAdded += missing.length;
      }
    }

    if (Object.keys(push).length === 0 && Object.keys(update).length === 0) {
      alreadyComplete += 1;
      continue;
    }

    const updateDoc = {};
    if (Object.keys(push).length) updateDoc.$push = push;
    if (Object.keys(update).length) updateDoc.$set = update;

    // Merge the per-field $nin guards into a single filter so a concurrent
    // read during the migration can't produce a duplicate readBy/viewedBy entry.
    const filter = { _id: message._id };
    for (const guard of nin) Object.assign(filter, guard);

    ops.push({ updateOne: { filter, update: updateDoc } });

    if (ops.length >= BATCH_SIZE) {
      await flush(ops);
    }

    if (scanned % 20000 === 0) {
      console.log(`  ...scanned ${scanned} messages so far`);
    }
  }

  await flush(ops);

  console.log(
    [
      "Chat read/view backfill complete.",
      `Scanned: ${scanned};`,
      `already fully caught up: ${alreadyComplete};`,
      `messages ${dryRun ? "would update" : "updated"} (readBy): ${readUpdated};`,
      `readBy entries added: ${readEntriesAdded};`,
      `messages ${dryRun ? "would update" : "updated"} (viewedBy): ${viewUpdated};`,
      `viewedBy entries added: ${viewEntriesAdded}`,
    ].join(" ")
  );
}

run()
  .catch((error) => {
    console.error("Chat read/view backfill failed:", error.message || error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });