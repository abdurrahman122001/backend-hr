// controllers/whatsAppGroupController.js
const WhatsAppGroup = require("../models/WhatsAppGroup");
const WhatsAppMessage = require("../models/WhatsAppMessage");
const Employee = require("../models/Employees");
const EmployeeHierarchy = require("../models/EmployeeHierarchy");
const mongoose = require("mongoose");

const isObjId = (v) => mongoose.isValidObjectId(v);
const oid = (v) =>
  mongoose.isValidObjectId(v) ? new mongoose.Types.ObjectId(v) : null;

function normalizeRole(role) {
  if (!role) return "";
  return String(role).toLowerCase().replace(/\s+/g, "_");
}

/** ---------- HIERARCHY HELPER FUNCTIONS ---------- **/

/** Find all immediate supervisors (seniors) of an employee */
async function findSupervisorsInHierarchy(ownerId, employeeId) {
  if (!isObjId(ownerId) || !isObjId(employeeId)) return [];
  try {
    const links = await EmployeeHierarchy.find({
      owner: ownerId,
      junior: employeeId,
    })
      .select("senior")
      .lean();
    return links.map((l) => String(l.senior));
  } catch (err) {
    console.error("Error finding supervisors:", err);
    return [];
  }
}

/** Get the full management chain (all seniors up to root) */
async function getManagementChain(ownerId, employeeId, visited = new Set()) {
  if (!isObjId(ownerId) || !isObjId(employeeId)) return [];
  const idStr = String(employeeId);
  if (visited.has(idStr)) return [];
  visited.add(idStr);

  const supervisors = await findSupervisorsInHierarchy(ownerId, employeeId);
  const chain = [...supervisors];

  for (const supId of supervisors) {
    const upper = await getManagementChain(ownerId, supId, visited);
    chain.push(...upper);
  }

  return [...new Set(chain)];
}

/** ── CREATE GROUP ──────────────────────────────────────────── */
exports.createGroup = async function (req, res) {
  try {
    const { name, description, members } = req.body;

    if (!name || !name.trim())
      return res.status(400).json({ error: "Group name is required" });
    if (!members || !Array.isArray(members) || members.length === 0)
      return res.status(400).json({ error: "At least one member is required" });

    const owner = req.employee?.owner || req.employee?._id;
    const createdBy = req.employee?._id;

    if (!owner || !createdBy)
      return res.status(401).json({ error: "Unauthorized" });

    const memberTypes = [...new Set(members.map((m) => m.memberType))];
    let groupType = "mixed";
    if (memberTypes.length === 1) {
      if (memberTypes[0] === "employee") groupType = "employees_only";
      else if (memberTypes[0] === "client") groupType = "clients_only";
      else if (memberTypes[0] === "client_employee")
        groupType = "client_employees_only";
    }

    const group = new WhatsAppGroup({
      name: name.trim(),
      description: description || "",
      owner,
      createdBy,
      members: members.map((m) => ({ ...m, addedBy: createdBy })),
      groupType,
    });

    await group.save();

    const populated = await WhatsAppGroup.findById(group._id)
      .populate("createdBy", "name companyEmail role")
      .lean();

    const io = req.app.get("io");
    if (io) {
      members.forEach((m) => {
        if (m.memberType === "employee" && isObjId(m.memberId)) {
          io.to(`employee_${m.memberId}`).emit("group_created", populated);
        }
      });
    }

    res.status(201).json(populated);
  } catch (error) {
    console.error("Error creating group:", error);
    res.status(500).json({ error: "Failed to create group" });
  }
};

/** ── LIST GROUPS ────────────────────────────────────────────── */
exports.getGroups = async function (req, res) {
  try {
    const owner = req.employee?.owner || req.employee?._id;
    const currentUserId = String(req.employee._id);
    const currentUserRole = normalizeRole(req.employee?.role || "");
    const isManager = currentUserRole.includes("manager");

    const query = { owner, isActive: true };
    if (!isManager) {
      query["members.memberId"] = currentUserId;
    }

    const groups = await WhatsAppGroup.find(query)
      .populate("createdBy", "name companyEmail role")
      .sort({ updatedAt: -1 })
      .lean();

    res.json(groups);
  } catch (error) {
    console.error("Error fetching groups:", error);
    res.status(500).json({ error: "Failed to fetch groups" });
  }
};

