// One-off backfill: give every ACTIVE client a Google-Chat space.
//
// Space name  = client business name (legalBusinessName, falling back to
//               clientName when no business name is set).
// Members     = assigned employees
//             + each assignee's IMMEDIATE hierarchy senior (the approver
//               their messages route to — NOT the whole supervisedBy list or
//               the full senior/junior chain)
//             + everyone with CRM access (active CRMAccess grants + rootManager).
//
// Additive only — existing spaces just gain any missing members, so the
// script is safe to re-run.
//
// Run from backend/:  node backfill-client-spaces.js
const mongoose = require("mongoose");
require("dotenv").config();

const ClientInfo = require("./src/models/ClientInfo");
const EmployeeHierarchy = require("./src/models/EmployeeHierarchy");
// Register schemas referenced by name in populate() calls elsewhere.
require("./src/models/Employees");
require("./src/models/Users");
const { Conversation, Space } = require("./src/models/Chat");
const { getCrmUserIds } = require("./src/utils/crmAccess");

const isObjId = (v) => mongoose.Types.ObjectId.isValid(String(v || ""));

/** Direct hierarchy senior(s) of an employee — the approval target. */
async function getImmediateSeniors(ownerId, employeeId) {
  if (!isObjId(ownerId) || !isObjId(employeeId)) return [];
  const links = await EmployeeHierarchy.find({
    owner: ownerId,
    junior: employeeId,
  })
    .select("senior")
    .lean();
  return links.map((l) => String(l.senior));
}

/** assignees + their immediate seniors + CRM users, deduped. */
async function resolveMembers(client, crmIds) {
  const memberIds = new Set();
  const add = (v) => {
    const id = String(v && v._id ? v._id : v || "");
    if (isObjId(id)) memberIds.add(id);
  };

  (client.assignedTo || []).forEach(add);
  for (const assignee of client.assignedTo || []) {
    (await getImmediateSeniors(client.owner, assignee)).forEach(add);
  }
  crmIds.forEach(add);

  return [...memberIds];
}

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
    const name = String(
      client.legalBusinessName || client.clientName || ""
    ).trim();
    const label = name || String(client._id);
    try {
      const crmIds = await crmIdsFor(client.owner);
      const members = await resolveMembers(client, crmIds);

      // Space creator/admin: whoever created the client, else the first CRM
      // user, else the first assigned employee.
      const creatorId =
        client.createdBy || crmIds[0] || (client.assignedTo || [])[0];
      if (!name || !isObjId(creatorId)) {
        console.warn(`- ${label}: no name or usable creator/admin, skipped`);
        skipped++;
        continue;
      }

      let space = client.chatSpace
        ? await Space.findById(client.chatSpace)
        : null;

      if (!space) {
        space = new Space({
          name,
          description: `Space for client ${name}`,
          emoji: "🏢",
          createdBy: creatorId,
          admins: [creatorId],
          members,
        });
        await space.save();

        await new Conversation({
          participants: space.members,
          isGroup: true,
          groupName: space.name,
          groupDescription: space.description,
          admins: [creatorId],
          unreadCount: new Map(),
          space: space._id,
        }).save();

        await ClientInfo.updateOne(
          { _id: client._id },
          { $set: { chatSpace: space._id } }
        );

        created++;
        console.log(`✔ ${label}: created space ${space._id} (${members.length} member(s))`);
        continue;
      }

      // Existing space: top up any missing members (additive only).
      const existing = new Set((space.members || []).map(String));
      const missing = members.filter((id) => !existing.has(id));
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
