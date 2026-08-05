// controllers/whatsAppGroupController.js
const WhatsAppGroup = require("../models/WhatsAppGroup");
const WhatsAppMessage = require("../models/WhatsAppMessage");
const Employee = require("../models/Employees");
const EmployeeHierarchy = require("../models/EmployeeHierarchy");
const { getCrmUserIds } = require("../utils/crmAccess");
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
      // - "pending"          → sender, the current designated approver (receiver[]),
      //                        or anyone earlier in the chain who already approved it
      //                        (escalation overwrites receiver[], so without this a
      //                        senior who approved would lose the message the moment
      //                        it moved on to the next approver)
      // - "disapproved"      → only the sender
      $or: [
        { approvalStatus: null },
        { approvalStatus: "approved" },
        { approvalStatus: "pending", sender: me },
        { approvalStatus: "pending", receiver: me },
        { approvalStatus: "pending", "approvalChain.approver": me },
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
        // photographUrl → voice messages show the employee photo, not client image
        { path: "sender", select: "_id name companyEmail role designation photographUrl" },
        { path: "receiver", select: "_id name companyEmail role designation" },
        { path: "attachments.uploadedBy", select: "_id name" },
        { path: "repliedTo", select: "_id note message sender" },
        // Approval hierarchy fields — without these the message-info dialog
        // can't show each level or who currently has the message pending.
        { path: "plannedApprovalChain", select: "_id name role designation" },
        {
          path: "approvalChain",
          populate: {
            path: "approver",
            select: "_id name role designation",
            model: "Employee",
          },
        },
        { path: "approvedBy", select: "_id name companyEmail role designation" },
        { path: "disapprovedBy", select: "_id name companyEmail role designation" },
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

    // Flag messages sent by CRM-access employees so the UI shows the client
    // avatar (incl. voice messages) rather than the employee photo.
    let crmSenderIdSet = new Set();
    try {
      const crmIds = await getCrmUserIds(owner);
      crmSenderIdSet = new Set((crmIds || []).map((id) => String(id)));
    } catch (e) {
      console.warn("getCrmUserIds failed for group messages:", e.message);
    }
    const itemsOut = items.map((m) => ({
      ...m,
      senderHasCrmAccess: crmSenderIdSet.has(
        String(m.sender?._id || m.sender || ""),
      ),
    }));

    res.json({ items: itemsOut, group, pagination: { hasMore, nextCursor } });
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
      receiverDisplayName = "",
      isReply,
      repliedTo,
      replyContent,
      mentions,
      clientTempId,
    } = req.body;

    if (!isObjId(groupId))
      return res.status(400).json({ error: "Valid group ID is required" });
    // Message content is no longer strictly required to allow for file-only messages
    const noteContent = (note || "").trim();

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

    // Fallback: a group with no direct client member can still be tied to a
    // client through a client_employee member. Without this the message would
    // carry no `client`, and every client-scoped rule downstream (assigned-only
    // delivery, the browser-notification gate) would fall open.
    if (!messageClientId) {
      const ceMember = group.members.find(
        (m) => m.memberType === "client_employee" && isObjId(m.parentClientId),
      );
      if (ceMember) messageClientId = oid(ceMember.parentClientId);
    }

    // ── Check ClientInfo supervision settings ─────────────────────
    let needsApproval = false;
    let supervisedByList = [];
    let clientManagers = [];
    let assignedEmployeeIds = [];

    if (messageClientId) {
      const ClientInfo = require("../models/ClientInfo");
      const clientDoc = await ClientInfo.findById(messageClientId)
        .select("supervision supervisedBy assignedTo")
        .lean();
      // Employees and team leads need approval; managers/admins/owners bypass
      needsApproval =
        clientDoc?.supervision === "needs_approval" &&
        (senderRole === "employee" || senderRole === "team_lead");
      supervisedByList = (clientDoc?.supervisedBy || []).map((id) =>
        String(id)
      );
      assignedEmployeeIds = (
        Array.isArray(clientDoc?.assignedTo)
          ? clientDoc.assignedTo
          : clientDoc?.assignedTo
            ? [clientDoc.assignedTo]
            : []
      )
        .map((a) => String(a?._id || a))
        .filter(Boolean);

      // We no longer automatically push supervisedBy supervisors to clientManagers.
      // Group messages should strictly stay within the group. Supervisors must be added to the group to see them.
    }

    // Add CRM to managers list
    const crmEmployeeId = process.env.CRM_EMPLOYEE_ID;
    if (crmEmployeeId) clientManagers.push(crmEmployeeId);

    // ── Build receiver & approval status ──────────────────────────
    let receiverIds = [];
    let intendedReceiverIds = [];
    let approvalStatus = null;
    // Full ordered approver route, stored so the message-info dialog can show
    // every hierarchy level and who currently holds the message.
    let plannedApprovalChainIds = [];

    if (needsApproval) {
      // Approval must follow THIS CLIENT'S designated approver chain
      // (ClientInfo.supervisedBy) — NOT the global org hierarchy. Walk up from
      // the sender and route to the nearest designated approver who is also a
      // member of this group. A senior who outranks the sender in the org but
      // is not a supervisedBy approver for this client (e.g. CRM) must NOT
      // receive the message for approval.
      let nextApprover = null;
      let currentId = String(senderId);
      const visited = new Set();
      for (let i = 0; i < 10; i++) {
        if (visited.has(currentId)) break;
        visited.add(currentId);

        const seniors = await findSupervisorsInHierarchy(owner, currentId);
        if (!seniors || seniors.length === 0) break;

        const approverInGroup = seniors.find(
          (id) => supervisedByList.includes(id) && allMemberIds.includes(id)
        );
        if (approverInGroup) {
          nextApprover = approverInGroup;
          break;
        }
        // Climb past non-approver seniors to look for a higher designated approver
        currentId = seniors[0];
      }

      if (nextApprover) {
        // One-by-one approval chain: route to the next designated approver up the chain
        receiverIds = [oid(nextApprover)];
        approvalStatus = "pending";

        // Planned route = first approver, then escalation walks up the
        // hierarchy one immediate senior at a time (mirrors approveMessage).
        plannedApprovalChainIds = [oid(nextApprover)];
        let chainCursor = String(nextApprover);
        const chainSeen = new Set([String(senderId), chainCursor]);
        for (let i = 0; i < 10; i++) {
          const ups = await findSupervisorsInHierarchy(owner, chainCursor);
          if (!ups || ups.length === 0) break;
          const up = String(ups[0]);
          if (chainSeen.has(up)) break;
          chainSeen.add(up);
          plannedApprovalChainIds.push(oid(up));
          chainCursor = up;
        }
      } else {
        // Sender is at the top of this client's approval chain (no higher
        // designated approver is in the group) → send directly, no approval.
        approvalStatus = null;
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

    // CRM/manager messages on a client group are DELIVERED only to the client's
    // assigned employees (+ CRM). Supervisors stay in `intendedReceivers` and
    // still see the message — group visibility is by groupId, not receiver —
    // but they get no unread badge and no browser notification for it. They are
    // notified only for messages that need THEIR approval.
    const isCrmSend =
      senderRole === "manager" || senderRole === "admin" || senderRole === "owner";
    const restrictToAssigned =
      isCrmSend && messageClientId && assignedEmployeeIds.length > 0;

    if (approvalStatus === null) {
      // No approval required, OR the sender is the top of this client's approval
      // chain → deliver to everyone in the group immediately.
      receiverIds = intendedReceiverIds;

      if (restrictToAssigned) {
        const deliverSet = new Set([...assignedEmployeeIds, ...clientManagers]);
        deliverSet.delete(String(senderId));
        receiverIds = intendedReceiverIds.filter((id) =>
          deliverSet.has(String(id)),
        );
      }
    }

    // ── Build & save message document ─────────────────────────────
    const msgDoc = {
      owner,
      sender: senderId,
      receiver: receiverIds,
      // Store intended final recipients so the group conv shows correctly after approval
      intendedReceivers:
        intendedReceiverIds.length > 0 ? intendedReceiverIds : receiverIds,
      note: noteContent,
      subject: subject || `Group: ${group.name}`,
      clientTempId: clientTempId || null,
      mentions: Array.isArray(mentions)
        ? mentions
            .filter((m) => m && m.refId && m.name)
            .map((m) => ({
              refId: String(m.refId),
              name: String(m.name),
              type: ["client_employee", "client"].includes(m.type)
                ? m.type
                : "employee",
            }))
        : [],
      status: "sent",
      // Survives the createdAt rewrite that approval performs, so the sender
      // keeps seeing when THEY sent it. See the field's note on the model.
      originalSentAt: new Date(),
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
      plannedApprovalChain: plannedApprovalChainIds.filter(Boolean),
    };

    if (messageClientId) msgDoc.client = messageClientId;

    // Store the UI-selected display name so every viewer gets the right label
    if (receiverDisplayName) msgDoc.receiverDisplayName = receiverDisplayName;

    // 🔥 FIXED: Ensure these values are assigned correctly
    msgDoc.clientEmployeeData = clientEmployeeData;
    msgDoc.parentClientId = clientEmployeeData?.parentClientId;

    const message = new WhatsAppMessage(msgDoc);
    await message.save();

    await WhatsAppGroup.findByIdAndUpdate(groupId, {
      lastMessage: noteContent ? noteContent.substring(0, 100) : "📎 Attachment",
      lastMessageAt: new Date(),
      lastMessageBy: senderId,
      lastMessageDeleted: false,
    });

    const populated = await WhatsAppMessage.findById(message._id)
      // `designation` + `assignedTo` are needed by the browser-notification
      // gate (crmNotify): CRM group messages on a client/client-employee should
      // only notify the client's ASSIGNED employees, and isCrmSender checks the
      // sender's role/designation.
      .populate("sender", "_id name companyEmail role designation photographUrl")
      .populate("receiver", "_id name companyEmail role designation")
      .populate("client", "_id clientName assignedTo")
      // Message-info dialog needs the full planned approver route
      .populate("plannedApprovalChain", "_id name role designation")
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

      // We no longer manually broadcast group messages to all client supervisors.
      // The socket event will only go to to group members and approvers.

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

      // 🔔 Notify @mentioned employees
      if (Array.isArray(msgDoc.mentions) && msgDoc.mentions.length) {
        const mentionSenderName = populated.sender?.name || "Someone";
        const mentionPreview = noteContent.replace(/<[^>]*>/g, "").slice(0, 120);
        msgDoc.mentions
          .filter(
            (m) =>
              m.type === "employee" &&
              isObjId(m.refId) &&
              String(m.refId) !== String(senderId),
          )
          .forEach((m) => {
            io.to(`employee_${m.refId}`).emit("whatsapp_mention", {
              messageId: String(message._id),
              groupId: String(groupId),
              isGroupMessage: true,
              senderName: mentionSenderName,
              preview: mentionPreview,
            });
          });
      }
    }

    res.status(201).json(populated);
  } catch (error) {
    console.error("Error sending group message:", error);
    res.status(500).json({ error: "Failed to send group message" });
  }
};