/** ── GET SINGLE GROUP ───────────────────────────────────────── */
exports.getGroup = async function (req, res) {
  try {
    const { groupId } = req.params;
    if (!isObjId(groupId))
      return res.status(400).json({ error: "Invalid group ID" });

    const owner = req.employee?.owner || req.employee?._id;
    const group = await WhatsAppGroup.findOne({
      _id: groupId,
      owner,
      isActive: true,
    })
      .populate("createdBy", "name companyEmail role")
      .lean();

    if (!group) return res.status(404).json({ error: "Group not found" });
    res.json(group);
  } catch (error) {
    console.error("Error fetching group:", error);
    res.status(500).json({ error: "Failed to fetch group" });
  }
};

/** ── GET GROUP MESSAGES ─────────────────────────────────────── */
exports.getGroupMessages = async function (req, res) {
  try {
    const { groupId } = req.params;
    const { limit = 25, cursor, direction = "after" } = req.query;

    if (!isObjId(groupId))
      return res.status(400).json({ error: "Valid group ID is required" });

    const owner = req.employee?.owner || req.employee?._id;

    const group = await WhatsAppGroup.findOne({
      _id: groupId,
      owner,
      isActive: true,
    }).lean();
    if (!group) return res.status(404).json({ error: "Group not found" });

    const me = oid(String(req.employee._id));

    const q = {
      groupId: oid(groupId),
      isGroupMessage: true,
      owner,
      status: { $ne: "draft" },
      // Approval visibility rules:
      // - null / "approved"  → everyone in the group can see
      // - "pending"          → only sender or the designated approver (in receiver[])
      // - "disapproved"      → only the sender
      $or: [
        { approvalStatus: null },
        { approvalStatus: "approved" },
        { approvalStatus: "pending", sender: me },
        { approvalStatus: "pending", receiver: me },
        { approvalStatus: "disapproved", sender: me },
      ],
    };

    if (cursor && isObjId(cursor)) {
      const cursorDoc = await WhatsAppMessage.findById(cursor)
        .select("createdAt")
        .lean();
      if (cursorDoc) {
        q.createdAt =
          direction === "before"
            ? { $lt: cursorDoc.createdAt }
            : { $gt: cursorDoc.createdAt };
      }
    }

    const lim = Math.min(Math.max(parseInt(limit, 10) || 25, 1), 100);

    const items = await WhatsAppMessage.find(q)
      .sort({ createdAt: -1 })
      .limit(lim + 1)
      .populate([
        { path: "sender", select: "_id name companyEmail role" },
        { path: "receiver", select: "_id name companyEmail role" },
        { path: "attachments.uploadedBy", select: "_id name" },
        { path: "repliedTo", select: "_id note message sender" },
      ])
      .lean();

    let hasMore = false;
    if (items.length > lim) {
      hasMore = true;
      items.pop();
    }

    let nextCursor = null;
    if (items.length > 0) {
      nextCursor =
        direction === "before"
          ? items[items.length - 1]?._id
          : items[0]?._id;
    }

    if (!cursor || direction === "after") {
      items.reverse();
    }

    res.json({ items, group, pagination: { hasMore, nextCursor } });
  } catch (error) {
    console.error("Error fetching group messages:", error);
    res.status(500).json({ error: "Failed to fetch group messages" });
  }
};

