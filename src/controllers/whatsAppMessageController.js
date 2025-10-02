// controllers/whatsAppMessageController.js
const WhatsAppMessage = require("../models/WhatsAppMessage");
const Employee = require("../models/Employees");
const path = require("path");
const mongoose = require("mongoose");

/** ---------- utils ---------- **/
function buildPublicUrl(req, filename) {
  const base =
    process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`;
  return `${base}/uploads/${filename}`;
}

const isObjId = (v) => mongoose.isValidObjectId(v);
const oid = (v) =>
  mongoose.isValidObjectId(v) ? new mongoose.Types.ObjectId(v) : null;

function normalizeIds(val) {
  if (!val) return [];
  if (Array.isArray(val)) return val.filter(isObjId).map(String);
  if (typeof val === "string") {
    return val
      .split(",")
      .map((s) => s.trim())
      .filter(isObjId);
  }
  return [];
}

function normalizeRole(role) {
  if (!role) return "";
  const raw = String(role).trim();
  if (raw === "Team Lead") return "team_lead";
  if (raw === "Manager") return "manager";
  if (raw === "Employee") return "employee";
  const r = raw.toLowerCase().replace(/\s+/g, "_");
  if (["teamlead", "team_lead", "team-lead", "lead"].includes(r))
    return "team_lead";
  if (r === "manager") return "manager";
  if (["employee", "staff", "associate"].includes(r)) return "employee";
  return r;
}

async function applyVisibility(q, req) {
  if (!req.employee?._id) return q;
  const me = oid(String(req.employee._id));
  if (!me) return q;

  const now = new Date();
  const visOr = [{ sender: me }, { receiver: me }];

  // ** STRICT scheduled-only case **
  if (q.isScheduled === true && q.status === "scheduled") {
    // only show messages that are truly scheduled to this user
    return {
      ...q,
      $and: [{ $or: visOr }],
    };
  }

  // ** normal inbox case (mix of drafts, sent, and due-to-be-sent) **
  return {
    $or: [
      {
        ...q,
        $and: [
          {
            $or: [
              { isScheduled: { $ne: true } }, // drafts & sent
              { isScheduled: true, status: "sent" }, // scheduled-but-sent
              {
                isScheduled: true,
                status: "scheduled",
                scheduledFor: { $lte: now },
              }, // due now
            ],
          },
          { $or: visOr },
        ],
      },
      {
        ...q,
        isScheduled: true,
        status: "scheduled",
        scheduledFor: { $gt: now }, // future
        sender: me, // only sender may see future schedules
      },
    ],
  };
}

/** ---------- helpers: find TLs and Managers for an owner (no supervisor chain) ---------- **/
async function findTLsAndManagersByOwner(ownerId) {
  if (!isObjId(ownerId)) return { tls: [], managers: [], employees: [] };

  // Accept both stored forms of the role ("Team Lead" from your DB and normalized hint strings)
  const tls = await Employee.find({
    owner: ownerId,
    $or: [{ role: "Team Lead" }, { role: "team_lead" }, { role: /lead/i }],
  })
    .select("_id")
    .lean();

  const managers = await Employee.find({
    owner: ownerId,
    $or: [{ role: "Manager" }, { role: "manager" }],
  })
    .select("_id")
    .lean();

  const employees = await Employee.find({
    owner: ownerId,
    $or: [{ role: "Employee" }, { role: "employee" }],
  })
    .select("_id")
    .lean();

  return {
    tls: tls.map((x) => String(x._id)),
    managers: managers.map((x) => String(x._id)),
    employees: employees.map((x) => String(x._id)),
  };
}

/** ---------- SCHEDULING UTILITIES ---------- **/
function validateScheduleTime(scheduledFor) {
  if (!scheduledFor)
    return { valid: false, error: "Scheduled time is required" };

  const scheduleTime = new Date(scheduledFor);
  const now = new Date();

  if (isNaN(scheduleTime.getTime())) {
    return { valid: false, error: "Invalid date format" };
  }

  if (scheduleTime <= now) {
    return { valid: false, error: "Scheduled time must be in the future" };
  }

  // Optional: Limit how far in the future they can schedule
  const maxFuture = new Date();
  maxFuture.setFullYear(maxFuture.getFullYear() + 1); // 1 year max

  if (scheduleTime > maxFuture) {
    return {
      valid: false,
      error: "Cannot schedule more than 1 year in advance",
    };
  }

  return { valid: true, scheduleTime };
}

// GET SCHEDULED MESSAGES FOR SPECIFIC CLIENT
exports.getScheduledMessagesForClient =
  async function getScheduledMessagesForClient(req, res) {
    try {
      const { clientId } = req.params;
      const { limit = 50, page = 1 } = req.query;

      if (!isObjId(clientId)) {
        return res.status(400).json({ error: "Valid client ID is required" });
      }

      const q = {
        client: clientId,
        isScheduled: true,
        status: "scheduled",
      };

      // Apply visibility rules
      const qFinal = await applyVisibility(q, req);

      const pageNum = Math.max(parseInt(page, 10) || 1, 1);
      const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);

      const [items, total] = await Promise.all([
        WhatsAppMessage.find(qFinal)
          .sort({ scheduledFor: 1 })
          .skip((pageNum - 1) * lim)
          .limit(lim)
          .populate([
            { path: "owner", select: "_id name companyEmail" },
            { path: "sender", select: "_id name companyEmail role" },
            { path: "receiver", select: "_id name companyEmail role" },
            { path: "client", select: "_id clientName" },
            { path: "scheduledBy", select: "_id name companyEmail" },
          ])
          .lean(),
        WhatsAppMessage.countDocuments(qFinal),
      ]);

      res.json({
        items,
        total,
        page: pageNum,
        pages: Math.ceil(total / lim),
        limit: lim,
        client: clientId,
      });
    } catch (e) {
      console.error(e);
      res
        .status(500)
        .json({ error: "Failed to fetch scheduled messages for client" });
    }
  };

exports.listMessages = async function listMessages(req, res) {
  try {
    const {
      client,
      sender,
      receiver,
      participant,
      owner,
      status,
      isScheduled,
      scheduledBefore,
      scheduledAfter,
      limit = 50,
      page = 1,
      between: betweenRaw,
      filter,
    } = req.query;

    const q = {};

    // Owner / client scope
    if (isObjId(owner)) q.owner = owner;
    else if (req.employee?.owner) q.owner = req.employee.owner;
    if (isObjId(client)) q.client = client;

    // Status filter for drafts/sent/cancelled
    if (
      status &&
      ["draft", "scheduled", "sent", "cancelled"].includes(status)
    ) {
      q.status = status;
      if (status === "draft") q.isScheduled = false;
    }

    // ** frontend "filter=scheduled" **
    if (filter === "scheduled" || isScheduled === "true") {
      q.isScheduled = true;
      q.status = "scheduled";
    } else if (isScheduled === "false") {
      q.isScheduled = false;
    }

    // scheduledBefore/After
    const timeFilters = {};
    if (scheduledBefore) {
      const d = new Date(scheduledBefore);
      if (!isNaN(d)) timeFilters.$lte = d;
    }
    if (scheduledAfter) {
      const d = new Date(scheduledAfter);
      if (!isNaN(d)) timeFilters.$gte = d;
    }
    if (Object.keys(timeFilters).length) q.scheduledFor = timeFilters;

    // between / participant / sender / receiver
    const between = normalizeIds(betweenRaw);
    if (between.length === 2) {
      const [a, b] = between;
      q.$or = [
        { sender: a, receiver: b },
        { sender: b, receiver: a },
      ];
    } else if (isObjId(participant)) {
      q.$or = [{ sender: participant }, { receiver: participant }];
    } else {
      if (isObjId(sender)) q.sender = sender;
      if (isObjId(receiver)) q.receiver = receiver;
    }

    // Must have at least one scope
    if (
      !q.owner &&
      !q.client &&
      !q.sender &&
      !q.receiver &&
      !q.$or &&
      !q.status &&
      q.isScheduled === undefined
    ) {
      return res.status(400).json({
        error:
          "Provide at least one scope: owner, client, sender, receiver, participant, status, or isScheduled",
      });
    }

    // Apply visibility rules
    const qFinal = await applyVisibility(q, req);

    // Pagination & fetch
    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);

    const [items, total] = await Promise.all([
      WhatsAppMessage.find(qFinal)
        .sort({ createdAt: -1 })
        .skip((pageNum - 1) * lim)
        .limit(lim)
        .populate([
          { path: "owner", select: "_id name companyEmail" },
          { path: "sender", select: "_id name companyEmail role" },
          { path: "receiver", select: "_id name companyEmail role" },
          { path: "client", select: "_id clientName" },
          { path: "attachments.uploadedBy", select: "_id name companyEmail" },
          { path: "scheduledBy", select: "_id name companyEmail" },
        ])
        .lean(),
      WhatsAppMessage.countDocuments(qFinal),
    ]);

    res.json({
      items,
      total,
      page: pageNum,
      pages: Math.ceil(total / lim),
      limit: lim,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to fetch assignment messages" });
  }
};

exports.listMessagesForManager = async function listMessagesForManager(
  req,
  res
) {
  try {
    const clientId =
      req.params.clientId || req.query.clientId || req.query.client || null;

    const owner = req.query.owner || req.employee?.owner || null;

    const sender = req.query.sender || null;
    const receiver = req.query.receiver || req.query.toEmployee || null;
    const participant = req.query.participant || req.query.employee || null;
    const betweenRaw = req.query.between;

    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(
      Math.max(parseInt(req.query.limit, 10) || 100, 1),
      200
    );

    const q = {};
    if (isObjId(owner)) q.owner = owner;

    // CRITICAL FIX: Always apply client filter if provided
    if (isObjId(clientId)) {
      q.client = clientId;
    }

    // FIXED: Handle status filter for drafts to exclude scheduled messages
    const status = req.query.status;
    if (
      status &&
      ["draft", "scheduled", "sent", "cancelled"].includes(status)
    ) {
      q.status = status;

      // CRITICAL FIX: When querying for drafts, ensure we exclude scheduled messages
      if (status === "draft") {
        q.isScheduled = false;
      }
    }

    const between = normalizeIds(betweenRaw);
    if (between.length === 2) {
      const [a, b] = between;
      q.$or = [
        { sender: a, receiver: b },
        { sender: b, receiver: a },
      ];
    } else if (isObjId(participant)) {
      q.$or = [{ sender: participant }, { receiver: participant }];
    } else {
      if (isObjId(sender)) q.sender = sender;
      if (isObjId(receiver)) q.receiver = receiver;
    }

    // FIXED: Remove overly restrictive validation
    if (!q.owner && !q.client && !q.sender && !q.receiver && !q.$or) {
      return res.status(400).json({
        error:
          "Provide at least one scope: clientId/client, owner, sender, receiver, or participant",
      });
    }

    const qFinal = await applyVisibility(q, req);

    const messages = await WhatsAppMessage.find(qFinal)
      .sort({ createdAt: 1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate([
        { path: "owner", select: "_id name companyEmail" },
        { path: "sender", select: "_id name companyEmail role" },
        { path: "receiver", select: "_id name companyEmail role" },
        { path: "client", select: "_id clientName" },
        { path: "attachments.uploadedBy", select: "_id name companyEmail" },
      ])
      .lean();

    return res.json({ messages });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Failed to load message history" });
  }
};

// CREATE MESSAGE WITH SCHEDULING SUPPORT
exports.createMessage = async function createMessage(req, res) {
  try {
    const {
      owner: ownerBody,
      client,
      sender: senderBody,
      receiver: receiverBody,
      receivers: receiversBody,
      subject,
      note,
      isScheduled: isScheduledBody,
      scheduledFor,
    } = req.body;

    const owner = ownerBody || req.employee?.owner;
    const sender = senderBody || req.employee?._id;

    if (!isObjId(owner) || !isObjId(client) || !isObjId(sender)) {
      return res.status(400).json({
        error: "owner, client, and sender are required (ObjectId strings)",
      });
    }

    // Collect receivers from body
    let receivers = [];
    if (receiverBody) receivers = receivers.concat(normalizeIds(receiverBody));
    if (receiversBody)
      receivers = receivers.concat(normalizeIds(receiversBody));
    receivers = receivers.filter((id) => id !== String(sender));

    const senderDoc = await Employee.findById(sender)
      .select("_id role supervisor supervisionMode owner")
      .lean();
    const senderRole = normalizeRole(senderDoc?.role || "");

    let approvalStatus;
    const supervisionMode = String(
      senderDoc?.supervisionMode || ""
    ).toLowerCase();
    const needsApproval = supervisionMode === "needs_approval"; // supervision enabled
    const isDirect = supervisionMode === "direct"; // no supervision

    const Client = require("../models/ClientInfo");
    const clientDoc = await Client.findById(client)
      .populate("assignedTo", "_id role")
      .lean();

    const { tls, managers } = await findTLsAndManagersByOwner(owner);

    // ✅ Always include assignedTo employee if present
    if (clientDoc && clientDoc.assignedTo && clientDoc.assignedTo._id) {
      const assignedEmployeeId = String(clientDoc.assignedTo._id);
      if (
        !receivers.includes(assignedEmployeeId) &&
        assignedEmployeeId !== String(sender)
      ) {
        receivers.push(assignedEmployeeId);
      }
    }

    /** ------------------ ROLE-BASED LOGIC ------------------ **/

    if (senderRole === "manager" || senderRole === "team_lead") {
      // ✅ Managers and Team Leads → no approval flow
      approvalStatus = null;

      if (senderRole === "team_lead") {
        // TLs → forward to managers too
        receivers = [...receivers, ...managers.map((id) => String(id))];
      }
    } else if (senderRole === "employee") {
      if (needsApproval) {
        // ✅ Employee with supervision → TLs added, pending approval
        approvalStatus = "pending";
        receivers = [...receivers, ...tls.map((id) => String(id))];
      } else {
        // ✅ Employee without supervision → TLs + Managers added, auto-approved
        approvalStatus = "approved";
        receivers = [
          ...receivers,
          ...tls.map((id) => String(id)),
          ...managers.map((id) => String(id)),
        ];
      }
    }

    // ✅ Remove duplicates and exclude sender
    receivers = Array.from(new Set(receivers.map((id) => String(id)))).filter(
      (id) => id !== String(sender)
    );

    if (receivers.length === 0) {
      return res.status(400).json({ error: "No valid receivers found" });
    }

    // Handle scheduling logic
    const isScheduled = isScheduledBody === true || isScheduledBody === "true";
    let status = "sent";
    let scheduledAt = null;
    let scheduledBy = null;
    let sentAt = new Date();

    if (isScheduled) {
      const validation = validateScheduleTime(scheduledFor);
      if (!validation.valid) {
        return res.status(400).json({ error: validation.error });
      }

      status = "scheduled";
      scheduledAt = new Date();
      scheduledBy = sender;
      sentAt = null; // Will be set when actually sent
    }

    const msgData = {
      owner,
      client,
      sender,
      receiver: receivers,
      subject: subject || "",
      note: note || "",
      approvalStatus: approvalStatus || undefined,
      isScheduled,
      status,
      scheduledFor: isScheduled ? new Date(scheduledFor) : undefined,
      scheduledAt,
      scheduledBy,
      sentAt: !isScheduled ? new Date() : undefined,
    };

    const msg = await WhatsAppMessage.create(msgData);

    const populated = await msg.populate([
      { path: "owner", select: "_id name companyEmail" },
      { path: "sender", select: "_id name companyEmail role" },
      { path: "receiver", select: "_id name companyEmail role" },
      { path: "client", select: "_id clientName assignedTo" },
      { path: "scheduledBy", select: "_id name companyEmail" },
    ]);

    // Emit real-time events
    if (req.app.get("io")) {
      const io = req.app.get("io");
      receivers.forEach((receiverId) => {
        io.to(`employee_${receiverId}`).emit("new_message", {
          message: populated,
          type: "new_assignment",
        });
      });
      io.to(`client_${client}`).emit("new_message", {
        message: populated,
        type: "new_assignment",
      });
      io.to(`employee_${sender}`).emit("new_message", {
        message: populated,
        type: "message_created",
      });
    }

    res.status(201).json(populated);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to create assignment message" });
  }
};

// SCHEDULE AN EXISTING MESSAGE
exports.scheduleMessage = async function scheduleMessage(req, res) {
  try {
    const { id } = req.params;
    const { scheduledFor } = req.body;

    const msg = await WhatsAppMessage.findById(id);
    if (!msg) {
      return res.status(404).json({ error: "Message not found" });
    }

    // Check permissions - only sender or admin can schedule
    if (String(msg.sender) !== String(req.employee._id)) {
      return res
        .status(403)
        .json({ error: "You can only schedule your own messages" });
    }

    // Validate scheduled time
    const validation = validateScheduleTime(scheduledFor);
    if (!validation.valid) {
      return res.status(400).json({ error: validation.error });
    }

    // Update message with scheduling info
    msg.isScheduled = true;
    msg.status = "scheduled";
    msg.scheduledFor = validation.scheduleTime;
    msg.scheduledAt = new Date();
    msg.scheduledBy = req.employee._id;
    msg.sentAt = null;

    await msg.save();

    const populated = await msg.populate([
      { path: "owner", select: "_id name companyEmail" },
      { path: "sender", select: "_id name companyEmail role" },
      { path: "receiver", select: "_id name companyEmail role" },
      { path: "client", select: "_id clientName" },
      { path: "scheduledBy", select: "_id name companyEmail" },
    ]);

    // Emit new_message event for scheduling
    if (req.app.get("io")) {
      const io = req.app.get("io");

      // Notify sender about successful scheduling
      io.to(`employee_${req.employee._id}`).emit("new_message", {
        message: populated,
        type: "message_scheduled",
      });

      // Notify receivers that a message is scheduled for them
      msg.receiver.forEach((receiverId) => {
        io.to(`employee_${receiverId}`).emit("new_message", {
          message: populated,
          type: "message_scheduled_for_you",
        });
      });
    }

    res.json({
      message: "Message scheduled successfully",
      data: populated,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to schedule message" });
  }
};

// UNSCHEDULE/CANCEL A SCHEDULED MESSAGE
exports.unscheduleMessage = async function unscheduleMessage(req, res) {
  try {
    const { id } = req.params;

    const msg = await WhatsAppMessage.findById(id);
    if (!msg) {
      return res.status(404).json({ error: "Message not found" });
    }

    // Check permissions
    if (String(msg.sender) !== String(req.employee._id)) {
      return res
        .status(403)
        .json({ error: "You can only unschedule your own messages" });
    }

    if (!msg.isScheduled || msg.status !== "scheduled") {
      return res.status(400).json({ error: "Message is not scheduled" });
    }

    // Convert to draft or send immediately based on user preference
    const { action = "draft" } = req.body; // "draft" or "send"

    if (action === "send") {
      // Send immediately
      msg.isScheduled = false;
      msg.status = "sent";
      msg.sentAt = new Date();
    } else {
      // Convert to draft
      msg.isScheduled = false;
      msg.status = "draft";
      msg.scheduledFor = undefined;
      msg.scheduledAt = undefined;
    }

    await msg.save();

    const populated = await msg.populate([
      { path: "owner", select: "_id name companyEmail" },
      { path: "sender", select: "_id name companyEmail role" },
      { path: "receiver", select: "_id name companyEmail role" },
      { path: "client", select: "_id clientName" },
      { path: "scheduledBy", select: "_id name companyEmail" },
    ]);

    // Emit new_message event for unscheduling
    if (req.app.get("io")) {
      const io = req.app.get("io");

      const eventType =
        action === "send" ? "message_sent" : "message_unscheduled";

      // Notify sender
      io.to(`employee_${req.employee._id}`).emit("new_message", {
        message: populated,
        type: eventType,
      });

      // If sent immediately, notify receivers
      if (action === "send") {
        msg.receiver.forEach((receiverId) => {
          io.to(`employee_${receiverId}`).emit("new_message", {
            message: populated,
            type: "new_assignment",
          });
        });
      }
    }

    res.json({
      message: `Message ${
        action === "send" ? "sent immediately" : "converted to draft"
      }`,
      data: populated,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to unschedule message" });
  }
};

exports.getScheduledMessages = async function getScheduledMessages(req, res) {
  try {
    const { owner, client, sender, limit = 50, page = 1 } = req.query;
    const q = { isScheduled: true, status: "scheduled" };

    if (isObjId(client)) q.client = client;
    if (isObjId(owner)) q.owner = owner;
    else if (req.employee?.owner) q.owner = req.employee.owner;
    if (isObjId(sender)) q.sender = sender;

    const qFinal = await applyVisibility(q, req);

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);

    const [items, total] = await Promise.all([
      WhatsAppMessage.find(qFinal)
        .sort({ scheduledFor: 1 })
        .skip((pageNum - 1) * lim)
        .limit(lim)
        .populate([
          { path: "owner", select: "_id name companyEmail" },
          { path: "sender", select: "_id name companyEmail role" },
          { path: "receiver", select: "_id name companyEmail role" },
          { path: "client", select: "_id clientName" },
          { path: "scheduledBy", select: "_id name companyEmail" },
        ])
        .lean(),
      WhatsAppMessage.countDocuments(qFinal),
    ]);

    res.json({
      items,
      total,
      page: pageNum,
      pages: Math.ceil(total / lim),
      limit: lim,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to fetch scheduled messages" });
  }
};

// UPDATE SCHEDULED TIME
exports.rescheduleMessage = async function rescheduleMessage(req, res) {
  try {
    const { id } = req.params;
    const { scheduledFor } = req.body;

    const msg = await WhatsAppMessage.findById(id);
    if (!msg) {
      return res.status(404).json({ error: "Message not found" });
    }

    if (!msg.isScheduled || msg.status !== "scheduled") {
      return res.status(400).json({ error: "Message is not scheduled" });
    }

    // Check permissions
    if (String(msg.sender) !== String(req.employee._id)) {
      return res
        .status(403)
        .json({ error: "You can only reschedule your own messages" });
    }

    const validation = validateScheduleTime(scheduledFor);
    if (!validation.valid) {
      return res.status(400).json({ error: validation.error });
    }

    msg.scheduledFor = validation.scheduleTime;
    msg.scheduledAt = new Date(); // Update the scheduling timestamp

    await msg.save();

    const populated = await msg.populate([
      { path: "owner", select: "_id name companyEmail" },
      { path: "sender", select: "_id name companyEmail role" },
      { path: "receiver", select: "_id name companyEmail role" },
      { path: "client", select: "_id clientName" },
      { path: "scheduledBy", select: "_id name companyEmail" },
    ]);

    // Emit new_message event for rescheduling
    if (req.app.get("io")) {
      const io = req.app.get("io");

      // Notify sender about successful rescheduling
      io.to(`employee_${req.employee._id}`).emit("new_message", {
        message: populated,
        type: "message_rescheduled",
      });

      // Notify receivers about schedule update
      msg.receiver.forEach((receiverId) => {
        io.to(`employee_${receiverId}`).emit("new_message", {
          message: populated,
          type: "message_schedule_updated",
        });
      });
    }

    res.json({
      message: "Message rescheduled successfully",
      data: populated,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to reschedule message" });
  }
};

// BULK SEND SCHEDULED MESSAGES (for cron job)
exports.sendScheduledMessages = async function sendScheduledMessages(
  io = null
) {
  try {
    const now = new Date();

    // Find messages scheduled to be sent now or in the past
    const scheduledMessages = await WhatsAppMessage.find({
      isScheduled: true,
      status: "scheduled",
      scheduledFor: { $lte: now },
    }).populate("sender receiver client");

    const results = {
      sent: 0,
      failed: 0,
      errors: [],
    };

    for (const message of scheduledMessages) {
      try {
        // Update message status to sent
        message.isScheduled = false;
        message.status = "sent";
        message.sentAt = new Date();

        await message.save();

        // Send real-time notifications to receivers via Socket.IO
        if (io) {
          const receiverIds = message.receiver.map((receiver) =>
            typeof receiver === "string" ? receiver : receiver._id
          );

          // Notify each receiver using new_message event
          receiverIds.forEach((receiverId) => {
            io.to(`employee_${receiverId}`).emit("new_message", {
              message: message,
              type: "scheduled_message_delivered",
            });
          });

          // Notify in client room using new_message event
          const clientId =
            typeof message.client === "string"
              ? message.client
              : message.client?._id;
          if (clientId) {
            io.to(`client_${clientId}`).emit("new_message", {
              message: message,
              type: "scheduled_message_delivered",
            });
          }

          // Notify sender that scheduled message was sent
          const senderId =
            typeof message.sender === "string"
              ? message.sender
              : message.sender?._id;
          if (senderId) {
            io.to(`employee_${senderId}`).emit("new_message", {
              message: message,
              type: "scheduled_message_sent",
            });
          }
        }

        console.log(
          `Sent scheduled message: ${message._id} to ${message.receiver.length} recipients`
        );
        results.sent++;
      } catch (error) {
        console.error(
          `Failed to send scheduled message ${message._id}:`,
          error
        );
        results.failed++;
        results.errors.push({
          messageId: message._id,
          error: error.message,
        });
      }
    }

    return results;
  } catch (e) {
    console.error("Error in sendScheduledMessages:", e);
    throw e;
  }
};
// PATCH /api/assignment-messages/:id/approve
exports.approveMessage = async function approveMessage(req, res) {
  try {
    const { id } = req.params;
    const msg = await WhatsAppMessage.findById(id).populate("sender");
    if (!msg) return res.status(404).json({ error: "Message not found" });

    const userRole = normalizeRole(req.employee?.role || "");
    if (userRole !== "team_lead") {
      return res
        .status(403)
        .json({ error: "Only Team Leads can approve messages" });
    }

    msg.approvalStatus = "approved";
    await msg.save();

    // ✅ Forward only if sender was an Employee under supervision
    const senderRole = normalizeRole(msg.sender?.role || "");
    if (senderRole === "employee") {
      const { managers } = await findTLsAndManagersByOwner(msg.owner);
      if (managers.length > 0) {
        const forwardMsg = await WhatsAppMessage.create({
          owner: msg.owner,
          client: msg.client,
          sender: msg.sender,
          receiver: managers,
          subject: `Approved: ${msg.subject || "No Subject"}`,
          note: msg.note || "",
          attachments: msg.attachments,
        });

        const populated = await forwardMsg.populate([
          { path: "owner", select: "_id name companyEmail" },
          { path: "sender", select: "_id name companyEmail role" },
          { path: "receiver", select: "_id name companyEmail role" },
          { path: "client", select: "_id clientName" },
        ]);

        if (req.app.get("io")) {
          const io = req.app.get("io");
          io.to(`employee_${msg.sender._id}`).emit("new_message", {
            message: populated,
            type: "message_approved",
          });
          managers.forEach((managerId) => {
            io.to(`employee_${managerId}`).emit("new_message", {
              message: populated,
              type: "new_approved_message",
            });
          });
          io.to(`employee_${req.employee._id}`).emit("new_message", {
            message: populated,
            type: "approval_success",
          });
        }

        return res.json(populated);
      }
    }

    return res.json({ message: "Message approved" });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to approve message" });
  }
};

// PATCH /api/assignment-messages/:id/disapprove
exports.disapproveMessage = async function disapproveMessage(req, res) {
  try {
    const { id } = req.params;
    const msg = await WhatsAppMessage.findById(id);
    if (!msg) return res.status(404).json({ error: "Message not found" });

    const userRole = normalizeRole(req.employee?.role || "");
    if (userRole !== "team_lead") {
      return res
        .status(403)
        .json({ error: "Only Team Leads can disapprove messages" });
    }

    msg.approvalStatus = "disapproved";
    await msg.save();

    // Emit new_message event for disapproval
    if (req.app.get("io")) {
      const io = req.app.get("io");

      // Notify original sender about disapproval
      io.to(`employee_${msg.sender}`).emit("new_message", {
        message: msg,
        type: "message_disapproved",
      });

      // Notify Team Lead about successful disapproval
      io.to(`employee_${req.employee._id}`).emit("new_message", {
        message: msg,
        type: "disapproval_success",
      });
    }

    res.json(msg);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to disapprove message" });
  }
};

// GET /api/assignment-messages/:id
exports.getMessage = async function getMessage(req, res) {
  try {
    const msg = await WhatsAppMessage.findById(req.params.id).populate([
      { path: "owner", select: "_id name companyEmail" },
      { path: "sender", select: "_id name companyEmail role" },
      { path: "receiver", select: "_id name companyEmail role" },
      { path: "client", select: "_id clientName" },
      { path: "attachments.uploadedBy", select: "_id name companyEmail" },
      { path: "scheduledBy", select: "_id name companyEmail" },
    ]);
    if (!msg) return res.status(404).json({ error: "Not found" });
    res.json(msg);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to fetch message" });
  }
};

// PATCH /api/assignment-messages/:id
exports.updateMessage = async function updateMessage(req, res) {
  try {
    const { subject, note } = req.body;
    const msg = await WhatsAppMessage.findById(req.params.id);
    if (!msg) return res.status(404).json({ error: "Not found" });

    // Optional: prevent changing approvalStatus here from API callers.
    // (We leave it out intentionally to keep status flow via approve/disapprove)
    if (typeof subject === "string") msg.subject = subject;
    if (typeof note === "string") msg.note = note;

    await msg.save();
    const populated = await msg.populate([
      { path: "owner", select: "_id name companyEmail" },
      { path: "sender", select: "_id name companyEmail role" },
      { path: "receiver", select: "_id name companyEmail role" },
      { path: "client", select: "_id clientName" },
      { path: "attachments.uploadedBy", select: "_id name companyEmail" },
      { path: "scheduledBy", select: "_id name companyEmail" },
    ]);

    // Emit new_message event for update
    if (req.app.get("io")) {
      const io = req.app.get("io");

      // Notify sender about update
      io.to(`employee_${msg.sender}`).emit("new_message", {
        message: populated,
        type: "message_updated",
      });

      // Notify receivers about update
      msg.receiver.forEach((receiverId) => {
        io.to(`employee_${receiverId}`).emit("new_message", {
          message: populated,
          type: "message_updated",
        });
      });
    }

    res.json(populated);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to update message" });
  }
};

// DELETE /api/assignment-messages/:id
exports.deleteMessage = async function deleteMessage(req, res) {
  try {
    const msg = await WhatsAppMessage.findByIdAndDelete(req.params.id);
    if (!msg) return res.status(404).json({ error: "Not found" });

    // Emit new_message event for deletion
    if (req.app.get("io")) {
      const io = req.app.get("io");

      // Notify sender about deletion
      io.to(`employee_${msg.sender}`).emit("new_message", {
        message: msg,
        type: "message_deleted",
      });

      // Notify receivers about deletion
      msg.receiver.forEach((receiverId) => {
        io.to(`employee_${receiverId}`).emit("new_message", {
          message: msg,
          type: "message_deleted",
        });
      });
    }

    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to delete message" });
  }
};

// POST /api/assignment-messages/:id/attachments
exports.uploadAttachments = async function uploadAttachments(req, res) {
  try {
    const msg = await WhatsAppMessage.findById(req.params.id);
    if (!msg) return res.status(404).json({ error: "Not found" });

    const files = (req.files || []).map((f) => ({
      filename: path.basename(f.filename),
      originalName: f.originalname,
      mimetype: f.mimetype,
      size: f.size,
      url: buildPublicUrl(req, f.filename),
      uploadedAt: new Date(),
      uploadedBy: req.employee?._id || undefined,
    }));

    msg.attachments.push(...files);
    await msg.save();

    const populated = await msg.populate([
      { path: "attachments.uploadedBy", select: "_id name companyEmail" },
    ]);

    // Emit new_message event for attachment upload
    if (req.app.get("io")) {
      const io = req.app.get("io");

      // Notify sender about attachment upload
      io.to(`employee_${msg.sender}`).emit("new_message", {
        message: populated,
        type: "attachments_uploaded",
      });

      // Notify receivers about new attachments
      msg.receiver.forEach((receiverId) => {
        io.to(`employee_${receiverId}`).emit("new_message", {
          message: populated,
          type: "attachments_added",
        });
      });
    }

    res.status(201).json(populated.attachments);
  } catch (e) {
    console.error(e);
    res.status(500).json({
      error: "Attachment upload failed (only PDF/XLS/XLSX; up to 20MB each)",
    });
  }
};

// GET /api/assignment-messages/:id/attachments
exports.listAttachments = async function listAttachments(req, res) {
  try {
    const msg = await WhatsAppMessage.findById(req.params.id).populate([
      { path: "attachments.uploadedBy", select: "_id name companyEmail" },
    ]);
    if (!msg) return res.status(404).json({ error: "Not found" });
    res.json(msg.attachments || []);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to load attachments" });
  }
};

// DELETE /api/assignment-messages/:id/attachments/:attId
exports.deleteAttachment = async function deleteAttachment(req, res) {
  try {
    const { id, attId } = req.params;
    const msg = await WhatsAppMessage.findById(id);
    if (!msg) return res.status(404).json({ error: "Not found" });

    const before = msg.attachments.length;
    msg.attachments = msg.attachments.filter((a) => a._id.toString() !== attId);
    const after = msg.attachments.length;

    if (before === after)
      return res.status(404).json({ error: "Attachment not found" });

    await msg.save();

    // Emit new_message event for attachment deletion
    if (req.app.get("io")) {
      const io = req.app.get("io");

      // Notify sender about attachment deletion
      io.to(`employee_${msg.sender}`).emit("new_message", {
        message: msg,
        type: "attachment_deleted",
      });

      // Notify receivers about attachment deletion
      msg.receiver.forEach((receiverId) => {
        io.to(`employee_${receiverId}`).emit("new_message", {
          message: msg,
          type: "attachment_deleted",
        });
      });
    }

    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to delete attachment" });
  }
};

// GET /api/assignment-messages/sent
// Required: client (ObjectId) – only show messages the current user sent to this client
exports.listMySentToClient = async function listMySentToClient(req, res) {
  try {
    const client = req.query.client || req.query.clientId || null;
    const owner = req.query.owner || req.employee?.owner || null;

    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(
      Math.max(parseInt(req.query.limit, 10) || 50, 1),
      200
    );

    const me = req.employee?._id ? String(req.employee._id) : null;

    if (!isObjId(me)) {
      return res
        .status(401)
        .json({ error: "Unauthorized: missing employee session" });
    }
    if (!isObjId(client)) {
      return res
        .status(400)
        .json({ error: "client is required (ObjectId string)" });
    }

    const q = {
      sender: me, // only messages I sent
      client: client, // to this client
    };
    if (isObjId(owner)) q.owner = owner;

    const [items, total] = await Promise.all([
      WhatsAppMessage.find(q)
        .sort({ createdAt: 1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate([
          { path: "owner", select: "_id name companyEmail" },
          { path: "sender", select: "_id name companyEmail role" },
          { path: "receiver", select: "_id name companyEmail role" },
          { path: "client", select: "_id clientName" },
          { path: "attachments.uploadedBy", select: "_id name companyEmail" },
          { path: "scheduledBy", select: "_id name companyEmail" },
        ])
        .lean(),
      WhatsAppMessage.countDocuments(q),
    ]);

    return res.json({
      items,
      total,
      page,
      pages: Math.ceil(total / limit),
      limit,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Failed to load sent messages" });
  }
};