/** ── ADD MEMBERS TO GROUP ──────────────────────────────────── */
exports.addMembers = async function (req, res) {
  try {
    const { groupId } = req.params;
    const { members } = req.body;

    if (!isObjId(groupId))
      return res.status(400).json({ error: "Invalid group ID" });

    if (!members || !Array.isArray(members) || members.length === 0)
      return res.status(400).json({ error: "At least one member is required" });

    const owner = req.employee?.owner || req.employee?._id;
    const addedBy = req.employee?._id;

    if (!owner || !addedBy)
      return res.status(401).json({ error: "Unauthorized" });

    const group = await WhatsAppGroup.findOne({
      _id: groupId,
      owner,
      isActive: true,
    });

    if (!group) return res.status(404).json({ error: "Group not found" });

    // Filter out existing members
    const existingMemberIds = new Set(
      group.members.map((m) => `${m.memberType}_${m.memberId}`)
    );
    const newMembers = members.filter(
      (m) => !existingMemberIds.has(`${m.memberType}_${m.memberId}`)
    );

    if (newMembers.length === 0) {
      return res.status(400).json({ error: "All members already in group" });
    }

    // Add new members with addedBy field
    newMembers.forEach((m) => {
      group.members.push({ ...m, addedBy });
    });

    // Update group type based on member types
    const memberTypes = [...new Set(group.members.map((m) => m.memberType))];
    let groupType = "mixed";
    if (memberTypes.length === 1) {
      if (memberTypes[0] === "employee") groupType = "employees_only";
      else if (memberTypes[0] === "client") groupType = "clients_only";
      else if (memberTypes[0] === "client_employee")
        groupType = "client_employees_only";
    }
    group.groupType = groupType;

    await group.save();

    const populated = await WhatsAppGroup.findById(group._id)
      .populate("createdBy", "name companyEmail role")
      .lean();

    // Notify new members via socket
    const io = req.app.get("io");
    if (io) {
      newMembers.forEach((m) => {
        if (m.memberType === "employee" && isObjId(m.memberId)) {
          io.to(`employee_${m.memberId}`).emit("group_member_added", {
            group: populated,
            addedBy,
          });
        }
      });
    }

    res.json({
      message: `${newMembers.length} member(s) added successfully`,
      group: populated,
    });
  } catch (error) {
    console.error("Error adding members to group:", error);
    res.status(500).json({ error: "Failed to add members to group" });
  }
};

