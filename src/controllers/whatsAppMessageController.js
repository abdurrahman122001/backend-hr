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
  if (["teamlead", "team lead", "team_lead", "team-lead", "lead"].includes(r))
    return "team_lead";
  if (r === "manager") return "manager";
  if (["employee", "staff", "associate"].includes(r)) return "employee";
  return r;
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
/** ---------- CLIENT SUPERVISION HELPER FUNCTIONS ---------- **/
async function getClientSupervision(clientId) {
  if (!isObjId(clientId)) return "direct";

  const Client = require("../models/ClientInfo");
  const client = await Client.findById(clientId).select("supervision").lean();

  return client?.supervision || "direct";
}

async function clientRequiresApproval(clientId) {
  const supervision = await getClientSupervision(clientId);
  return supervision === "needs_approval";
}

async function applyVisibility(q, req) {
  if (!req.employee?._id) return q;

  const me = oid(String(req.employee._id));
  if (!me) return q;

  const currentUserRole = normalizeRole(req.employee?.role || "");
  const ownerId = req.employee?.owner ? oid(req.employee.owner) : null;

  // 🧑‍💼 MANAGER / OWNER: can see everything for their owner
  if ((currentUserRole === "manager" || currentUserRole === "owner") && ownerId) {
    return { ...q, owner: ownerId };
  }

  // 🧑‍🤝‍🧑 TEAM LEAD: can see messages where they are involved OR manager messages for supervision
  if (currentUserRole === "team_lead") {
    // Get all managers in the same organization
    const { managers } = await findTLsAndManagersByOwner(ownerId);

    // Create visibility conditions
    const visibilityConditions = {
      $or: [
        { sender: me },
        { receiver: me },
        { receiver: { $in: [me] } },
        // Allow team leads to see manager messages
        {
          sender: { $in: managers.map((id) => oid(id)) },
          owner: ownerId,
        },
        // 🔥 NEW: Allow team leads to see messages from clients requiring approval
        {
          approvalStatus: "pending",
          owner: ownerId,
        },
      ],
    };

    // CRITICAL FIX: Combine original query with visibility conditions using $and
    // This preserves the text search while applying visibility rules
    return {
      $and: [q, visibilityConditions]
    };
  }

  // 👷 NORMAL EMPLOYEE: can see messages where they are sender OR receiver
  const now = new Date();
  const visOr = [{ sender: me }, { receiver: me }, { receiver: { $in: [me] } }];

  if (q.isScheduled === true && q.status === "scheduled") {
    return { $and: [q, { $or: visOr }] };
  }

  const scheduledVisibility = {
    $or: [
      {
        $and: [
          {
            $or: [
              { isScheduled: { $ne: true } },
              { isScheduled: true, status: "sent" },
              {
                isScheduled: true,
                status: "scheduled",
                scheduledFor: { $lte: now },
              },
            ],
          },
          { $or: visOr },
        ],
      },
      {
        isScheduled: true,
        status: "scheduled",
        scheduledFor: { $gt: now },
        sender: me,
      },
    ],
  };

  // Combine with original query
  return {
    $and: [q, scheduledVisibility],
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
      limit = 5, // 🎯 CHANGE: Default limit to 5
      page = 1,
      cursor,
      direction = "after",
      between: betweenRaw,
      filter,
      approvalStatus,
    } = req.query;

    const q = {};

    // Owner / client scope
    if (isObjId(owner)) q.owner = owner;
    else if (req.employee?.owner) q.owner = req.employee.owner;
    if (isObjId(client)) q.client = client;

    // Status filter
    if (
      status &&
      ["draft", "scheduled", "sent", "cancelled"].includes(status)
    ) {
      q.status = status;
      if (status === "draft") q.isScheduled = false;
    } else {
      // Exclude drafts by default
      q.status = { $ne: "draft" };
    }

    // Approval status filter
    if (
      approvalStatus &&
      ["pending", "approved", "disapproved"].includes(approvalStatus)
    ) {
      q.approvalStatus = approvalStatus;
    }

    // "filter=scheduled"
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

    // Use normal user visibility rules for everyone
    const currentUserRole = normalizeRole(req.employee?.role || "");
    const isTeamLead = currentUserRole === "team_lead";
    const me = oid(String(req.employee._id));

    const between = normalizeIds(betweenRaw);
    if (between.length === 2) {
      const [a, b] = between;
      q.$or = [
        { sender: a, receiver: { $in: [b] } },
        { sender: b, receiver: { $in: [a] } },
        { sender: a, receiver: b },
        { sender: b, receiver: a },
      ];
    } else if (isObjId(participant)) {
      q.$or = [
        { sender: participant },
        { receiver: participant },
        { receiver: { $in: [participant] } },
      ];
    } else {
      if (isObjId(sender)) q.sender = sender;
      if (isObjId(receiver)) {
        q.$or = [{ receiver: receiver }, { receiver: { $in: [receiver] } }];
      }
    }

    // Must have at least one scope
    if (
      !q.owner &&
      !q.client &&
      !q.sender &&
      !q.receiver &&
      !q.$or &&
      !q.status &&
      q.isScheduled === undefined &&
      !q.approvalStatus
    ) {
      return res.status(400).json({
        error:
          "Provide at least one scope: owner, client, sender, receiver, participant, status, approvalStatus, or isScheduled",
      });
    }

    // Apply visibility rules
    const qFinal = await applyVisibility(q, req);

    // 🎯 NEW: Cursor-based pagination logic
    if (cursor && isObjId(cursor)) {
      const cursorMessage = await WhatsAppMessage.findById(cursor)
        .select("createdAt")
        .lean();

      if (cursorMessage) {
        if (direction === "before") {
          qFinal.createdAt = { $lt: cursorMessage.createdAt };
        } else {
          qFinal.createdAt = { $gt: cursorMessage.createdAt };
        }
      }
    }

    const sortOrder =
      direction === "before" ? { createdAt: -1 } : { createdAt: -1 };
    const lim = Math.min(Math.max(parseInt(limit, 10) || 5, 1), 50);

    // 🎯 Fetch with limit + 1 for pagination check
    const items = await WhatsAppMessage.find(qFinal)
      .sort(sortOrder)
      .limit(lim + 1)
      .populate([
        { path: "owner", select: "_id name companyEmail" },
        { path: "sender", select: "_id name companyEmail role" },
        { path: "receiver", select: "_id name companyEmail role" },
        { path: "client", select: "_id clientName" },
        { path: "attachments.uploadedBy", select: "_id name companyEmail" },
        { path: "scheduledBy", select: "_id name companyEmail" },
        { path: "repliedTo", select: "_id note message sender attachments" },
        {
          path: "replyContent.originalSender",
          select: "_id name companyEmail",
        },
      ])
      .lean();

    // 🎯 NEW: Pagination metadata
    let hasMore = false;
    let nextCursor = null;
    let prevCursor = null;

    if (items.length > lim) {
      hasMore = true;
      items.pop(); // Remove the extra one
    }

    if (items.length > 0) {
      if (direction === "before") {
        nextCursor = items[items.length - 1]?._id || null;
        prevCursor = items[0]?._id || null;
      } else {
        nextCursor = items[0]?._id || null;
        prevCursor = items[items.length - 1]?._id || null;
      }
    }

    // For initial load, reverse to show newest at bottom
    if (!cursor || direction === "after") {
      items.reverse();
    }

    // CRITICAL FIX: Ensure receiver is always treated as array for consistency
    const normalizedItems = items.map((item) => ({
      ...item,
      receiver: Array.isArray(item.receiver)
        ? item.receiver
        : [item.receiver].filter(Boolean),
    }));

    const total = await WhatsAppMessage.countDocuments(qFinal);
    const pageNum = Math.max(parseInt(page, 10) || 1, 1);

    res.json({
      items: normalizedItems,
      total,
      page: pageNum,
      pages: Math.ceil(total / lim),
      limit: lim,
      pagination: {
        hasMore,
        nextCursor,
        prevCursor,
        direction,
      },
      userRole: currentUserRole,
      isTeamLead: isTeamLead,
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

    // 🎯 NEW: Add pagination parameters with LIMIT 5 as default
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 5, 1), 50);
    const cursor = req.query.cursor;
    const direction = req.query.direction || "after";

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
      if (status === "draft") q.isScheduled = false;
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

    // 🎯 FIXED: Proper cursor-based pagination logic
    if (cursor && isObjId(cursor)) {
      const cursorMessage = await WhatsAppMessage.findById(cursor)
        .select("createdAt")
        .lean();

      if (cursorMessage) {
        if (direction === "before") {
          // For loading OLDER messages (scroll up) - get messages BEFORE cursor
          qFinal.createdAt = { $lt: cursorMessage.createdAt };
        } else if (direction === "after") {
          // For loading NEWER messages (scroll down or real-time) - get messages AFTER cursor
          qFinal.createdAt = { $gt: cursorMessage.createdAt };
        }
      }
    }

    // 🎯 FIXED: Correct sort order based on direction
    let sortOrder;
    if (direction === "before") {
      // When loading OLDER messages, we want descending (newest first) because we're going backwards
      sortOrder = { createdAt: -1 };
    } else {
      // When loading NEWER messages (initial load), we want descending (newest first)
      sortOrder = { createdAt: -1 };
    }

    // 🎯 Fetch messages with limit + 1 to check if there are more
    const messages = await WhatsAppMessage.find(qFinal)
      .sort(sortOrder)
      .limit(limit + 1) // Get one extra to check if there are more
      .populate([
        { path: "owner", select: "_id name companyEmail" },
        { path: "sender", select: "_id name companyEmail role" },
        { path: "receiver", select: "_id name companyEmail role" },
        { path: "client", select: "_id clientName" },
        { path: "attachments.uploadedBy", select: "_id name companyEmail" },
        { path: "repliedTo", select: "_id note message sender attachments" },
        {
          path: "replyContent.originalSender",
          select: "_id name companyEmail",
        },
      ])
      .lean();

    // 🎯 NEW: Check if there are more messages
    let hasMore = false;
    let nextCursor = null;
    let prevCursor = null;

    if (messages.length > limit) {
      hasMore = true;
      messages.pop(); // Remove the extra one
    }

    // 🎯 Set cursor for next/prev pagination
    if (messages.length > 0) {
      if (direction === "before") {
        // For loading older messages:
        // nextCursor = oldest message in this batch (for loading even older)
        nextCursor = messages[messages.length - 1]?._id || null;
        // prevCursor = newest message in this batch (for loading newer)
        prevCursor = messages[0]?._id || null;
      } else {
        // For loading newer messages (initial load):
        // nextCursor = newest message in this batch (for loading even newer)
        nextCursor = messages[0]?._id || null;
        // prevCursor = oldest message in this batch (for loading older)
        prevCursor = messages[messages.length - 1]?._id || null;
      }
    }

    // 🎯 FIXED: Only reverse for frontend display, not for cursor logic
    // The frontend needs messages in chronological order (oldest to newest)
    // But our query gets them in reverse chronological order (newest to oldest)
    const displayMessages = [...messages].reverse();

    // 🔥 Get client supervision info for each message
    const Client = require("../models/ClientInfo");
    const messagesWithSupervision = await Promise.all(
      displayMessages.map(async (message) => {
        if (message.client) {
          const clientDoc = await Client.findById(message.client)
            .select("supervision clientName")
            .lean();
          return {
            ...message,
            clientSupervision: clientDoc?.supervision || "direct",
            clientName: clientDoc?.clientName || "Unknown",
            requiresApproval: clientDoc?.supervision === "needs_approval",
          };
        }
        return message;
      })
    );

    return res.json({
      messages: messagesWithSupervision,
      pagination: {
        hasMore,
        nextCursor,
        prevCursor,
        limit,
        direction,
      },
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Failed to load message history" });
  }
};
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
      isReply,
      repliedTo,
      replyContent,
    } = req.body;

    const owner = ownerBody || req.employee?.owner;
    const sender = senderBody || req.employee?._id;

    if (!isObjId(owner) || !isObjId(client) || !isObjId(sender)) {
      return res.status(400).json({
        error: "owner, client, and sender are required (ObjectId strings)",
      });
    }

    // Start with ONLY the explicitly specified receivers
    let receivers = [];
    if (receiverBody) receivers = receivers.concat(normalizeIds(receiverBody));
    if (receiversBody)
      receivers = receivers.concat(normalizeIds(receiversBody));

    // Remove sender from receivers
    receivers = receivers.filter((id) => id !== String(sender));

    const senderDoc = await Employee.findById(sender)
      .select("_id role supervisor owner")
      .lean();
    const senderRole = normalizeRole(senderDoc?.role || "");

    let approvalStatus;

    // 🔥 CLIENT-BASED SUPERVISION: Get supervision mode from CLIENT, not employee
    const Client = require("../models/ClientInfo");
    const clientDoc = await Client.findById(client)
      .populate("assignedTo", "_id role name companyEmail")
      .lean();

    // Use client's supervision setting, fallback to "direct" if not set
    const clientSupervision = clientDoc?.supervision || "direct";
    const needsApproval = clientSupervision === "needs_approval";
    const isDirect = clientSupervision === "direct";

    const { tls, managers } = await findTLsAndManagersByOwner(owner);

    // 🔥 GET ASSIGNED EMPLOYEE FROM CLIENT
    const assignedEmployeeId = clientDoc?.assignedTo
      ? String(clientDoc.assignedTo._id)
      : null;

    // 🔥 CRITICAL UPDATE: TEAM LEAD LOGIC - SEND TO MANAGERS AND ASSIGNED EMPLOYEE
    if (senderRole === "team_lead") {
      // Clear any existing receivers (don't use arbitrary receivers)
      receivers = [];

      // Add managers as receivers
      if (managers.length > 0) {
        managers.forEach((managerId) => {
          if (!receivers.includes(managerId) && managerId !== String(sender)) {
            receivers.push(managerId);
          }
        });
      }

      // 🔥 CRITICAL FIX: ADD ASSIGNED EMPLOYEE AS RECEIVER
      if (assignedEmployeeId && assignedEmployeeId !== String(sender)) {
        if (!receivers.includes(assignedEmployeeId)) {
          receivers.push(assignedEmployeeId);
        }
      }

      // Get CRM employee ID from environment or database
      const crmEmployeeId = process.env.CRM_EMPLOYEE_ID;

      // Option 2: Find CRM user by role or email from database
      let crmUser = null;
      if (!crmEmployeeId) {
        crmUser = await Employee.findOne({
          owner: owner,
          $or: [
            { role: /crm/i },
            { role: /customer relationship/i },
            { companyEmail: /crm/i },
            { name: /CRM/i },
          ],
        })
          .select("_id")
          .lean();
      }

      const crmId = crmEmployeeId || (crmUser ? String(crmUser._id) : null);

      if (crmId && !receivers.includes(crmId) && crmId !== String(sender)) {
        receivers.push(crmId);
      }

      // Team leads don't need approval
      approvalStatus = null;
    }
    // 🔥 MANAGER LOGIC - SEND TO TEAM LEADS AND ASSIGNED EMPLOYEE
    else if (senderRole === "manager") {
      // Add team leads to receivers for supervision visibility
      tls.forEach((teamLeadId) => {
        if (!receivers.includes(teamLeadId) && teamLeadId !== String(sender)) {
          receivers.push(teamLeadId);
        }
      });

      // 🔥 ADD ASSIGNED EMPLOYEE AS RECEIVER
      if (assignedEmployeeId && assignedEmployeeId !== String(sender)) {
        if (!receivers.includes(assignedEmployeeId)) {
          receivers.push(assignedEmployeeId);
        }
      }

      // Managers don't need approval
      approvalStatus = null;
    }
    // 👷 EMPLOYEE LOGIC: Use assigned employee and CLIENT-BASED supervision rules
    else if (senderRole === "employee") {
      // ✅ Include assignedTo employee if present (but only if not already included)
      if (assignedEmployeeId && assignedEmployeeId !== String(sender)) {
        if (!receivers.includes(assignedEmployeeId)) {
          receivers.push(assignedEmployeeId);
        }
      }
    }

    // 🔑 CORRECTED Approval status logic - NOW CLIENT-BASED
    if (senderRole === "manager") {
      approvalStatus = null;
      // Managers don't need approval, but team leads are now included as receivers
    } else if (senderRole === "team_lead") {
      approvalStatus = null;
      // Team leads don't need approval, and we send to managers + assigned employee + CRM
    } else if (needsApproval) {
      // 🔥 CLIENT-BASED: Client needs approval - add team leads for review
      approvalStatus = "pending";
      // Add team leads only if the client requires approval
      if (tls.length > 0) {
        receivers = [...receivers, ...tls.map((id) => String(id))];
      }
    } else if (isDirect) {
      // 🔥 CLIENT-BASED: DIRECT SUPERVISION - NO TEAM LEADS INVOLVED
      approvalStatus = "approved";
      // Don't add any team leads or managers - message goes directly to intended receivers
    }

    // 🔥 FIXED: Handle reply scenario - Preserve original receivers and add assigned employee
    if (isReply && repliedTo) {
      try {
        // Get the original message being replied to
        const originalMessage = await WhatsAppMessage.findById(repliedTo)
          .populate("sender receiver", "_id role name companyEmail")
          .lean();

        if (originalMessage) {
          // Extract original receivers
          const originalReceivers = originalMessage.receiver.map((r) =>
            typeof r === "object" ? String(r._id) : String(r)
          );

          // Add original receivers (excluding sender)
          originalReceivers.forEach((receiverId) => {
            if (
              receiverId !== String(sender) &&
              !receivers.includes(receiverId)
            ) {
              receivers.push(receiverId);
            }
          });

          // 🔥 SPECIAL CASE: If team lead is replying, ensure assigned employee is included
          if (
            senderRole === "team_lead" &&
            assignedEmployeeId &&
            assignedEmployeeId !== String(sender)
          ) {
            if (!receivers.includes(assignedEmployeeId)) {
              receivers.push(assignedEmployeeId);
            }
          }

          // Also add original sender if not already included
          const originalSenderId = originalMessage.sender
            ? typeof originalMessage.sender === "object"
              ? String(originalMessage.sender._id)
              : String(originalMessage.sender)
            : null;

          if (
            originalSenderId &&
            originalSenderId !== String(sender) &&
            !receivers.includes(originalSenderId)
          ) {
            receivers.push(originalSenderId);
          }
        }
      } catch (replyError) {
        console.warn("Failed to process reply context:", replyError);
      }
    }

    // 🔥 Fallback logic if no receivers are still found
    if (receivers.length === 0) {
      if (senderRole === "employee") {
        if (isDirect) {
          // For client with direct mode, add managers for visibility
          receivers = [...managers];
          approvalStatus = "approved";
        } else {
          // For client with needs_approval mode, add team leads
          receivers = [...tls];
          approvalStatus = "pending";
        }
      } else if (senderRole === "team_lead") {
        // Team lead with no receivers - add managers and assigned employee as fallback
        receivers = [...managers];

        // Add assigned employee in fallback too
        if (assignedEmployeeId && assignedEmployeeId !== String(sender)) {
          receivers.push(assignedEmployeeId);
        }

        // Try to add CRM again in fallback
        const crmEmployeeId = process.env.CRM_EMPLOYEE_ID;
        if (crmEmployeeId && !receivers.includes(crmEmployeeId)) {
          receivers.push(crmEmployeeId);
        }

        approvalStatus = null;
      } else if (senderRole === "manager") {
        // Manager with no receivers - add team leads and assigned employee
        receivers = [...tls];

        // Add assigned employee in fallback
        if (assignedEmployeeId && assignedEmployeeId !== String(sender)) {
          receivers.push(assignedEmployeeId);
        }

        approvalStatus = null;
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
      sentAt = null;
    }

    const msgData = {
      owner,
      client,
      sender,
      receiver: receivers,
      subject: subject || "",
      note: note || "",
      approvalStatus: approvalStatus,
      isScheduled,
      status,
      scheduledFor: isScheduled ? new Date(scheduledFor) : undefined,
      attachments: [],
      scheduledAt,
      scheduledBy,
      sentAt: !isScheduled ? new Date() : undefined,
      isReply: isReply || false,
      repliedTo: isReply ? repliedTo : null,
      replyContent: isReply ? replyContent : null,
    };

    const msg = await WhatsAppMessage.create(msgData);

    const populated = await msg.populate([
      { path: "owner", select: "_id name companyEmail" },
      { path: "sender", select: "_id name companyEmail role" },
      { path: "receiver", select: "_id name companyEmail role" },
      { path: "client", select: "_id clientName assignedTo" },
      { path: "scheduledBy", select: "_id name companyEmail" },
      { path: "repliedTo", select: "_id note message sender attachments" },
      { path: "replyContent.originalSender", select: "_id name companyEmail" },
    ]);

    // Get assigned employee info for response
    const assignedEmployeeInfo = clientDoc?.assignedTo
      ? {
          id: clientDoc.assignedTo._id,
          name: clientDoc.assignedTo.name,
          email: clientDoc.assignedTo.companyEmail,
          role: clientDoc.assignedTo.role,
        }
      : null;

    // Add client supervision info to response
    const responseWithSupervision = {
      ...populated.toObject(),
      clientSupervision: clientSupervision,
      requiresApproval: needsApproval,
      teamLeadsIncluded: senderRole === "manager", // Indicate if team leads were added
      assignedEmployeeIncluded: assignedEmployeeId
        ? receivers.includes(assignedEmployeeId)
        : false,
      crmIncluded: senderRole === "team_lead", // Indicate if CRM was added
      managersIncluded: senderRole === "team_lead", // Indicate if managers were added (for team lead messages)
      totalReceivers: receivers.length,
      assignedEmployee: assignedEmployeeInfo,
      receiverSummary: {
        role: senderRole,
        sentToManagers: senderRole === "team_lead",
        sentToTeamLeads: senderRole === "manager",
        sentToAssignedEmployee: assignedEmployeeId
          ? receivers.includes(assignedEmployeeId)
          : false,
        sentToCRM: senderRole === "team_lead",
        isReply: isReply || false,
        replyToMessageId: isReply ? repliedTo : null,
      },
    };

    // FIXED: Emit real-time events ONLY to relevant users
    if (req.app.get("io")) {
      const io = req.app.get("io");

      // Notify ALL receivers
      receivers.forEach((receiverId) => {
        io.to(`employee_${receiverId}`).emit("new_message", {
          message: responseWithSupervision,
          type: "new_assignment",
        });
      });

      // Notify sender
      io.to(`employee_${sender}`).emit("new_message", {
        message: responseWithSupervision,
        type: "message_created",
      });

      // 🔥 SPECIAL NOTIFICATION: When team lead sends/replies, notify assigned employee
      if (
        senderRole === "team_lead" &&
        assignedEmployeeId &&
        receivers.includes(assignedEmployeeId)
      ) {
        io.to(`employee_${assignedEmployeeId}`).emit("new_message", {
          message: responseWithSupervision,
          type: "team_lead_direct_message",
          note: "Team Lead has sent you a direct message regarding this client",
          clientName: clientDoc?.clientName || "Unknown Client",
        });
      }

      // Special notification for managers when team lead sends message
      if (senderRole === "team_lead") {
        managers.forEach((managerId) => {
          if (receivers.includes(managerId)) {
            io.to(`employee_${managerId}`).emit("new_message", {
              message: responseWithSupervision,
              type: "team_lead_message_to_manager",
              note: "Team Lead has sent you a message regarding client communication",
            });
          }
        });

        // Special notification for CRM when team lead sends message
        const crmEmployeeId = process.env.CRM_EMPLOYEE_ID;
        if (crmEmployeeId && receivers.includes(crmEmployeeId)) {
          io.to(`employee_${crmEmployeeId}`).emit("new_message", {
            message: responseWithSupervision,
            type: "team_lead_message_to_crm",
            note: "Team Lead has sent a message that requires CRM attention",
          });
        }
      }

      // Special notification for team leads when manager sends message
      if (senderRole === "manager") {
        tls.forEach((teamLeadId) => {
          if (receivers.includes(teamLeadId)) {
            io.to(`employee_${teamLeadId}`).emit("new_message", {
              message: responseWithSupervision,
              type: "manager_message_visibility",
              note: "You are included as a receiver for manager message visibility",
            });
          }
        });

        // Special notification for assigned employee when manager sends message
        if (assignedEmployeeId && receivers.includes(assignedEmployeeId)) {
          io.to(`employee_${assignedEmployeeId}`).emit("new_message", {
            message: responseWithSupervision,
            type: "manager_direct_message",
            note: "Manager has sent you a direct message",
          });
        }
      }
    }

    res.status(201).json(responseWithSupervision);
  } catch (e) {
    console.error("❌ Create message error:", e);
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

    // FIXED: Emit events ONLY to relevant users
    if (req.app.get("io")) {
      const io = req.app.get("io");

      // Notify sender about successful scheduling
      io.to(`employee_${req.employee._id}`).emit("new_message", {
        message: populated,
        type: "message_scheduled",
      });

      // Notify ONLY the actual receivers
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

    // FIXED: Emit events ONLY to relevant users
    if (req.app.get("io")) {
      const io = req.app.get("io");

      const eventType =
        action === "send" ? "message_sent" : "message_unscheduled";

      // Notify sender
      io.to(`employee_${req.employee._id}`).emit("new_message", {
        message: populated,
        type: eventType,
      });

      // If sent immediately, notify ONLY the actual receivers
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

    // FIXED: Emit events ONLY to relevant users
    if (req.app.get("io")) {
      const io = req.app.get("io");

      // Notify sender about successful rescheduling
      io.to(`employee_${req.employee._id}`).emit("new_message", {
        message: populated,
        type: "message_rescheduled",
      });

      // Notify ONLY the actual receivers about schedule update
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

        // Send real-time notifications ONLY to relevant users via Socket.IO
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
// PATCH /api/assignment-messages/:id/approve
exports.approveMessage = async function approveMessage(req, res) {
  try {
    const { id } = req.params;
    const msg = await WhatsAppMessage.findById(id).populate([
      { path: "sender", select: "_id name companyEmail role" },
      { path: "receiver", select: "_id name companyEmail role" },
      { path: "client", select: "_id clientName" },
      { path: "replyContent.originalSender", select: "_id name companyEmail" },
      { path: "repliedTo", select: "_id note message sender attachments" },
    ]);

    if (!msg) return res.status(404).json({ error: "Message not found" });

    // 🔥 CHECK CLIENT SUPERVISION
    const Client = require("../models/ClientInfo");
    const client = await Client.findById(msg.client)
      .select("supervision")
      .lean();
    const clientSupervision = client?.supervision || "direct";

    // Only allow approval if client has "needs_approval" supervision
    if (clientSupervision !== "needs_approval") {
      return res.status(400).json({
        error: "This client uses direct supervision. Approval not required.",
        clientSupervision: clientSupervision,
      });
    }

    const userRole = normalizeRole(req.employee?.role || "");
    if (userRole !== "team_lead") {
      return res
        .status(403)
        .json({ error: "Only Team Leads can approve messages" });
    }

    msg.approvalStatus = "approved";
    await msg.save();

    // Get fully populated message for real-time emission
    const populatedMsg = await WhatsAppMessage.findById(id).populate([
      { path: "owner", select: "_id name companyEmail" },
      { path: "sender", select: "_id name companyEmail role" },
      { path: "receiver", select: "_id name companyEmail role" },
      { path: "client", select: "_id clientName" },
      { path: "attachments.uploadedBy", select: "_id name companyEmail" },
      { path: "replyContent.originalSender", select: "_id name companyEmail" },
      { path: "repliedTo", select: "_id note message sender attachments" },
    ]);

    // Add client supervision info to the message
    const updatedMessage = {
      ...populatedMsg.toObject(),
      approvalStatus: "approved",
      clientSupervision: clientSupervision,
      requiresApproval: clientSupervision === "needs_approval",
    };

    // 🔥 CRITICAL FIX: Emit events to ALL relevant users
    if (req.app.get("io")) {
      const io = req.app.get("io");

      // 🎯 CRITICAL: Emit to ALL users involved in this message
      const allInvolvedUsers = new Set();

      // Add sender
      if (msg.sender && msg.sender._id) {
        allInvolvedUsers.add(String(msg.sender._id));
      }

      // Add all receivers
      if (msg.receiver && Array.isArray(msg.receiver)) {
        msg.receiver.forEach((receiver) => {
          const receiverId =
            typeof receiver === "object" ? receiver._id : receiver;
          if (receiverId) {
            allInvolvedUsers.add(String(receiverId));
          }
        });
      }

      // Add the team lead who approved
      allInvolvedUsers.add(String(req.employee._id));

      // Convert to array and emit to each user
      const involvedUsersArray = Array.from(allInvolvedUsers);

      involvedUsersArray.forEach((userId) => {
        io.to(`employee_${userId}`).emit("new_message", {
          message: updatedMessage,
          type: "message_updated",
          action: "approved",
          approvedBy: req.employee._id,
          timestamp: new Date(),
        });
      });

      // Also emit to the client room for real-time chat updates
      if (msg.client && msg.client._id) {
        io.to(`client_${msg.client._id}`).emit("new_message", {
          message: updatedMessage,
          type: "message_updated",
          action: "approved",
        });
      }
    }

    // ✅ Forward only if sender was an Employee under supervision
    const senderRole = normalizeRole(msg.sender?.role || "");
    if (senderRole === "employee") {
      const { managers } = await findTLsAndManagersByOwner(msg.owner);
      if (managers.length > 0) {
        // 🔥 CRITICAL FIX: Include replyContent and repliedTo in forwarded message
        const forwardMsgData = {
          owner: msg.owner,
          client: msg.client,
          sender: msg.sender,
          receiver: managers,
          subject: `Approved: ${msg.subject || "No Subject"}`,
          note: msg.note || "",
          attachments: msg.attachments,
          approvalStatus: "approved",
          // 🔥 INCLUDE REPLY CONTENT AND THREAD INFO
          isReply: msg.isReply,
          repliedTo: msg.repliedTo,
          replyContent: msg.replyContent,
          // Add metadata to identify this as a forwarded message
          isForwarded: true,
          originalMessage: msg._id,
          forwardedBy: req.employee._id,
          // Add client supervision info
          clientSupervision: clientSupervision,
        };

        const forwardMsg = await WhatsAppMessage.create(forwardMsgData);

        const populatedForward = await forwardMsg.populate([
          { path: "owner", select: "_id name companyEmail" },
          { path: "sender", select: "_id name companyEmail role" },
          { path: "receiver", select: "_id name companyEmail role" },
          { path: "client", select: "_id clientName" },
          { path: "forwardedBy", select: "_id name companyEmail" },
          {
            path: "replyContent.originalSender",
            select: "_id name companyEmail",
          },
          { path: "repliedTo", select: "_id note message sender attachments" },
        ]);

        // 🎯 CRITICAL: Emit new message event for the forwarded message to managers
        if (req.app.get("io")) {
          const io = req.app.get("io");
          // Notify managers about the new forwarded message
          managers.forEach((managerId) => {
            io.to(`employee_${managerId}`).emit("new_message", {
              message: populatedForward,
              type: "new_message",
              action: "forwarded_approved",
              forwardedBy: req.employee._id,
              originalMessageId: msg._id,
              clientSupervision: clientSupervision,
              // Include context about the reply chain
              replyContext: msg.isReply
                ? {
                    hasOriginalThread: true,
                    originalSender: msg.replyContent?.originalSender,
                    repliedToMessage: msg.repliedTo?._id,
                  }
                : null,
            });
          });
        }

        return res.json({
          ...updatedMessage,
          forwardedToManagers: true,
          forwardedMessage: populatedForward,
          message: "Message approved and forwarded to managers",
          clientSupervision: clientSupervision,
          // Include reply context in response
          replyContext: msg.isReply
            ? {
                includedReplyContent: true,
                originalThreadPreserved: true,
              }
            : null,
        });
      }
    }

    return res.json({
      ...updatedMessage,
      message: "Message approved successfully",
      clientSupervision: clientSupervision,
    });
  } catch (e) {
    console.error("❌ Error in approveMessage:", e);
    res.status(500).json({ error: "Failed to approve message" });
  }
};
// PATCH /api/assignment-messages/:id/disapprove
exports.disapproveMessage = async function disapproveMessage(req, res) {
  try {
    const { id } = req.params;
    const msg = await WhatsAppMessage.findById(id).populate([
      { path: "sender", select: "_id name companyEmail role" },
      { path: "receiver", select: "_id name companyEmail role" },
      { path: "client", select: "_id clientName" },
    ]);

    if (!msg) return res.status(404).json({ error: "Message not found" });

    // 🔥 CHECK CLIENT SUPERVISION
    const Client = require("../models/ClientInfo");
    const client = await Client.findById(msg.client)
      .select("supervision")
      .lean();
    const clientSupervision = client?.supervision || "direct";

    // Only allow disapproval if client has "needs_approval" supervision
    if (clientSupervision !== "needs_approval") {
      return res.status(400).json({
        error: "This client uses direct supervision. Disapproval not required.",
        clientSupervision: clientSupervision,
      });
    }

    const userRole = normalizeRole(req.employee?.role || "");
    if (userRole !== "team_lead") {
      return res
        .status(403)
        .json({ error: "Only Team Leads can disapprove messages" });
    }

    msg.approvalStatus = "disapproved";
    await msg.save();

    // Get fully populated message for real-time emission
    const populatedMsg = await WhatsAppMessage.findById(id).populate([
      { path: "owner", select: "_id name companyEmail" },
      { path: "sender", select: "_id name companyEmail role" },
      { path: "receiver", select: "_id name companyEmail role" },
      { path: "client", select: "_id clientName" },
      { path: "attachments.uploadedBy", select: "_id name companyEmail" },
    ]);

    // Add client supervision info
    const updatedMessage = {
      ...populatedMsg.toObject(),
      approvalStatus: "disapproved",
      clientSupervision: clientSupervision,
      requiresApproval: clientSupervision === "needs_approval",
    };

    // 🔥 CRITICAL FIX: Emit events to ALL relevant users
    if (req.app.get("io")) {
      const io = req.app.get("io");

      // 🎯 CRITICAL: Emit to ALL users involved in this message
      const allInvolvedUsers = new Set();

      // Add sender
      if (msg.sender && msg.sender._id) {
        allInvolvedUsers.add(String(msg.sender._id));
      }

      // Add all receivers
      if (msg.receiver && Array.isArray(msg.receiver)) {
        msg.receiver.forEach((receiver) => {
          const receiverId =
            typeof receiver === "object" ? receiver._id : receiver;
          if (receiverId) {
            allInvolvedUsers.add(String(receiverId));
          }
        });
      }

      // Add the team lead who disapproved
      allInvolvedUsers.add(String(req.employee._id));

      // Convert to array and emit to each user
      const involvedUsersArray = Array.from(allInvolvedUsers);

      involvedUsersArray.forEach((userId) => {
        io.to(`employee_${userId}`).emit("new_message", {
          message: updatedMessage,
          type: "message_updated",
          action: "disapproved",
          disapprovedBy: req.employee._id,
          timestamp: new Date(),
          clientSupervision: clientSupervision,
        });
      });

      // Also emit to the client room for real-time chat updates
      if (msg.client && msg.client._id) {
        io.to(`client_${msg.client._id}`).emit("new_message", {
          message: updatedMessage,
          type: "message_updated",
          action: "disapproved",
        });
      }
    }

    res.json({
      ...updatedMessage,
      message: "Message disapproved successfully",
      clientSupervision: clientSupervision,
    });
  } catch (e) {
    console.error("❌ Error in disapproveMessage:", e);
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
      { path: "editedBy", select: "_id name companyEmail" },
    ]);
    if (!msg) return res.status(404).json({ error: "Not found" });
    res.json(msg);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to fetch message" });
  }
};
// PATCH /api/assignment-messages/:id/edit - ENHANCED APPROVAL WORKFLOW
// PATCH /api/assignment-messages/:id/edit - ENHANCED APPROVAL WORKFLOW
exports.editMessage = async function editMessage(req, res) {
  try {
    const { id } = req.params;
    const { subject, note, receiver, receivers } = req.body;

    const msg = await WhatsAppMessage.findById(id).populate([
      { path: "sender", select: "_id name companyEmail role" },
      { path: "receiver", select: "_id name companyEmail role" },
      { path: "client", select: "_id clientName" },
      { path: "replyContent.originalSender", select: "_id name companyEmail" },
      { path: "repliedTo", select: "_id note message sender attachments" },
    ]);

    if (!msg) return res.status(404).json({ error: "Message not found" });

    // Get current user info
    const currentUserId = String(req.employee._id);
    const currentUserRole = normalizeRole(req.employee?.role || "");

    // 🔥 CHECK CLIENT SUPERVISION
    const Client = require("../models/ClientInfo");
    const client = await Client.findById(msg.client)
      .select("supervision")
      .lean();
    const clientSupervision = client?.supervision || "direct";
    const clientRequiresApproval = clientSupervision === "needs_approval";

    // 🔥 CRITICAL FIX 1: Use normalized role comparison
    const isTeamLead = currentUserRole === "team_lead";

    // 🔥 CRITICAL FIX 2: Proper sender ID comparison
    const isSender = msg.sender && String(msg.sender._id) === currentUserId;

    // 🔥 CRITICAL FIX 3: Enhanced permission check with client supervision
    if (!isSender && !isTeamLead) {
      return res.status(403).json({
        error:
          "You can only edit your own messages or messages pending your approval",
      });
    }

    // Team leads can only edit messages if client requires approval
    if (isTeamLead && !isSender) {
      if (!clientRequiresApproval) {
        return res.status(403).json({
          error:
            "This client uses direct supervision. Team leads cannot edit messages.",
          clientSupervision: clientSupervision,
        });
      }

      if (
        msg.approvalStatus !== "pending" &&
        msg.approvalStatus !== "disapproved"
      ) {
        return res.status(403).json({
          error:
            "Team leads can only edit messages with pending or disapproved status",
        });
      }
    }

    // Track if message content is actually changing
    const isMessageChanged = note && note !== msg.note;
    const isSubjectChanged = subject && subject !== msg.subject;
    const hasContentChanges = isMessageChanged || isSubjectChanged;

    // Add to edit history if message content is changing
    if (hasContentChanges) {
      // Initialize editHistory array if it doesn't exist
      if (!msg.editHistory) {
        msg.editHistory = [];
      }

      // Add previous version to edit history
      msg.editHistory.push({
        previousMessage: msg.note,
        previousSubject: msg.subject,
        editedAt: new Date(),
        editedBy: req.employee._id,
        previousApprovalStatus: msg.approvalStatus,
        editedByRole: currentUserRole,
        clientSupervisionAtEdit: clientSupervision,
      });

      // Limit edit history to last 10 edits to prevent excessive growth
      if (msg.editHistory.length > 10) {
        msg.editHistory = msg.editHistory.slice(-10);
      }
    }

    // Update editable fields
    if (typeof subject === "string") msg.subject = subject;
    if (typeof note === "string") msg.note = note;

    // Update edit tracking fields if content changed
    if (hasContentChanges) {
      msg.isEdited = true;
      msg.editedAt = new Date();
      msg.editedBy = req.employee._id;
    }

    // 🔥 ENHANCED APPROVAL WORKFLOW LOGIC WITH CLIENT SUPERVISION
    if (hasContentChanges) {
      if (isTeamLead && !isSender && clientRequiresApproval) {
        // Team Lead editing someone else's message for client that requires approval - AUTO APPROVE
        msg.approvalStatus = "approved";
      } else if (isSender) {
        // Original sender editing their own message
        if (msg.approvalStatus === "disapproved") {
          // If client requires approval, set to pending. Otherwise, keep as approved
          msg.approvalStatus = clientRequiresApproval ? "pending" : "approved";
        } else if (msg.approvalStatus === "approved") {
          // If already approved and sender edits, keep it approved
          msg.approvalStatus = "approved";
        } else if (!msg.approvalStatus && clientRequiresApproval) {
          // If no approval status but client requires approval, set to pending
          msg.approvalStatus = "pending";
        }
        // If pending, remains pending
      } else if (isTeamLead && isSender) {
        // Team Lead editing their own message - no approval needed
        msg.approvalStatus = null;
      }
    }

    // Update receivers if provided
    let newReceivers = [];
    if (receiver) newReceivers = newReceivers.concat(normalizeIds(receiver));
    if (receivers) newReceivers = newReceivers.concat(normalizeIds(receivers));

    if (newReceivers.length > 0) {
      msg.receiver = Array.from(new Set(newReceivers));
    }

    await msg.save();

    const populated = await msg.populate([
      { path: "owner", select: "_id name companyEmail" },
      { path: "sender", select: "_id name companyEmail role" },
      { path: "receiver", select: "_id name companyEmail role" },
      { path: "client", select: "_id clientName" },
      { path: "attachments.uploadedBy", select: "_id name companyEmail" },
      { path: "scheduledBy", select: "_id name companyEmail" },
      { path: "editedBy", select: "_id name companyEmail" },
      { path: "replyContent.originalSender", select: "_id name companyEmail" },
      { path: "repliedTo", select: "_id note message sender attachments" },
    ]);

    // Prepare response data with edit information
    const responseData = {
      ...populated.toObject(),
      isEdited: msg.isEdited,
      editedAt: msg.editedAt,
      editedBy: populated.editedBy,
      editHistory: msg.editHistory || [],
      clientSupervision: clientSupervision,
      requiresApproval: clientRequiresApproval,
    };

    // 🔥 NEW: FORWARD TO MANAGERS WHEN TEAM LEAD EDITS AND APPROVES
    // Only forward if client requires approval
    let forwardedMessage = null;
    if (
      hasContentChanges &&
      isTeamLead &&
      !isSender &&
      msg.approvalStatus === "approved" &&
      clientRequiresApproval
    ) {
      const senderRole = normalizeRole(msg.sender?.role || "");

      // ✅ Forward only if sender was an Employee under supervision
      if (senderRole === "employee") {
        const { managers } = await findTLsAndManagersByOwner(msg.owner);

        if (managers.length > 0) {
          try {
            // 🔥 CRITICAL: Include replyTo and replyContent like in approve function
            const forwardMsgData = {
              owner: msg.owner,
              client: msg.client,
              sender: msg.sender,
              receiver: managers,
              subject: `Approved: ${msg.subject || "No Subject"}`,
              note: msg.note || "",
              attachments: msg.attachments,
              approvalStatus: "approved",
              // 🔥 PRESERVE REPLY CONTENT AND THREAD INFO LIKE IN APPROVE
              isReply: msg.isReply,
              repliedTo: msg.repliedTo,
              replyContent: msg.replyContent,
              // Add metadata to identify this as a forwarded message
              isForwarded: true,
              originalMessage: msg._id,
              forwardedBy: req.employee._id,
              // Copy scheduling info if applicable
              isScheduled: msg.isScheduled,
              status: msg.status,
              scheduledFor: msg.scheduledFor,
              scheduledAt: msg.scheduledAt,
              scheduledBy: msg.scheduledBy,
              // Add client supervision info
              clientSupervision: clientSupervision,
            };

            const forwardMsg = await WhatsAppMessage.create(forwardMsgData);

            forwardedMessage = await forwardMsg.populate([
              { path: "owner", select: "_id name companyEmail" },
              { path: "sender", select: "_id name companyEmail role" },
              { path: "receiver", select: "_id name companyEmail role" },
              { path: "client", select: "_id clientName" },
              { path: "forwardedBy", select: "_id name companyEmail" },
              {
                path: "replyContent.originalSender",
                select: "_id name companyEmail",
              },
              {
                path: "repliedTo",
                select: "_id note message sender attachments",
              },
            ]);

            // Add forwarding info to response
            responseData.forwardedToManagers = true;
            responseData.forwardedMessage = forwardedMessage;
          } catch (forwardError) {
            console.error(
              "❌ Failed to forward message to managers:",
              forwardError
            );
            // Don't fail the whole request if forwarding fails
          }
        }
      }
    }

    // 🔥 ENHANCED REAL-TIME NOTIFICATION SYSTEM FOR EDITS
    if (req.app.get("io")) {
      const io = req.app.get("io");

      // 🎯 CRITICAL: Get ALL users involved in this message
      const allInvolvedUsers = new Set();

      // Add sender
      if (msg.sender && msg.sender._id) {
        allInvolvedUsers.add(String(msg.sender._id));
      }

      // Add all receivers
      if (msg.receiver && Array.isArray(msg.receiver)) {
        msg.receiver.forEach((receiver) => {
          const receiverId =
            typeof receiver === "object" ? receiver._id : receiver;
          if (receiverId) {
            allInvolvedUsers.add(String(receiverId));
          }
        });
      }

      // Add the current user who edited
      allInvolvedUsers.add(String(req.employee._id));

      // Convert to array and emit to each user
      const involvedUsersArray = Array.from(allInvolvedUsers);

      // Emit to ALL involved users
      involvedUsersArray.forEach((userId) => {
        io.to(`employee_${userId}`).emit("new_message", {
          message: responseData,
          type: "message_updated",
          action: "edited",
          editedBy: req.employee._id,
          timestamp: new Date(),
          clientSupervision: clientSupervision,
        });
      });

      // Also emit to the client room for real-time chat updates
      if (msg.client && msg.client._id) {
        io.to(`client_${msg.client._id}`).emit("new_message", {
          message: responseData,
          type: "message_updated",
          action: "edited",
        });
      }

      // 🔥 NEW: Emit forwarded message to managers
      if (forwardedMessage) {
        // Notify managers about the new forwarded message
        forwardedMessage.receiver.forEach((manager) => {
          const managerId = typeof manager === "object" ? manager._id : manager;
          if (managerId) {
            io.to(`employee_${managerId}`).emit("new_message", {
              message: forwardedMessage,
              type: "new_message",
              action: "forwarded_approved",
              forwardedBy: req.employee._id,
              originalMessageId: msg._id,
              source: "team_lead_edit",
              clientSupervision: clientSupervision,
              // Include reply context
              replyContext: msg.isReply
                ? {
                    hasOriginalThread: true,
                    originalSender: msg.replyContent?.originalSender,
                    repliedToMessage: msg.repliedTo?._id,
                  }
                : null,
            });
          }
        });
      }

      // Special notifications based on approval status changes
      if (msg.approvalStatus === "approved") {
        // Notify ALL involved users about approval
        involvedUsersArray.forEach((userId) => {
          io.to(`employee_${userId}`).emit("new_message", {
            message: responseData,
            type: "message_updated",
            action: "auto_approved",
            approvedBy: req.employee._id,
            clientSupervision: clientSupervision,
          });
        });

        // If auto-approved by Team Lead, also notify managers (if not already forwarded)
        if (
          isTeamLead &&
          !isSender &&
          !forwardedMessage &&
          clientRequiresApproval
        ) {
          const { managers } = await findTLsAndManagersByOwner(msg.owner);
          managers.forEach((managerId) => {
            io.to(`employee_${managerId}`).emit("new_message", {
              message: responseData,
              type: "new_approved_message",
              clientSupervision: clientSupervision,
            });
          });
        }
      } else if (msg.approvalStatus === "pending" && clientRequiresApproval) {
        // Notify ALL involved users about pending status
        involvedUsersArray.forEach((userId) => {
          io.to(`employee_${userId}`).emit("new_message", {
            message: responseData,
            type: "message_updated",
            action: "pending_approval",
            clientSupervision: clientSupervision,
          });
        });

        // Notify other team leads about message needing approval
        const { tls } = await findTLsAndManagersByOwner(msg.owner);
        tls.forEach((teamLeadId) => {
          // Don't notify the current Team Lead if they are the one who made it pending
          if (teamLeadId !== currentUserId) {
            io.to(`employee_${teamLeadId}`).emit("new_message", {
              message: responseData,
              type: "message_needs_approval",
              clientSupervision: clientSupervision,
            });
          }
        });
      }
    }

    // Response messages based on the workflow
    let responseMessage = "Message updated successfully";
    if (msg.approvalStatus === "approved" && isTeamLead && !isSender) {
      if (forwardedMessage) {
        responseMessage =
          "Message updated, automatically approved, and forwarded to managers";
      } else {
        responseMessage = "Message updated and automatically approved";
      }
    } else if (msg.approvalStatus === "pending" && clientRequiresApproval) {
      responseMessage = "Message updated and sent for approval";
    } else if (msg.approvalStatus === "approved" && isSender) {
      responseMessage = "Message updated (already approved)";
    } else if (!clientRequiresApproval) {
      responseMessage =
        "Message updated (direct supervision - no approval needed)";
    }

    // Build final response
    const finalResponse = {
      message: responseMessage,
      data: responseData,
      approvalStatus: msg.approvalStatus,
      editedBy: currentUserRole,
      clientSupervision: clientSupervision,
      requiresApproval: clientRequiresApproval,
    };

    // Add forwarding info to response if applicable
    if (forwardedMessage) {
      finalResponse.forwardedToManagers = true;
      finalResponse.forwardedMessage = forwardedMessage;
    }

    // 🔥 ADD REPLY CONTEXT TO RESPONSE LIKE IN APPROVE FUNCTION
    if (msg.isReply) {
      finalResponse.replyContext = {
        includedReplyContent: true,
        originalThreadPreserved: true,
        hasRepliedTo: !!msg.repliedTo,
        hasReplyContent: !!msg.replyContent,
      };
    }

    res.json(finalResponse);
  } catch (e) {
    console.error("❌ Edit message error:", e);
    res.status(500).json({ error: "Failed to edit message" });
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

    // FIXED: Emit new_message event ONLY to relevant users
    if (req.app.get("io")) {
      const io = req.app.get("io");

      // Notify ONLY the sender about update
      io.to(`employee_${msg.sender}`).emit("new_message", {
        message: populated,
        type: "message_updated",
      });

      // Notify ONLY the actual receivers about update
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

    // FIXED: Emit new_message event ONLY to relevant users
    if (req.app.get("io")) {
      const io = req.app.get("io");

      // Notify ONLY the sender about deletion
      io.to(`employee_${msg.sender}`).emit("new_message", {
        message: msg,
        type: "message_deleted",
      });

      // Notify ONLY the actual receivers about deletion
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

// In uploadAttachments function, update the file validation
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
      fileType: getFileType(f.mimetype), // Add file type detection
    }));

    msg.attachments.push(...files);
    await msg.save();

    const populated = await msg.populate([
      { path: "attachments.uploadedBy", select: "_id name companyEmail" },
    ]);

    // FIXED: Emit new_message event ONLY to relevant users
    if (req.app.get("io")) {
      const io = req.app.get("io");

      // Notify ONLY the sender about attachment upload
      io.to(`employee_${msg.sender}`).emit("new_message", {
        message: populated,
        type: "attachments_uploaded",
      });

      // Notify ONLY the actual receivers about new attachments
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
      error:
        "Attachment upload failed (only PDF/XLS/XLSX/AUDIO; up to 20MB each)",
    });
  }
};

