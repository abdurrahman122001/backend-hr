/**
 * Backfill WhatsAppMessage.originalSentAt.
 *
 * Approval rewrites a message's createdAt to the approval time, which destroys
 * the record of when the sender actually sent it. originalSentAt now preserves
 * that, but messages written before the field existed have no value.
 *
 * What is recoverable:
 *   - Messages that have NOT been approved yet (pending, disapproved, or never
 *     supervised at all). Their createdAt was never rewritten, so it IS the
 *     original send time. These are restored exactly.
 *
 * What is NOT recoverable:
 *   - Already-approved supervised messages. Their createdAt was overwritten in
 *     place and the original is simply gone. For these we fall back to the FIRST
 *     entry in approvalChain (the earliest approval), which is an upper bound on
 *     the send time — closer to the truth than the latest approval time, but not
 *     exact. Pass --skip-approved to leave them untouched instead.
 *
 * Usage:
 *   node backfillWhatsAppOriginalSentAt.js --dry-run
 *   node backfillWhatsAppOriginalSentAt.js
 *   node backfillWhatsAppOriginalSentAt.js --skip-approved
 */

require("dotenv").config();
const mongoose = require("mongoose");
const WhatsAppMessage = require("./src/models/WhatsAppMessage");

const DRY_RUN = process.argv.includes("--dry-run");
const SKIP_APPROVED = process.argv.includes("--skip-approved");

async function main() {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) {
    console.error("No MONGO_URI / MONGODB_URI in environment. Aborting.");
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log(`Connected.${DRY_RUN ? "  [DRY RUN — nothing will be written]" : ""}`);

  const missing = { originalSentAt: { $in: [null, undefined] } };

  // ── 1. Exact restore: never approved, so createdAt is still the real time ──
  const unapproved = {
    ...missing,
    $or: [
      { approvalStatus: { $ne: "approved" } },
      { approvalStatus: null },
      { approvedAt: null },
    ],
  };

  const unapprovedCount = await WhatsAppMessage.countDocuments(unapproved);
  console.log(`\nExact restore (never approved): ${unapprovedCount} message(s)`);

  if (unapprovedCount > 0 && !DRY_RUN) {
    const res = await WhatsAppMessage.collection.updateMany(unapproved, [
      { $set: { originalSentAt: "$createdAt" } },
    ]);
    console.log(`  updated: ${res.modifiedCount}`);
  }

  // ── 2. Best effort: approved, original destroyed, use first approval ──
  const approved = {
    ...missing,
    approvalStatus: "approved",
    approvedAt: { $ne: null },
  };

  const approvedCount = await WhatsAppMessage.countDocuments(approved);
  console.log(
    `\nApproximate (already approved, original lost): ${approvedCount} message(s)`,
  );

  if (SKIP_APPROVED) {
    console.log("  --skip-approved set — leaving these untouched.");
  } else if (approvedCount > 0 && !DRY_RUN) {
    // First approval in the chain when present, else the recorded approvedAt.
    const res = await WhatsAppMessage.collection.updateMany(approved, [
      {
        $set: {
          originalSentAt: {
            $ifNull: [
              { $arrayElemAt: ["$approvalChain.approvedAt", 0] },
              "$approvedAt",
            ],
          },
        },
      },
    ]);
    console.log(`  updated: ${res.modifiedCount} (approximate values)`);
  }

  const remaining = await WhatsAppMessage.countDocuments(missing);
  console.log(`\nStill without originalSentAt: ${remaining}`);

  await mongoose.disconnect();
  console.log("Done.");
}

main().catch(async (err) => {
  console.error("Backfill failed:", err);
  try {
    await mongoose.disconnect();
  } catch {}
  process.exit(1);
});