/** ── REMOVE MEMBER FROM GROUP ──────────────────────────────────── */
exports.removeMember = async function (req, res) {
  try {
    const { groupId, memberId } = req.params;
    const { memberType } = req.body;

    if (!isObjId(groupId))
      return res.status(400).json({ error: "Invalid group ID" });

    const owner = req.employee?.owner || req.employee?._id;

    if (!owner) return res.status(401).json({ error: "Unauthorized" });

    const group = await WhatsAppGroup.findOne({
      _id: groupId,
      owner,
      isActive: true,
    });

    if (!group) return res.status(404).json({ error: "Group not found" });

    // Remove member
    group.members = group.members.filter(
      (m) => !(m.memberId === memberId && m.memberType === memberType)
    );

    // Update group type based on remaining members
    const memberTypes = [...new Set(group.members.map((m) => m.memberType))];
    let groupType = "mixed";
    if (memberTypes.length === 1) {
      if (memberTypes[0] === "employee") groupType = "employees_only";
      else if (memberTypes[0] === "client") groupType = "clients_only";
      else if (memberTypes[0] === "client_employee")
        groupType = "client_employees_only";
    }
    group.groupType = groupType;

    await group.save();

    const populated = await WhatsAppGroup.findById(group._id)
      .populate("createdBy", "name companyEmail role")
      .lean();

    res.json({
      message: "Member removed successfully",
      group: populated,
    });
  } catch (error) {
    console.error("Error removing member from group:", error);
    res.status(500).json({ error: "Failed to remove member from group" });
  }
};

