// Google-Chat space lifecycle for CRM clients.
//
// createClientSpace  — on client creation: a space named after the client,
//                      linked back via ClientInfo.chatSpace.
// syncClientSpaceMembers — on assignment/supervision changes: adds the new
//                      assigned + supervising employees to the space
//                      (additive only; members are never auto-removed).
//
// Members = assigned employees + the client's supervisedBy list + every
// supervisor up the EmployeeHierarchy chain of each assigned employee +
// the space creator (admin).
//
// Both entry points are fire-and-safe: failures are logged and swallowed so
// they can never block or fail the CRM request that triggered them.
const mongoose = require("mongoose");
const { Conversation, Space } = require("../models/Chat");
const ClientInfo = require("../models/ClientInfo");
require("../models/Employees");
const EmployeeHierarchy = require("../models/EmployeeHierarchy");
const { syncClientAssignees } = require("../utils/clientAssignees");

const isObjId = (v) => mongoose.Types.ObjectId.isValid(String(v || ""));

/**
 * Walk the EmployeeHierarchy upward from an employee and return every senior
 * in the chain (deduped, cycle-safe).
 */
async function getSupervisionChain(ownerId, employeeId) {
  if (!isObjId(ownerId) || !isObjId(employeeId)) return [];

  const chain = new Set();
  let frontier = [String(employeeId)];
  const visited = new Set(frontier);

  while (frontier.length > 0) {
    const links = await EmployeeHierarchy.find({
      owner: ownerId,
      junior: { $in: frontier },
    })
      .select("senior")
      .lean();

    frontier = [];
    for (const link of links) {
      const seniorId = String(link.senior);
      if (visited.has(seniorId)) continue;
      visited.add(seniorId);
      chain.add(seniorId);
      frontier.push(seniorId);
    }
  }

  return [...chain];
}

/**
 * Resolve the full member list for a client's space.
 */
async function resolveClientSpaceMembers(client, creatorId) {
  const memberIds = new Set();

  const add = (v) => {
    const id = String(v && v._id ? v._id : v || "");
    if (isObjId(id)) memberIds.add(id);
  };

  add(creatorId);
  (client.assignedTo || []).forEach(add);
  (client.supervisedBy || []).forEach(add);

  // Everyone supervising an assigned employee (whole chain up).
  for (const assignee of client.assignedTo || []) {
    const chain = await getSupervisionChain(client.owner, assignee);
    chain.forEach(add);
  }

  return [...memberIds];
}

async function populateSpaceAndConversation(spaceId) {
  return Promise.all([
    Space.findById(spaceId)
      .populate("createdBy", "name companyEmail avatar")
      .populate("admins", "name companyEmail avatar")
      .populate("members", "name companyEmail avatar"),
    Conversation.findOne({ space: spaceId, isGroup: true })
      .populate("participants", "name companyEmail avatar")
      .populate("admins", "name companyEmail avatar"),
  ]);
}

function emitSpaceCreated(io, memberIds, space, conversation, createdBy) {
  if (!io) return;
  const payload = { space, conversation, createdBy: String(createdBy) };
  for (const memberId of memberIds) {
    io.to(`employee_${memberId}`).emit("space_created", payload);
    io.to(`user_${memberId}`).emit("space_created", payload);
  }
}

/**
 * Create the space + its linked group conversation for a client, store the
 * link on the client, and notify members. Returns the space or null.
 */
async function createClientSpace({ client, creatorId, io }) {
  try {
    const name = String(client?.clientName || "").trim();
    if (!name || !isObjId(creatorId)) return null;

    const members = await resolveClientSpaceMembers(client, creatorId);

    const space = new Space({
      name,
      description: `Space for client ${name}`,
      emoji: "🏢",
      createdBy: creatorId,
      admins: [creatorId],
      members,
    });
    await space.save();

    // The linked group conversation is what getSpaces/sendSpaceMessage use
    // for messaging and unread tracking — a space without it is broken.
    const conversation = new Conversation({
      participants: space.members,
      isGroup: true,
      groupName: space.name,
      groupDescription: space.description,
      admins: [creatorId],
      unreadCount: new Map(),
      space: space._id,
    });
    await conversation.save();

    // Link back so later assignment changes can sync this space's members.
    await ClientInfo.updateOne(
      { _id: client._id },
      { $set: { chatSpace: space._id } }
    );

    const [populatedSpace, populatedConversation] =
      await populateSpaceAndConversation(space._id);
    emitSpaceCreated(io, members, populatedSpace, populatedConversation, creatorId);

    return space;
  } catch (error) {
    console.error("createClientSpace error (client request unaffected):", error);
    return null;
  }
}