/** ── SEND GROUP MESSAGE ─────────────────────────────────────── */
exports.sendGroupMessage = async function (req, res) {
  try {
    const { groupId } = req.params;
    const {
      note,
      subject,
      receiverType = "all",
      receiverId,
      parentClientId,
      isReply,
      repliedTo,
      replyContent,
    } = req.body;

    if (!isObjId(groupId))
      return res.status(400).json({ error: "Valid group ID is required" });
    if (!note || !note.trim())
      return res.status(400).json({ error: "Message content is required" });

    const owner = req.employee?.owner || req.employee?._id;
    const senderId = req.employee?._id;
    const senderRole = normalizeRole(req.employee?.role || "");

    const group = await WhatsAppGroup.findOne({
      _id: groupId,
      owner,
      isActive: true,
    }).lean();
    if (!group) return res.status(404).json({ error: "Group not found" });

    // ── All employee member IDs (excluding sender) ─────────────────
    const employeeMembers = group.members.filter(
      (m) => m.memberType === "employee"
    );
    const allMemberIds = employeeMembers
      .map((m) => String(m.memberId))
      .filter((id) => id !== String(senderId));

    // ── Resolve client reference ───────────────────────────────────
    let messageClientId = null;
    let isClientEmployeeMessage = false;
    let clientEmployeeId = null;
    let clientEmployeeData = null;

    if (receiverType === "client" && receiverId && isObjId(receiverId)) {
      messageClientId = oid(receiverId);
    } else if (receiverType === "client_employee" && receiverId) {
      const ceMember = group.members.find(
        (m) => m.memberId === receiverId && m.memberType === "client_employee"
      );
      if (ceMember) {
        const pId = ceMember.parentClientId || parentClientId;
        if (pId && isObjId(pId)) messageClientId = oid(pId);
        isClientEmployeeMessage = true;
        clientEmployeeId = receiverId;
        clientEmployeeData = {
          clientEmployeeId: receiverId,
          clientEmployeeName: ceMember.memberName || "Unknown",
          parentClientId: pId,
          parentClientName: ceMember.parentClientName || "",
        };
      }
    } else {
      // Default: pick first client in group
      const clientMember = group.members.find((m) => m.memberType === "client");
      if (clientMember && isObjId(clientMember.memberId)) {
        messageClientId = oid(clientMember.memberId);
      }
    }

    // ── Check ClientInfo supervision settings ─────────────────────
    let needsApproval = false;
    let supervisedByList = [];
    let clientManagers = [];

    if (messageClientId) {
      const ClientInfo = require("../models/ClientInfo");
      const clientDoc = await ClientInfo.findById(messageClientId)
        .select("supervision supervisedBy assignedTo")
        .lean();
      // Only "employee" role needs approval; managers/team leads bypass
      needsApproval =
        clientDoc?.supervision === "needs_approval" &&
        senderRole === "employee";
      supervisedByList = (clientDoc?.supervisedBy || []).map((id) =>
        String(id)
      );
      
      // Collect all managers for unread counts (excluding assigned employees if not in group)
      if (clientDoc?.supervisedBy) {
        clientDoc.supervisedBy.forEach(id => clientManagers.push(id.toString()));
      }
    }

    // Add CRM to managers list
    const crmEmployeeId = process.env.CRM_EMPLOYEE_ID;
    if (crmEmployeeId) clientManagers.push(crmEmployeeId);

    // ── Build receiver & approval status ──────────────────────────
    let receiverIds = [];
    let intendedReceiverIds = [];
    let approvalStatus = null;

    if (needsApproval) {
      // Find first immediate supervisor who: (a) has supervision ON for this client, (b) is in this group
      const immediateSupervisors = await findSupervisorsInHierarchy(
        owner,
        senderId
      );
      const activeSupervisors = immediateSupervisors.filter(
        (id) =>
          supervisedByList.includes(id) && allMemberIds.includes(id)
      );

      if (activeSupervisors.length > 0) {
        // One-by-one approval chain: only route to the FIRST active supervisor
        receiverIds = [oid(activeSupervisors[0])];
        approvalStatus = "pending";
      } else {
        // No active supervisor in group – walk full hierarchy to find TL/manager in group
        const fullChain = await getManagementChain(owner, String(senderId));
        const managerInGroup = fullChain.find((id) =>
          allMemberIds.includes(id)
        );
        if (managerInGroup) {
          receiverIds = [oid(managerInGroup)];
          approvalStatus = "pending";
        } else {
          // Fallback: find any manager/TL among group members
          for (const memberId of allMemberIds) {
            const memberDoc = await Employee.findById(memberId)
              .select("role")
              .lean();
            const mRole = normalizeRole(memberDoc?.role || "");
            if (mRole === "manager" || mRole === "team_lead") {
              receiverIds = [oid(memberId)];
              approvalStatus = "pending";
              break;
            }
          }
          // Absolute fallback: no supervisor found → send directly with no approval
          if (receiverIds.length === 0) {
            receiverIds = allMemberIds
              .filter(isObjId)
              .map((id) => oid(String(id)));
            approvalStatus = null;
          }
        }
      }
    }

    // 🔥 CRITICAL: Add all relevant managers to intended receivers
    // This ensures they show up in their sidebar and get unread counts
    const fullIntendedSet = new Set([
      ...allMemberIds,
      ...clientManagers
    ]);
    
    // Remove sender from recipients
    fullIntendedSet.delete(String(senderId));
    
    intendedReceiverIds = Array.from(fullIntendedSet).filter(isObjId).map(id => oid(id));

    if (!needsApproval) {
      // Send to everyone immediately
      receiverIds = intendedReceiverIds;
      approvalStatus = null;
    }

    // ── Build & save message document ─────────────────────────────
    const msgDoc = {
      owner,
      sender: senderId,
      receiver: receiverIds,
      // Store intended final recipients so the group conv shows correctly after approval
      intendedReceivers:
        intendedReceiverIds.length > 0 ? intendedReceiverIds : receiverIds,
      note: note.trim(),
      subject: subject || `Group: ${group.name}`,
      status: "sent",
      isGroupMessage: true,
      groupId: oid(groupId),
      chatType: "group",
      isClientEmployeeMessage,
      clientEmployeeId,
      clientEmployeeData,
      isReply: isReply === true || isReply === "true",
      repliedTo: isReply && isObjId(repliedTo) ? oid(repliedTo) : null,
      replyContent: isReply ? replyContent : null,
      approvalStatus,
    };

    if (messageClientId) msgDoc.client = messageClientId;
    
    // 🔥 FIXED: Ensure these values are assigned correctly
    msgDoc.clientEmployeeData = clientEmployeeData;
    msgDoc.parentClientId = clientEmployeeData?.parentClientId;

    const message = new WhatsAppMessage(msgDoc);
    await message.save();

    await WhatsAppGroup.findByIdAndUpdate(groupId, {
      lastMessage: note.trim().substring(0, 100),
      lastMessageAt: new Date(),
      lastMessageBy: senderId,
    });

    const populated = await WhatsAppMessage.findById(message._id)
      .populate("sender", "_id name companyEmail role")
      .populate("receiver", "_id name companyEmail role")
      .populate("client", "_id clientName")
      .lean();

    // ── Real-time socket notifications ────────────────────────────
    const io = req.app.get("io");
    if (io) {
      // Identify all relevant parties: sender, all targets, group members, and client managers
      const notifyIds = new Set([
        String(senderId),
        String(owner),
        ...receiverIds.map(rid => String(rid))
      ]);

      // Only notify all group members if the message is NOT pending
      if (approvalStatus !== "pending") {
        allMemberIds.forEach(id => notifyIds.add(String(id)));
      }

      // 🔥 ALSO notify supervisors for this client (ONLY if NOT pending, otherwise only active approver in receiverIds gets it)
      if (messageClientId) {
        try {
          const ClientInfo = require("../models/ClientInfo");
          const client = await ClientInfo.findById(messageClientId).select("supervisedBy").lean();
          if (client) {
            if (approvalStatus !== "pending" && client.supervisedBy && Array.isArray(client.supervisedBy)) {
              client.supervisedBy.forEach(id => notifyIds.add(String(id)));
            }
          }
        } catch (err) {
          console.warn("Could not fetch client managers for notification:", err);
        }
      }

      notifyIds.forEach((ridStr) => {
        const isSender = ridStr === String(senderId);
        io.to(`employee_${ridStr}`).emit("new_message", {
          message: populated,
          type: isSender ? "message_created" : (
            approvalStatus === "pending"
              ? "reply_needs_approval"
              : "new_group_message"
          ),
          action: isSender ? "sent" : "received",
          requiresApproval: !isSender && approvalStatus === "pending",
          isGroupMessage: true,
          approvalStatus,
        });
      });
    }

    res.status(201).json(populated);
  } catch (error) {
    console.error("Error sending group message:", error);
    res.status(500).json({ error: "Failed to send group message" });
  }
};

/** ── DELETE / ARCHIVE GROUP ──────────────────────────────────── */
exports.deleteGroup = async function (req, res) {
  try {
    const { groupId } = req.params;
    if (!isObjId(groupId))
      return res.status(400).json({ error: "Invalid group ID" });

    const owner = req.employee?.owner || req.employee?._id;

    await WhatsAppGroup.findOneAndUpdate(
      { _id: groupId, owner },
      { isActive: false }
    );

    res.json({ message: "Group deleted" });
  } catch (error) {
    console.error("Error deleting group:", error);
    res.status(500).json({ error: "Failed to delete group" });
  }
};