/** ── DELETE / ARCHIVE GROUP ──────────────────────────────────── */
exports.deleteGroup = async function (req, res) {
  try {
    const { groupId } = req.params;
    if (!isObjId(groupId))
      return res.status(400).json({ error: "Invalid group ID" });

    const owner = req.employee?.owner || req.employee?._id;

    const group = await WhatsAppGroup.findOneAndUpdate(
      { _id: groupId, owner },
      { isActive: false }
    );
    if (!group) return res.status(404).json({ error: "Group not found" });

    // Realtime: tell every member (and anyone in the group room) the chat is gone
    const io = req.app.get("io");
    if (io) {
      const payload = {
        groupId: String(groupId),
        chatId: String(groupId),
        deletedBy: {
          _id: String(req.employee._id),
          name: req.employee?.name || "",
        },
        at: new Date(),
      };
      (group.members || []).forEach((m) => {
        if (m.memberId) {
          io.to(`employee_${m.memberId}`).emit("whatsapp_chat_deleted", payload);
        }
      });
      io.to(`group_${groupId}`).emit("whatsapp_chat_deleted", payload);
    }

    res.json({ message: "Group deleted" });
  } catch (error) {
    console.error("Error deleting group:", error);
    res.status(500).json({ error: "Failed to delete group" });
  }
};