/**
 * Bring the client's space membership up to date after assignedTo /
 * supervisedBy changed. Creates the space if the client doesn't have one yet
 * (pre-existing clients). Additive only — never removes members.
 */
async function syncClientSpaceMembers({ clientId, actorId, io }) {
  try {
    if (!isObjId(clientId)) return null;

    const client = await ClientInfo.findById(clientId)
      .select("_id clientName owner assignedTo supervisedBy chatSpace")
      .lean();
    if (!client) return null;

    const space = client.chatSpace
      ? await Space.findById(client.chatSpace)
      : null;
    if (!space) {
      return createClientSpace({ client, creatorId: actorId, io });
    }

    const desired = await resolveClientSpaceMembers(
      client,
      space.createdBy || actorId
    );
    const existing = new Set(space.members.map(String));
    const newMembers = desired.filter((id) => !existing.has(id));
    if (newMembers.length === 0) return space;

    await Space.updateOne(
      { _id: space._id },
      { $addToSet: { members: { $each: newMembers } } }
    );
    await Conversation.updateOne(
      { space: space._id, isGroup: true },
      { $addToSet: { participants: { $each: newMembers } } }
    );

    if (io) {
      const [populatedSpace, populatedConversation] =
        await populateSpaceAndConversation(space._id);

      // New members see the space appear in their list.
      emitSpaceCreated(
        io,
        newMembers,
        populatedSpace,
        populatedConversation,
        actorId
      );
      newMembers.forEach((memberId) => {
        io.to(`employee_${memberId}`).emit("added_to_space", {
          space: populatedSpace,
          addedBy: actorId,
          addedAt: new Date(),
        });
      });
      // Existing members refresh the member list.
      io.to(`space_${space._id}`).emit("space_members_updated", {
        spaceId: String(space._id),
        newMembers,
        updatedBy: actorId,
        updatedAt: new Date(),
      });
    }

    return space;
  } catch (error) {
    console.error("syncClientSpaceMembers error (client request unaffected):", error);
    return null;
  }
}

/**
 * The reverse of syncClientSpaceMembers: someone invited into a CLIENT's space
 * is thereby working on that client, so mirror the invite into the client's
 * assignment. Used by the @-mention "Add member & send" flow — inviting a
 * non-member of a client space would otherwise leave them able to read the
 * client's chat while invisible to every other client-keyed surface (WhatsApp
 * lists, email routing, visibility queries).
 *
 * Returns the client whose assignment changed, or null when the space is an
 * ordinary space/group — most are. Fire-and-safe like the rest of this file:
 * a failure here must never fail the invite that triggered it.
 */
async function assignSpaceMembersToClient({ spaceId, employeeIds, io }) {
  try {
    const ids = (employeeIds || []).map(String).filter(isObjId);
    if (!isObjId(spaceId) || ids.length === 0) return null;

    const client = await ClientInfo.findOne({ chatSpace: spaceId });
    if (!client) return null;

    // ClientInfo.assignedTo is DERIVED from businesses[].assignedTo, so the
    // assignment has to be written there. A space belongs to the CLIENT, not to
    // one of its businesses, so being in it means working on all of them.
    let changed = false;
    for (const business of client.businesses || []) {
      const existing = new Set(
        (business.assignedTo || []).map((e) => String(e?._id || e))
      );
      const missing = ids.filter((id) => !existing.has(id));
      if (missing.length === 0) continue;
      business.assignedTo = [...(business.assignedTo || []), ...missing];
      changed = true;
    }

    if ((client.businesses || []).length > 0) {
      syncClientAssignees(client);
    } else {
      // No businesses to derive the union from. syncClientAssignees leaves an
      // empty union alone rather than clearing assignedTo, so writing the
      // client level directly is safe for these (legacy) records.
      const existing = new Set(
        (client.assignedTo || []).map((e) => String(e?._id || e))
      );
      const missing = ids.filter((id) => !existing.has(id));
      if (missing.length > 0) {
        client.assignedTo = [...(client.assignedTo || []), ...missing];
        changed = true;
      }
    }

    if (!changed) return client;
    await client.save();

    if (io) {
      // Same event the CRM assignment panels already listen for, so any open
      // client screen picks the new assignee up without a reload.
      io.to(`owner_${client.owner}`).emit("client_business_assigned", {
        clientId: String(client._id),
        businessId: null,
        businesses: client.businesses,
      });
    }

    return client;
  } catch (error) {
    console.error(
      "assignSpaceMembersToClient error (invite unaffected):",
      error
    );
    return null;
  }
}

module.exports = {
  createClientSpace,
  syncClientSpaceMembers,
  assignSpaceMembersToClient,
  resolveClientSpaceMembers,
  getSupervisionChain,
};
