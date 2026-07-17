// One-off backfill: give every ACTIVE client a Google-Chat space.
//
// Members = assigned employees + the client's supervisedBy list + the full
// supervision chain of each assignee (same resolution the CRM create-client
// flow uses via clientSpaceService) + everyone with CRM access (active
// CRMAccess grants + rootManager).
//
// Additive only — existing spaces just gain any missing members, so the
// script is safe to re-run.
//
// Run from backend/:  node backfill-client-spaces.js
const mongoose = require("mongoose");
require("dotenv").config();

const ClientInfo = require("./src/models/ClientInfo");
const { Conversation, Space } = require("./src/models/Chat");
const {
  createClientSpace,
  resolveClientSpaceMembers,
} = require("./src/services/clientSpaceService");
const { getCrmUserIds } = require("./src/utils/crmAccess");

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log("Connected to MongoDB");

  const clients = await ClientInfo.find({ isActive: { $ne: false } }).lean();
  console.log(`Found ${clients.length} active client(s)`);

  // CRM user ids are per owner — resolve once per org, not per client.
  const crmIdsByOwner = new Map();
  const crmIdsFor = async (ownerId) => {
    const key = String(ownerId);
    if (!crmIdsByOwner.has(key)) {
      crmIdsByOwner.set(key, await getCrmUserIds(ownerId));
    }
    return crmIdsByOwner.get(key);
  };

  let created = 0;
  let membersAdded = 0;
  let skipped = 0;
  let failed = 0;

  for (const client of clients) {
    const label = client.clientName || String(client._id);
    try {
      const crmIds = await crmIdsFor(client.owner);

      // Space creator/admin: whoever created the client, else the first CRM
      // user, else the first assigned employee.
      const creatorId =
        client.createdBy || crmIds[0] || (client.assignedTo || [])[0];
      if (!creatorId) {
        console.warn(`- ${label}: no usable creator/admin found, skipped`);
        skipped++;
        continue;
      }

      let space = client.chatSpace
        ? await Space.findById(client.chatSpace)
        : null;
      if (!space) {
        space = await createClientSpace({ client, creatorId, io: null });
        if (!space) {
          console.error(`✖ ${label}: createClientSpace returned null`);
          failed++;
          continue;
        }
        created++;
      }

      // Desired members: the service's resolution + all CRM users.
      const desired = new Set([
        ...(await resolveClientSpaceMembers(client, space.createdBy || creatorId)),
        ...crmIds.map(String),
      ]);
      const existing = new Set((space.members || []).map(String));
      const missing = [...desired].filter((id) => !existing.has(id));

      if (missing.length > 0) {
        await Space.updateOne(
          { _id: space._id },
          { $addToSet: { members: { $each: missing } } }
        );
        await Conversation.updateOne(
          { space: space._id, isGroup: true },
          { $addToSet: { participants: { $each: missing } } }
        );
        membersAdded += missing.length;
      }

      console.log(
        `✔ ${label}: space ${space._id}` +
          (missing.length ? ` (+${missing.length} member(s))` : " (up to date)")
      );
    } catch (error) {
      failed++;
      console.error(`✖ ${label}:`, error.message);
    }
  }

  console.log(
    `\nDone. Spaces created: ${created}, members added: ${membersAdded}, ` +
      `skipped: ${skipped}, failed: ${failed}`
  );
  await mongoose.disconnect();
  console.log("Disconnected");
}

run().catch((error) => {
  console.error("Backfill failed:", error);
  process.exit(1);
});