// Add file type detection helper function
function getFileType(mimetype) {
  if (mimetype.startsWith("audio/")) return "audio";
  if (mimetype.startsWith("image/")) return "image";
  if (mimetype.startsWith("video/")) return "video";
  if (mimetype === "application/pdf") return "pdf";
  if (mimetype.includes("spreadsheet") || mimetype.includes("excel"))
    return "spreadsheet";
  return "document";
}

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

    // FIXED: Emit new_message event ONLY to relevant users
    if (req.app.get("io")) {
      const io = req.app.get("io");

      // Notify ONLY the sender about attachment deletion
      io.to(`employee_${msg.sender}`).emit("new_message", {
        message: msg,
        type: "attachment_deleted",
      });

      // Notify ONLY the actual receivers about attachment deletion
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

exports.markAsSeen = async function markAsSeen(req, res) {
  try {
    const { id } = req.params;
    const currentUserId = req.employee._id;

    const msg = await WhatsAppMessage.findById(id);
    if (!msg) {
      return res.status(404).json({ error: "Message not found" });
    }

    // Check if user is a receiver of this message
    const isReceiver = msg.receiver.some(
      (receiverId) => String(receiverId) === String(currentUserId)
    );

    if (!isReceiver) {
      return res
        .status(403)
        .json({ error: "You are not a receiver of this message" });
    }

    // Check if already seen
    const alreadySeen = msg.seenBy.some(
      (seen) => String(seen.employee) === String(currentUserId)
    );

    if (!alreadySeen) {
      // Add to seenBy array - ONLY employee field
      msg.seenBy.push({
        employee: currentUserId,
        // NO seenAt - only employee field as per your schema
      });

      await msg.save();
    }

    // Populate and return updated message
    const populated = await msg.populate([
      { path: "owner", select: "_id name companyEmail" },
      { path: "sender", select: "_id name companyEmail role" },
      { path: "receiver", select: "_id name companyEmail role" },
      { path: "client", select: "_id clientName" },
      { path: "seenBy.employee", select: "_id name companyEmail" },
    ]);

    // Emit real-time event - NO seenAt
    if (req.app.get("io")) {
      const io = req.app.get("io");

      // Notify sender that message was seen
      io.to(`employee_${msg.sender}`).emit("message_seen", {
        messageId: msg._id,
        seenBy: currentUserId,
      });

      // Notify all receivers about the seen status update
      msg.receiver.forEach((receiverId) => {
        io.to(`employee_${receiverId}`).emit("message_seen", {
          messageId: msg._id,
          seenBy: currentUserId,
        });
      });
    }

    res.json({
      message: "Message marked as seen",
      data: populated,
    });
  } catch (e) {
    console.error("Error marking message as seen:", e);
    res.status(500).json({ error: "Failed to mark message as seen" });
  }
};

exports.getUnreadCounts = async function getUnreadCounts(req, res) {
  try {
    const currentUserId = req.employee._id;
    const ownerId = req.employee.owner;

    if (!currentUserId || !ownerId) {
      return res.status(400).json({ error: "User information missing" });
    }

    // Method 1: Simple count without aggregation (more reliable)
    const unreadMessages = await WhatsAppMessage.find({
      owner: ownerId,
      receiver: currentUserId,
      sender: { $ne: currentUserId }, // Exclude own messages
    });

    // Manually count unread messages
    let totalUnread = 0;
    unreadMessages.forEach((message) => {
      const isSeen = message.seenBy.some(
        (seen) => String(seen.employee) === String(currentUserId)
      );
      if (!isSeen) {
        totalUnread++;
      }
    });

    res.json({
      totalUnreadCount: totalUnread,
      message: `You have ${totalUnread} unread message${
        totalUnread !== 1 ? "s" : ""
      }`,
    });
  } catch (e) {
    console.error("Error fetching unread counts:", e);
    res.status(500).json({ error: "Failed to fetch unread counts" });
  }
};

exports.getClientMessagesSeenStatus =
  async function getClientMessagesSeenStatus(req, res) {
    try {
      const { clientId } = req.params;
      const currentUserId = req.employee._id;

      if (!isObjId(clientId)) {
        return res.status(400).json({ error: "Valid client ID required" });
      }

      // Get all messages for this client where current user is a receiver
      const messages = await WhatsAppMessage.find({
        client: clientId,
        receiver: currentUserId,
        // Exclude messages sent by current user
        sender: { $ne: currentUserId },
      }).select("_id seenBy");

      // Check if any message is unread
      const hasUnreadMessages = messages.some(
        (message) =>
          !message.seenBy.some(
            (seen) => String(seen.employee) === String(currentUserId)
          )
      );

      res.json({
        clientId,
        hasUnreadMessages,
        totalMessages: messages.length,
        unreadCount: messages.filter(
          (message) =>
            !message.seenBy.some(
              (seen) => String(seen.employee) === String(currentUserId)
            )
        ).length,
      });
    } catch (e) {
      console.error("Error fetching seen status:", e);
      res.status(500).json({ error: "Failed to fetch seen status" });
    }
  };

exports.markAllMessagesAsSeen = async function markAllMessagesAsSeen(req, res) {
  try {
    const { clientId } = req.params;
    const currentUserId = req.employee._id;

    if (!isObjId(clientId)) {
      return res.status(400).json({ error: "Valid client ID required" });
    }

    // Find all unread messages for this client where current user is a receiver
    const unreadMessages = await WhatsAppMessage.find({
      client: clientId,
      receiver: currentUserId,
      sender: { $ne: currentUserId }, // Exclude own messages
      "seenBy.employee": { $ne: currentUserId }, // Not already seen
    });

    // Mark each message as seen
    const updatePromises = unreadMessages.map(async (message) => {
      // Check if user already seen this message (double check)
      const alreadySeen = message.seenBy.some(
        (seen) => String(seen.employee) === String(currentUserId)
      );

      if (!alreadySeen) {
        message.seenBy.push({
          employee: currentUserId,
          // NO seenAt - only employee field as per your schema
        });
        return message.save();
      }
    });

    await Promise.all(updatePromises);

    // Emit real-time event for all updated messages
    if (req.app.get("io")) {
      const io = req.app.get("io");

      unreadMessages.forEach((message) => {
        // Notify sender that their messages were seen
        io.to(`employee_${message.sender}`).emit("messages_seen", {
          messageId: message._id,
          seenBy: currentUserId,
          clientId: clientId,
          seenAt: new Date(),
        });

        // Notify all receivers about the seen status update
        message.receiver.forEach((receiverId) => {
          io.to(`employee_${receiverId}`).emit("messages_seen", {
            messageId: message._id,
            seenBy: currentUserId,
            clientId: clientId,
          });
        });
      });
    }

    res.json({
      success: true,
      clientId,
      markedAsSeen: unreadMessages.length,
      message: `Marked ${unreadMessages.length} messages as seen`,
    });
  } catch (e) {
    console.error("Error marking messages as seen:", e);
    res.status(500).json({ error: "Failed to mark messages as seen" });
  }
};

exports.searchMessages = async function searchMessages(req, res) {
  try {
    const { query, limit = 20 } = req.query;

    if (!query || !query.trim()) {
      return res.json({ items: [] });
    }

    const searchQuery = query.trim();

    // Build base query - exclude drafts
    const q = {
      status: { $ne: "draft" },
      $or: [
        { note: { $regex: searchQuery, $options: "i" } },
        { subject: { $regex: searchQuery, $options: "i" } },
      ],
    };

    // Apply visibility rules safely
    let qFinal = q;
    if (req.employee && req.employee._id) {
      try {
        qFinal = await applyVisibility(q, req);
      } catch (visibilityError) {
        console.warn("Visibility filter skipped:", visibilityError.message);
        // Use base query if visibility fails
      }
    }

    const lim = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 20);

    const messages = await WhatsAppMessage.find(qFinal)
      .sort({ createdAt: -1 })
      .limit(lim)
      .populate([
        { path: "client", select: "_id clientName" },
        { path: "sender", select: "_id name companyEmail role" },
        { path: "owner", select: "_id name companyEmail" },
      ])
      .select(
        "_id note message subject sender client createdAt receiver status"
      )
      .lean();

    // Debug: Log first few messages
    if (messages.length > 0) {
      messages.slice(0, 3).forEach((msg, i) => {});
    }

    // Format response
    const items = messages.map((m) => ({
      _id: m._id,
      note: m.note || m.message || "",
      subject: m.subject || "",
      sender: m.sender
        ? {
            _id: m.sender._id,
            name: m.sender.name || "Unknown",
          }
        : { _id: null, name: "Unknown" },
      clientId: m.client?._id || null,
      clientName: m.client?.clientName || "Unknown",
      time: m.createdAt
        ? new Date(m.createdAt).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          })
        : "",
      timestamp: m.createdAt || new Date(),
      status: m.status || "sent",
    }));

    return res.json({
      items,
      count: items.length,
      query: searchQuery,
    });
  } catch (e) {
    console.error("❌ Search failed:", e);
    console.error("❌ Stack trace:", e.stack);
    res.status(500).json({
      error: "Search failed",
      items: [],
    });
  }
};
