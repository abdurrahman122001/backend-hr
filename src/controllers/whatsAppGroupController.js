// controllers/whatsAppGroupController.js
const WhatsAppGroup = require("../models/WhatsAppGroup");
const WhatsAppMessage = require("../models/WhatsAppMessage");
const Employee = require("../models/Employees");
const mongoose = require("mongoose");

const isObjId = (v) => mongoose.isValidObjectId(v);
const oid = (v) =>
  mongoose.isValidObjectId(v) ? new mongoose.Types.ObjectId(v) : null;

function normalizeRole(role) {
  if (!role) return "";
  const r = String(role).toLowerCase().replace(/\s+/g, "_");
  return r;
}

/** ── CREATE GROUP ──────────────────────────────────────────── */
exports.createGroup = async function (req, res) {
  try {
    const { name, description, members } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ error: "Group name is required" });
    }
    if (!members || !Array.isArray(members) || members.length === 0) {
      return res.status(400).json({ error: "At least one member is required" });
    }

    const owner = req.employee?.owner || req.employee?._id;
    const createdBy = req.employee?._id;

    if (!owner || !createdBy) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    // Derive groupType from member types
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

    // Emit socket event so other members see the new group in real time
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

    // Managers see all groups; everyone else only groups they belong to
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

    const q = {
      groupId: oid(groupId),
      isGroupMessage: true,
      owner,
      status: { $ne: "draft" },
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

    res.json({
      items,
      group,
      pagination: { hasMore, nextCursor },
    });
  } catch (error) {
    console.error("Error fetching group messages:", error);
    res.status(500).json({ error: "Failed to fetch group messages" });
  }
};

/** ── SEND GROUP MESSAGE ─────────────────────────────────────── */
/**
 * Body fields:
 *   note             – message text (required)
 *   subject          – optional subject line
 *   receiverType     – "client" | "client_employee" | "all" (defaults to "all")
 *   receiverId       – ID of the specific client or client-employee to address
 *   parentClientId   – (client_employee only) parent client ID
 */
exports.sendGroupMessage = async function (req, res) {
  try {
    const { groupId } = req.params;
    const {
      note,
      subject,
      receiverType = "all",
      receiverId,
      parentClientId,
    } = req.body;

    if (!isObjId(groupId))
      return res.status(400).json({ error: "Valid group ID is required" });
    if (!note || !note.trim())
      return res.status(400).json({ error: "Message content is required" });

    const owner = req.employee?.owner || req.employee?._id;
    const senderId = req.employee?._id;

    const group = await WhatsAppGroup.findOne({
      _id: groupId,
      owner,
      isActive: true,
    }).lean();
    if (!group) return res.status(404).json({ error: "Group not found" });

    // ── Build receiver list (always the employee members) ──────────
    const employeeMembers = group.members.filter(
      (m) => m.memberType === "employee"
    );
    const receiverIds = employeeMembers
      .map((m) => m.memberId)
      .filter((id) => isObjId(String(id)) && String(id) !== String(senderId))
      .map((id) => oid(String(id)));

    // ── Resolve client reference ───────────────────────────────────
    let messageClientId = null;
    let isClientEmployeeMessage = false;
    let clientEmployeeId = null;
    let clientEmployeeData = null;

    if (receiverType === "client" && receiverId && isObjId(receiverId)) {
      // Direct client message
      messageClientId = oid(receiverId);
      isClientEmployeeMessage = false;
    } else if (
      receiverType === "client_employee" &&
      receiverId
    ) {
      // Client-employee message
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
      // No specific target – pick first client in group (if any)
      const clientMember = group.members.find((m) => m.memberType === "client");
      if (clientMember && isObjId(clientMember.memberId)) {
        messageClientId = oid(clientMember.memberId);
      }
    }

    // ── Build message document ─────────────────────────────────────
    const msgDoc = {
      owner,
      sender: senderId,
      receiver: receiverIds,
      note: note.trim(),
      subject:
        subject ||
        `Group: ${group.name}`,
      status: "sent",
      isGroupMessage: true,
      groupId: oid(groupId),
      chatType: "group",
      isClientEmployeeMessage,
    };

    if (messageClientId) msgDoc.client = messageClientId;
    if (clientEmployeeId) {
      msgDoc.clientEmployeeId = clientEmployeeId;
      msgDoc.clientEmployeeData = clientEmployeeData;
      msgDoc.parentClientId = clientEmployeeData?.parentClientId;
    }

    const message = new WhatsAppMessage(msgDoc);
    await message.save();

    // Update group metadata
    await WhatsAppGroup.findByIdAndUpdate(groupId, {
      lastMessage: note.trim().substring(0, 100),
      lastMessageAt: new Date(),
      lastMessageBy: senderId,
    });

    const populated = await WhatsAppMessage.findById(message._id)
      .populate("sender", "_id name companyEmail role")
      .populate("receiver", "_id name companyEmail role")
      .lean();

    // Emit to all employee members via socket
    const io = req.app.get("io");
    if (io) {
      employeeMembers.forEach((m) => {
        if (isObjId(m.memberId)) {
          io
            .to(`employee_${m.memberId}`)
            .emit("group_message", { groupId, message: populated });
        }
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
