// controllers/assignmentMessageController.js
const AssignmentMessage = require("../models/AssignmentMessage");
const Employee = require("../models/Employees");
const path = require("path");
const mongoose = require("mongoose");

/** ---------- utils ---------- **/
function buildPublicUrl(req, filename) {
  const base =
    process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`;
  return `${base}/upload/${filename}`;
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
// 🔥 FIXED: Thread ID generation based on subject only
function generateThreadId(clientId, subject) {
  if (!clientId) {
    throw new Error("clientId is required to generate threadId");
  }

  if (!subject || subject.trim() === "") {
    return `thread_${clientId}_${Date.now()}`;
  }

  // 🔥 CRITICAL FIX: Normalize subject for consistent thread grouping
  // Remove reply/forward prefixes and normalize the subject
  const normalizedSubject = subject
    .trim()
    .toLowerCase()
    .replace(/^(re:|fwd:|fw:)\s*/i, "") // Remove reply/forward prefixes
    .replace(/[^a-z0-9]/g, "_") // Replace non-alphanumeric with underscores
    .replace(/_+/g, "_") // Replace multiple underscores with single
    .substring(0, 50); // Limit length to avoid issues

  // 🔥 CRITICAL: Use only the normalized subject for thread ID
  // This ensures same subject = same thread ID across different clients
  return `thread_${normalizedSubject}_${Date.now()}`;
}

function getThreadIdForReply(originalMessage, newSubject, isForward = false) {
  if (!originalMessage) {
    throw new Error(
      "originalMessage is required for reply thread ID generation"
    );
  }

  // For forwards, always create a new thread
  if (isForward) {
    const clientId =
      typeof originalMessage.client === "string"
        ? originalMessage.client
        : originalMessage.client?._id;
    return generateThreadId(clientId, newSubject);
  }

  // For replies, check if this should be a new conversation
  const originalSubject = originalMessage.subject || "";
  const normalizedNew = newSubject.trim().toLowerCase();
  const normalizedOriginal = originalSubject.trim().toLowerCase();

  // Remove reply/forward prefixes for comparison
  const cleanNew = normalizedNew.replace(/^(re:|fwd:|fw:)\s*/i, "");
  const cleanOriginal = normalizedOriginal.replace(/^(re:|fwd:|fw:)\s*/i, "");

  console.log(`🔍 Thread ID comparison:`, {
    originalSubject,
    newSubject,
    cleanOriginal,
    cleanNew,
    isSame: cleanNew === cleanOriginal,
  });

  // 🔥 CRITICAL FIX: If the core subject is the same, use the same thread
  if (cleanNew === cleanOriginal) {
    console.log(`✅ Using same thread for subject: "${cleanOriginal}"`);
    return originalMessage.threadId;
  }

  // Otherwise, create new thread
  console.log(`🆕 Creating new thread for different subject`);
  const clientId =
    typeof originalMessage.client === "string"
      ? originalMessage.client
      : originalMessage.client?._id;
  return generateThreadId(clientId, newSubject);
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

  const currentUserRole = normalizeRole(req.employee?.role || "");
  const ownerId = req.employee?.owner ? oid(req.employee.owner) : null;

  // 🧑‍💼 MANAGER / OWNER: can see everything for their owner
  if (
    (currentUserRole === "manager" || currentUserRole === "owner") &&
    ownerId
  ) {
    return { ...q, owner: ownerId };
  }

  // 🧑‍🤝‍🧑 TEAM LEAD: can see ALL messages for their owner's organization
  if (currentUserRole === "team_lead" && ownerId) {
    // Team leads can see ALL messages within their organization
    const teamLeadQuery = {
      ...q,
      owner: ownerId, // Show all messages for the owner
    };

    // 🔥 CRITICAL FIX: Team leads should ALWAYS see pending approval messages
    // Remove any approvalStatus filter that might exclude pending messages
    if (teamLeadQuery.approvalStatus === "pending") {
      // Keep the pending filter if explicitly requested
      console.log("👀 Team lead viewing pending messages");
    } else if (q.approvalStatus !== "pending") {
      // Don't exclude pending messages for team leads in normal views
      delete teamLeadQuery.approvalStatus;
    }

    return teamLeadQuery;
  }

  // 👷 NORMAL EMPLOYEE: can see messages where they are sender OR receiver
  const visOr = [{ sender: me }, { receiver: me }, { receiver: { $in: [me] } }];

  // 🔥 UPDATED: Handle both client-based threads AND direct messages

  // For client-based messages: if we're querying for a specific client thread,
  // show ALL messages in that thread to all participants
  if (q.client && isObjId(q.client)) {
    // For team leads, they can see all messages for the client
    if (currentUserRole === "team_lead" && ownerId) {
      return {
        ...q,
        client: q.client,
        owner: ownerId,
      };
    }

    // For employees, check if they're part of the thread
    const userThreadMessages = await AssignmentMessage.find({
      client: q.client,
      $or: [{ sender: me }, { receiver: me }, { receiver: { $in: [me] } }],
    })
      .select("_id")
      .lean();

    if (userThreadMessages.length > 0) {
      // User is part of this client thread - show ALL messages for this client
      return { ...q, client: q.client };
    }
  }

  // 🔥 NEW: For direct messages (no client), always apply participant visibility
  // If client is explicitly set to $exists: false (direct messages), ensure user is participant
  if (q.client && q.client.$exists === false) {
    const directMessageQuery = {
      ...q,
      $and: [{ $or: visOr }],
    };

    // Add back the isTrashed filter if it was set
    const isTrashedFilter = q.isTrashed;
    if (isTrashedFilter !== undefined) {
      directMessageQuery.isTrashed = isTrashedFilter;
    }
    return directMessageQuery;
  }

  const now = new Date();

  // PRESERVE THE isTrashed FILTER - don't override it
  const baseQuery = { ...q };

  // Remove isTrashed from base query if it exists, we'll handle it separately
  const isTrashedFilter = baseQuery.isTrashed;
  delete baseQuery.isTrashed;

  // Handle scheduled messages specifically
  if (q.isScheduled === true && q.status === "scheduled") {
    const scheduledQuery = {
      ...baseQuery,
      $and: [{ $or: visOr }],
    };

    // Add back the isTrashed filter if it was set
    if (isTrashedFilter !== undefined) {
      scheduledQuery.isTrashed = isTrashedFilter;
    }
    return scheduledQuery;
  }

  // Build the main visibility query for employees
  const finalQuery = {
    $or: [
      {
        ...baseQuery,
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
        ...baseQuery,
        isScheduled: true,
        status: "scheduled",
        scheduledFor: { $gt: now },
        sender: me,
      },
    ],
  };

  // Add back the isTrashed filter to the entire query
  if (isTrashedFilter !== undefined) {
    finalQuery.isTrashed = isTrashedFilter;
  }

  return finalQuery;
}
/** ---------- SOCKET.IO UTILITIES ---------- **/
function getIO(req) {
  return req.app.get("io");
}
async function emitToSpecificReceivers(
  io,
  message,
  eventName = "new_assignment_message"
) {
  try {
    const populatedMessage = await AssignmentMessage.findById(message._id)
      .populate("owner")
      .populate("sender")
      .populate("receiver")
      .populate("client")
      .populate("scheduledBy")
      .populate("attachments.uploadedBy");

    if (!populatedMessage) {
      console.error("❌ Message not found for targeted emission:", message._id);
      return;
    }

    // CRITICAL: Extract the specific receiver IDs from the message
    const specificReceiverIds = [];

    if (Array.isArray(populatedMessage.receiver)) {
      populatedMessage.receiver.forEach((receiver) => {
        const receiverId =
          typeof receiver === "string" ? receiver : receiver._id;
        if (
          receiverId &&
          receiverId.toString() !== populatedMessage.sender?._id?.toString()
        ) {
          specificReceiverIds.push(receiverId.toString());
        }
      });
    } else if (populatedMessage.receiver) {
      const receiverId =
        typeof populatedMessage.receiver === "string"
          ? populatedMessage.receiver
          : populatedMessage.receiver?._id;
      if (
        receiverId &&
        receiverId.toString() !== populatedMessage.sender?._id?.toString()
      ) {
        specificReceiverIds.push(receiverId.toString());
      }
    }

    // Get sender ID
    const senderId =
      typeof populatedMessage.sender === "string"
        ? populatedMessage.sender
        : populatedMessage.sender?._id;

    // Combine recipients (sender + specific receivers) and remove duplicates
    const allRecipients = [
      ...new Set(
        [senderId?.toString(), ...specificReceiverIds].filter(Boolean)
      ),
    ];

    // CRITICAL FIX: Also send to ALL team leads for the owner (for complete visibility)
    const ownerId =
      typeof populatedMessage.owner === "string"
        ? populatedMessage.owner
        : populatedMessage.owner?._id;

    if (ownerId) {
      const { tls } = await findTLsAndManagersByOwner(ownerId);
      const teamLeadIds = tls.map((id) => id.toString());

      // Add ALL team leads to recipients (they get complete access to all messages)
      teamLeadIds.forEach((teamLeadId) => {
        if (!allRecipients.includes(teamLeadId)) {
          allRecipients.push(teamLeadId);
        }
      });
    }

    // Send to ALL recipients (specific receivers + sender + ALL team leads)
    allRecipients.forEach((recipientId) => {
      if (recipientId) {
        io.to(`employee_${recipientId}`).emit(eventName, populatedMessage);
      }
    });

    console.log(
      `📤 Emitted message to ${allRecipients.length} recipients:`,
      allRecipients
    );
  } catch (error) {
    console.error("❌ Error in emitToSpecificReceivers:", error);
    throw error;
  }
}
/** ---------- TARGETED MESSAGE EMISSION (REPLACES BROADCAST) ---------- **/
async function emitToAssignmentClients(
  io,
  message,
  eventName = "new_assignment_message"
) {
  try {
    // For normal messages, use targeted emission instead of broadcasting
    if (eventName === "new_assignment_message") {
      return await emitToSpecificReceivers(io, message, eventName);
    }

    // For other events (updates, etc.), still use targeted approach
    const populatedMessage = await AssignmentMessage.findById(message._id)
      .populate("owner")
      .populate("sender")
      .populate("receiver")
      .populate("client");

    if (!populatedMessage) return;

    await emitToSpecificReceivers(io, populatedMessage, eventName);
  } catch (error) {
    console.error("❌ Error in emitToAssignmentClients:", error);
  }
}

async function emitMessageUpdate(io, message, action) {
  try {
    const populatedMessage = await AssignmentMessage.findById(message._id)
      .populate("owner")
      .populate("sender")
      .populate("receiver")
      .populate("client");

    if (!populatedMessage) return;

    // Use targeted emission for updates as well
    await emitToSpecificReceivers(
      io,
      populatedMessage,
      "assignment_message_updated"
    );
  } catch (error) {
    console.error("❌ Error emitting message update:", error);
  }
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
        AssignmentMessage.find(qFinal)
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
        AssignmentMessage.countDocuments(qFinal),
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
      isTrashed,
      isSpam,
      approvalStatus,
      includeDirectMessages = "true", // New parameter to include direct messages
    } = req.query;

    const q = {};

    // Owner scope
    if (isObjId(owner)) q.owner = owner;
    else if (req.employee?.owner) q.owner = req.employee.owner;

    // ✅ UPDATED: Client scope - handle both client-based and direct messages
    if (isObjId(client)) {
      q.client = client;
    } else if (client === "none" || client === "direct") {
      // Explicitly request direct messages (no client)
      q.client = { $exists: false };
    } else if (!client) {
      // Default behavior: include both client-based and direct messages
      // No client filter applied - will return all messages user has access to
    }

    // ✅ FIXED: Better status handling
    if (
      status &&
      ["draft", "scheduled", "sent", "cancelled"].includes(status)
    ) {
      q.status = status;
      // Don't automatically set isScheduled for drafts
      if (status === "scheduled") {
        q.isScheduled = true;
      }
    } else {
      // ✅ FIXED: Default: exclude drafts but include sent and scheduled
      q.status = { $in: ["sent", "scheduled"] };
    }

    // 🔥 CRITICAL FIX: Simplified trash/spam logic
    if (isTrashed === "true" || isTrashed === true) {
      q.isTrashed = true;
    } else if (isSpam === "true" || isSpam === true) {
      q.isSpam = true;
    } else {
      q.isTrashed = { $ne: true };
      q.isSpam = { $ne: true };
    }

    // For normal inbox view, exclude messages pending review
    if (filter !== "review" && approvalStatus !== "pending") {
      q.approvalStatus = { $ne: "pending" };
    } else if (approvalStatus === "pending") {
      q.approvalStatus = "pending";
    }

    // Scheduled filter
    if (filter === "scheduled" || isScheduled === "true") {
      q.isScheduled = true;
      q.status = "scheduled";
    } else if (isScheduled === "false") {
      q.isScheduled = false;
    }

    // Time filters
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

    // User-based filtering - FIXED VERSION
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

    // ✅ FIXED: Apply visibility rules BEFORE adding user-based filters
    // This ensures the visibility query is built correctly
    const qFinal = await applyVisibility(q, req);

    // ✅ UPDATED: Better validation that considers both client-based and direct messages
    const hasExplicitFilter =
      q.owner ||
      q.client !== undefined || // Changed to check for undefined (includes $exists: false)
      q.sender ||
      q.receiver ||
      q.$or ||
      q.status ||
      q.isScheduled !== undefined ||
      q.approvalStatus ||
      q.isTrashed !== undefined ||
      q.isSpam !== undefined;

    if (!hasExplicitFilter) {
      return res.status(400).json({
        error:
          "Provide at least one scope: owner, client, sender, receiver, participant, status, approvalStatus, isTrashed, isSpam, or isScheduled",
      });
    }

    // Pagination & fetch
    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);

    const [items, total] = await Promise.all([
      AssignmentMessage.find(qFinal)
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
          { path: "trashedBy", select: "_id name companyEmail" },
          { path: "spamReportedBy", select: "_id name companyEmail" },
        ])
        .lean(),
      AssignmentMessage.countDocuments(qFinal),
    ]);

    // Ensure receiver is always treated as array for consistency
    const normalizedItems = items.map((item) => ({
      ...item,
      receiver: Array.isArray(item.receiver)
        ? item.receiver
        : [item.receiver].filter(Boolean),
      // Add a flag to identify direct messages
      isDirectMessage: !item.client,
    }));

    res.json({
      items: normalizedItems,
      total,
      page: pageNum,
      pages: Math.ceil(total / lim),
      limit: lim,
      userRole: currentUserRole,
      isTeamLead: isTeamLead,
      // Add metadata about message types
      messageTypes: {
        clientBased: items.filter((item) => item.client).length,
        directMessages: items.filter((item) => !item.client).length,
      },
    });
  } catch (e) {
    console.error("❌ Error in listMessages:", e);
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

    const messages = await AssignmentMessage.find(qFinal)
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

exports.createMessage = async function createMessage(req, res) {
  try {
    const {
      owner: ownerBody,
      client, // This is now optional
      sender: senderBody,
      receiver: receiverBody,
      receivers: receiversBody,
      subject,
      note,
      isScheduled: isScheduledBody,
      scheduledFor,
      replyTo,
      isForward = false,
      threadId: providedThreadId,
    } = req.body;

    const owner = ownerBody || req.employee?.owner;
    const sender = senderBody || req.employee?._id;

    // Remove client validation - it's now optional
    if (!isObjId(owner) || !isObjId(sender)) {
      return res.status(400).json({
        error: "owner and sender are required (ObjectId strings)",
      });
    }

    // Handle thread ID generation for direct messages (no client)
    let threadId = providedThreadId;
    let originalMessage = null;

    if (replyTo) {
      originalMessage = await AssignmentMessage.findById(replyTo);
    }

    if (originalMessage) {
      threadId = getThreadIdForReply(originalMessage, subject, isForward);
    } else if (!threadId) {
      // For direct messages without client, generate a different thread ID
      if (client) {
        threadId = generateThreadId(client, subject);
      } else {
        // Direct message thread ID based on participants and subject
        const participants = [
          sender,
          ...normalizeIds(receiverBody),
          ...normalizeIds(receiversBody),
        ]
          .filter((id) => id !== String(sender))
          .sort()
          .join("_");
        threadId = `direct_${participants}_${
          subject ? subject.toLowerCase().replace(/[^a-z0-9]/g, "_") : "message"
        }_${Date.now()}`;
      }
    }

    // Rest of your existing receiver logic...
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
    const needsApproval = supervisionMode === "needs_approval";
    const isDirect = supervisionMode === "direct";

    // Only handle client assignment if client is provided
    if (client && isObjId(client)) {
      const Client = require("../models/ClientInfo");
      const clientDoc = await Client.findById(client)
        .populate("assignedTo", "_id role")
        .lean();

      // Include assignedTo employee if present
      if (clientDoc && clientDoc.assignedTo && clientDoc.assignedTo._id) {
        const assignedEmployeeId = String(clientDoc.assignedTo._id);
        if (
          !receivers.includes(assignedEmployeeId) &&
          assignedEmployeeId !== String(sender)
        ) {
          receivers.push(assignedEmployeeId);
        }
      }
    }

    // Your existing approval logic...
    const { tls, managers } = await findTLsAndManagersByOwner(owner);

    if (senderRole === "manager") {
      approvalStatus = null;
    } else if (senderRole === "team_lead") {
      approvalStatus = null;
    } else if (needsApproval) {
      approvalStatus = "pending";
      receivers = [...receivers, ...tls.map((id) => String(id))];
    } else if (isDirect) {
      approvalStatus = "approved";
    }

    // Fallback logic if no receivers
    if (receivers.length === 0) {
      if (senderRole === "employee") {
        if (isDirect) {
          receivers = [...managers];
          approvalStatus = "approved";
        } else {
          receivers = [...tls];
          approvalStatus = "pending";
        }
      } else if (senderRole === "team_lead") {
        receivers = [...managers];
        approvalStatus = null;
      } else if (senderRole === "manager") {
        receivers = [...tls];
        approvalStatus = null;
      }
    }

    receivers = Array.from(new Set(receivers.map((id) => String(id)))).filter(
      (id) => id !== String(sender)
    );

    if (receivers.length === 0) {
      return res.status(400).json({ error: "No valid receivers found" });
    }

    // Scheduling logic (same as before)
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

    // Build message data - client is optional
    const msgData = {
      owner,
      sender,
      receiver: receivers,
      subject: subject || "",
      note: note || "",
      approvalStatus: approvalStatus,
      isScheduled,
      status,
      scheduledFor: isScheduled ? new Date(scheduledFor) : undefined,
      scheduledAt,
      scheduledBy,
      sentAt: !isScheduled ? new Date() : undefined,
      threadId,
      replyTo: replyTo || undefined,
    };

    // Only include client if provided
    if (client && isObjId(client)) {
      msgData.client = client;
    }

    const msg = await AssignmentMessage.create(msgData);

    const populated = await msg.populate([
      { path: "owner", select: "_id name companyEmail" },
      { path: "sender", select: "_id name companyEmail role" },
      { path: "receiver", select: "_id name companyEmail role" },
      { path: "client", select: "_id clientName assignedTo" },
      { path: "scheduledBy", select: "_id name companyEmail" },
    ]);

    // EMIT REAL-TIME EVENT
    const io = getIO(req);
    if (io) {
      await emitToAssignmentClients(io, msg, "new_assignment_message");
    }

    res.status(201).json(populated);
  } catch (e) {
    console.error("Error in createMessage:", e);
    if (e.name === "ValidationError") {
      return res.status(400).json({
        error: "Validation failed",
        details: Object.values(e.errors).map((err) => err.message),
      });
    }
    res.status(500).json({ error: "Failed to create assignment message" });
  }
};

// GET MESSAGE WITH PROPER APPROVAL STATUS
exports.getMessage = async function getMessage(req, res) {
  try {
    const messageId = req.params.id;

    if (!mongoose.Types.ObjectId.isValid(messageId)) {
      return res.status(400).json({ error: "Invalid message ID" });
    }

    const msg = await AssignmentMessage.findById(messageId).populate([
      { path: "owner", select: "_id name companyEmail" },
      { path: "sender", select: "_id name companyEmail role" },
      { path: "client", select: "_id clientName" },
      { path: "attachments.uploadedBy", select: "_id name companyEmail" },
      {
        path: "receiver",
        select: "_id name companyEmail role",
        options: { allowNull: true },
      },
    ]);

    if (!msg) {
      return res.status(404).json({ error: "Message not found" });
    }

    // Check if user has permission to view this message
    const userId = req.employee._id.toString();
    const senderId =
      typeof msg.sender === "string" ? msg.sender : msg.sender?._id?.toString();

    let receiverIds = [];
    if (Array.isArray(msg.receiver)) {
      receiverIds = msg.receiver.map((r) =>
        typeof r === "string" ? r : r?._id?.toString()
      );
    } else if (msg.receiver) {
      receiverIds = [
        typeof msg.receiver === "string"
          ? msg.receiver
          : msg.receiver?._id?.toString(),
      ];
    }

    const hasAccess = userId === senderId || receiverIds.includes(userId);

    if (!hasAccess) {
      return res
        .status(403)
        .json({ error: "You don't have permission to view this message" });
    }

    // Convert to plain object and ensure receiver is always an array
    const messageData = msg.toObject ? msg.toObject() : msg;
    if (messageData.receiver && !Array.isArray(messageData.receiver)) {
      messageData.receiver = [messageData.receiver].filter(Boolean);
    }

    res.json(messageData);
  } catch (e) {
    console.error("Error in getMessage:", e);
    res.status(500).json({ error: "Failed to fetch message" });
  }
};

// SCHEDULE AN EXISTING MESSAGE
exports.scheduleMessage = async function scheduleMessage(req, res) {
  try {
    const { id } = req.params;
    const { scheduledFor } = req.body;

    const msg = await AssignmentMessage.findById(id);
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

    // EMIT REAL-TIME EVENT
    const io = getIO(req);
    if (io) {
      await emitMessageUpdate(io, msg, "scheduled");
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

    const msg = await AssignmentMessage.findById(id);
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
    const { action = "draft" } = req.body;

    if (action === "send") {
      msg.isScheduled = false;
      msg.status = "sent";
      msg.sentAt = new Date();
    } else {
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

    // EMIT REAL-TIME EVENT
    const io = getIO(req);
    if (io) {
      await emitMessageUpdate(
        io,
        msg,
        action === "send" ? "sent" : "converted_to_draft"
      );
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
      AssignmentMessage.find(qFinal)
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
      AssignmentMessage.countDocuments(qFinal),
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

    const msg = await AssignmentMessage.findById(id);
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
    msg.scheduledAt = new Date();

    await msg.save();

    const populated = await msg.populate([
      { path: "owner", select: "_id name companyEmail" },
      { path: "sender", select: "_id name companyEmail role" },
      { path: "receiver", select: "_id name companyEmail role" },
      { path: "client", select: "_id clientName" },
      { path: "scheduledBy", select: "_id name companyEmail" },
    ]);

    // EMIT REAL-TIME EVENT
    const io = getIO(req);
    if (io) {
      await emitMessageUpdate(io, msg, "rescheduled");
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
    const scheduledMessages = await AssignmentMessage.find({
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
          await emitToAssignmentClients(io, message, "new_assignment_message");
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

exports.approveMessage = async function approveMessage(req, res) {
  try {
    const { id } = req.params;
    const msg = await AssignmentMessage.findById(id);
    if (!msg) return res.status(404).json({ error: "Message not found" });

    const userRole = normalizeRole(req.employee?.role || "");
    if (userRole !== "team_lead") {
      return res
        .status(403)
        .json({ error: "Only Team Leads can approve messages" });
    }

    msg.approvalStatus = "approved";
    await msg.save();

    // Forward to managers
    const { managers } = await findTLsAndManagersByOwner(msg.owner);
    if (managers.length === 0) {
      return res.json({ message: "Approved but no managers found" });
    }

    const forwardMsg = await AssignmentMessage.create({
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

    // EMIT REAL-TIME EVENTS FOR BOTH MESSAGES
    const io = getIO(req);
    if (io) {
      await emitMessageUpdate(io, msg, "approved");
      await emitToAssignmentClients(io, forwardMsg, "new_assignment_message");
    }

    res.json(populated);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to approve message" });
  }
};

// PATCH /api/assignment-messages/:id/disapprove
exports.disapproveMessage = async function disapproveMessage(req, res) {
  try {
    const { id } = req.params;
    const { disapprovalNote } = req.body;

    const msg = await AssignmentMessage.findById(id);
    if (!msg) return res.status(404).json({ error: "Message not found" });

    const userRole = normalizeRole(req.employee?.role || "");
    if (userRole !== "team_lead") {
      return res
        .status(403)
        .json({ error: "Only Team Leads can disapprove messages" });
    }

    // ✅ ONLY update the existing message - NO new message creation
    msg.approvalStatus = "disapproved";

    // Store disapproval note if provided
    if (disapprovalNote) {
      msg.disapprovalNote = disapprovalNote;
    }

    msg.updatedAt = new Date();
    await msg.save();

    // Populate the updated message for response
    const populated = await AssignmentMessage.findById(msg._id).populate([
      { path: "owner", select: "_id name companyEmail" },
      { path: "sender", select: "_id name companyEmail role" },
      { path: "receiver", select: "_id name companyEmail role" },
      { path: "client", select: "_id clientName" },
    ]);

    // ✅ EMIT REAL-TIME EVENT FOR THE UPDATED MESSAGE ONLY
    const io = getIO(req);
    if (io) {
      await emitMessageUpdate(io, msg, "disapproved");

      // Send specific disapproval notification to the sender
      await sendDisapprovalNotification(io, msg, req.employee);
    }

    res.json({
      success: true,
      message: "Message disapproved successfully",
      data: populated,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to disapprove message" });
  }
};

async function sendDisapprovalNotification(io, message, disapprovedBy) {
  try {
    if (!io || !message || !disapprovedBy) {
      throw new Error(
        "Socket instance, message, and disapprovedBy are required"
      );
    }

    // Populate the message to ensure we have all data
    const populatedMessage = await AssignmentMessage.findById(message._id)
      .populate("sender")
      .populate("receiver")
      .populate("client");

    if (!populatedMessage) {
      console.error(
        "❌ Message not found for disapproval notification:",
        message._id
      );
      return;
    }

    // Send ONLY to the original sender about disapproval
    const senderId =
      typeof populatedMessage.sender === "string"
        ? populatedMessage.sender
        : populatedMessage.sender?._id;

    if (senderId) {
      io.to(`employee_${senderId}`).emit("assignment_message_disapproved", {
        message: populatedMessage,
        disapprovedBy: {
          _id: disapprovedBy._id,
          name: disapprovedBy.name,
          companyEmail: disapprovedBy.companyEmail,
          role: disapprovedBy.role,
        },
        timestamp: new Date(),
        note:
          populatedMessage.disapprovalNote ||
          "Your message has been disapproved and needs revisions.",
      });
    }
  } catch (error) {
    console.error("❌ Error in sendDisapprovalNotification:", error);
    throw error;
  }
}
async function sendResubmissionNotification(io, message, resubmittedBy) {
  try {
    if (!io || !message || !resubmittedBy) {
      throw new Error(
        "Socket instance, message, and resubmittedBy are required"
      );
    }

    // Populate the message
    const populatedMessage = await AssignmentMessage.findById(message._id)
      .populate("sender")
      .populate("receiver")
      .populate("client");

    if (!populatedMessage) {
      console.error(
        "❌ Message not found for resubmission notification:",
        message._id
      );
      return;
    }

    // Notify ONLY team leads about the resubmission (not all employees)
    io.to("assignment_team_leads").emit("assignment_message_resubmitted", {
      message: populatedMessage,
      action: "resubmitted",
      resubmittedBy: {
        _id: resubmittedBy._id,
        name: resubmittedBy.name,
        companyEmail: resubmittedBy.companyEmail,
      },
      timestamp: new Date(),
    });
  } catch (error) {
    console.error("❌ Error in sendResubmissionNotification:", error);
    throw error;
  }
}
// GET /api/assignment-messages/:id
exports.getMessage = async function getMessage(req, res) {
  try {
    const msg = await AssignmentMessage.findById(req.params.id).populate([
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
    const msg = await AssignmentMessage.findById(req.params.id);
    if (!msg) return res.status(404).json({ error: "Not found" });

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

    // EMIT REAL-TIME EVENT
    const io = getIO(req);
    if (io) {
      await emitMessageUpdate(io, msg, "updated");
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
    const msg = await AssignmentMessage.findById(req.params.id);
    if (!msg) return res.status(404).json({ error: "Not found" });

    // Store message data for emission before deletion
    const messageData = msg.toObject();

    await AssignmentMessage.findByIdAndDelete(req.params.id);

    // EMIT REAL-TIME EVENT
    const io = getIO(req);
    if (io) {
      const clientId =
        typeof messageData.client === "string"
          ? messageData.client
          : messageData.client?._id;

      if (clientId) {
        io.to(`assignment_client_${clientId}`).emit(
          "assignment_message_deleted",
          {
            messageId: req.params.id,
            clientId: clientId,
          }
        );
      }

      // Notify all participants
      const allParticipants = new Set();

      // Add sender
      const senderId =
        typeof messageData.sender === "string"
          ? messageData.sender
          : messageData.sender?._id;
      if (senderId) allParticipants.add(senderId);

      // Add receivers
      if (messageData.receiver && Array.isArray(messageData.receiver)) {
        messageData.receiver.forEach((receiver) => {
          const receiverId =
            typeof receiver === "string" ? receiver : receiver._id;
          if (receiverId) allParticipants.add(receiverId);
        });
      }

      // Emit to all participants
      allParticipants.forEach((participantId) => {
        io.to(`employee_${participantId}`).emit("assignment_message_deleted", {
          messageId: req.params.id,
          clientId: clientId,
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
    const msg = await AssignmentMessage.findById(req.params.id);
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

    // EMIT REAL-TIME EVENT
    const io = getIO(req);
    if (io) {
      await emitMessageUpdate(io, msg, "attachments_updated");
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
    const msg = await AssignmentMessage.findById(req.params.id).populate([
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
    const msg = await AssignmentMessage.findById(id);
    if (!msg) return res.status(404).json({ error: "Not found" });

    const before = msg.attachments.length;
    msg.attachments = msg.attachments.filter((a) => a._id.toString() !== attId);
    const after = msg.attachments.length;

    if (before === after)
      return res.status(404).json({ error: "Attachment not found" });

    await msg.save();

    // EMIT REAL-TIME EVENT
    const io = getIO(req);
    if (io) {
      await emitMessageUpdate(io, msg, "attachment_deleted");
    }

    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to delete attachment" });
  }
};

// GET /api/assignment-messages/sent
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
      sender: me,
      client: client,
    };
    if (isObjId(owner)) q.owner = owner;

    const [items, total] = await Promise.all([
      AssignmentMessage.find(q)
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
      AssignmentMessage.countDocuments(q),
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
// POST /api/assignment-messages/drafts - Create new draft
exports.createDraft = async function createDraft(req, res) {
  try {
    const {
      owner: ownerBody,
      client,
      sender: senderBody,
      receiver: receiverBody,
      receivers: receiversBody,
      subject,
      note,
    } = req.body;

    const owner = ownerBody || req.employee?.owner;
    const sender = senderBody || req.employee?._id;

    if (!isObjId(owner) || !isObjId(client) || !isObjId(sender)) {
      return res.status(400).json({
        error: "owner, client, and sender are required (ObjectId strings)",
      });
    }

    let receivers = [];
    if (receiverBody) receivers = receivers.concat(normalizeIds(receiverBody));
    if (receiversBody)
      receivers = receivers.concat(normalizeIds(receiversBody));
    receivers = receivers.filter((id) => id !== String(sender));

    // Remove duplicates
    receivers = Array.from(new Set(receivers.map((id) => String(id)))).filter(
      (id) => id !== String(sender)
    );

    const draftData = {
      owner,
      client,
      sender,
      receiver: receivers,
      subject: subject || "Draft",
      note: note || "",
      status: "draft",
      isScheduled: false,
      // Drafts don't have sentAt
    };

    const draft = await AssignmentMessage.create(draftData);

    const populated = await draft.populate([
      { path: "owner", select: "_id name companyEmail" },
      { path: "sender", select: "_id name companyEmail role" },
      { path: "receiver", select: "_id name companyEmail role" },
      { path: "client", select: "_id clientName" },
    ]);

    res.status(201).json(populated);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to create draft" });
  }
};

// GET /api/assignment-messages/drafts - List all drafts for current user
exports.listDrafts = async function listDrafts(req, res) {
  try {
    const { client, owner, limit = 50, page = 1 } = req.query;

    const sender = req.employee?._id;

    if (!isObjId(sender)) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const q = {
      sender: sender,
      status: "draft",
      isScheduled: false, // Ensure we don't include scheduled messages
    };

    if (isObjId(client)) q.client = client;
    if (isObjId(owner)) q.owner = owner;
    else if (req.employee?.owner) q.owner = req.employee.owner;

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);

    const [items, total] = await Promise.all([
      AssignmentMessage.find(q)
        .sort({ updatedAt: -1 }) // Show recently updated drafts first
        .skip((pageNum - 1) * lim)
        .limit(lim)
        .populate([
          { path: "owner", select: "_id name companyEmail" },
          { path: "sender", select: "_id name companyEmail role" },
          { path: "receiver", select: "_id name companyEmail role" },
          { path: "client", select: "_id clientName" },
          { path: "attachments.uploadedBy", select: "_id name companyEmail" },
        ])
        .lean(),
      AssignmentMessage.countDocuments(q),
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
    res.status(500).json({ error: "Failed to fetch drafts" });
  }
};

// PATCH /api/assignment-messages/:id/send - Send a draft
exports.sendDraft = async function sendDraft(req, res) {
  try {
    const { id } = req.params;
    const {
      subject,
      note,
      receiver: receiverBody,
      receivers: receiversBody,
      isScheduled: isScheduledBody,
      scheduledFor,
    } = req.body;

    const msg = await AssignmentMessage.findById(id);
    if (!msg) {
      return res.status(404).json({ error: "Draft not found" });
    }

    // Check permissions - only sender can send their draft
    if (String(msg.sender) !== String(req.employee._id)) {
      return res
        .status(403)
        .json({ error: "You can only send your own drafts" });
    }

    // Check if draft is already sent
    if (msg.status !== "draft") {
      return res.status(400).json({ error: "Message is not a draft" });
    }

    // Update fields
    if (subject !== undefined) msg.subject = subject;
    if (note !== undefined) msg.note = note;

    // Update receivers if provided
    let receivers = msg.receiver.map((id) => String(id));
    if (receiverBody) {
      receivers = receivers.concat(normalizeIds(receiverBody));
    }
    if (receiversBody) {
      receivers = receivers.concat(normalizeIds(receiversBody));
    }
    receivers = Array.from(new Set(receivers.map((id) => String(id)))).filter(
      (id) => id !== String(msg.sender)
    );

    if (receivers.length > 0) {
      msg.receiver = receivers;
    }

    // Handle scheduling
    const isScheduled = isScheduledBody === true || isScheduledBody === "true";

    if (isScheduled) {
      const validation = validateScheduleTime(scheduledFor);
      if (!validation.valid) {
        return res.status(400).json({ error: validation.error });
      }

      msg.isScheduled = true;
      msg.status = "scheduled";
      msg.scheduledFor = validation.scheduleTime;
      msg.scheduledAt = new Date();
      msg.scheduledBy = req.employee._id;
      msg.sentAt = null;
    } else {
      msg.isScheduled = false;
      msg.status = "sent";
      msg.sentAt = new Date();
      msg.scheduledFor = undefined;
      msg.scheduledAt = undefined;
      msg.scheduledBy = undefined;
    }

    await msg.save();

    const populated = await msg.populate([
      { path: "owner", select: "_id name companyEmail" },
      { path: "sender", select: "_id name companyEmail role" },
      { path: "receiver", select: "_id name companyEmail role" },
      { path: "client", select: "_id clientName" },
      { path: "attachments.uploadedBy", select: "_id name companyEmail" },
      { path: "scheduledBy", select: "_id name companyEmail" },
    ]);

    // EMIT REAL-TIME EVENT (only for immediate sends, not scheduled)
    if (!isScheduled) {
      const io = getIO(req);
      if (io) {
        await emitToAssignmentClients(io, msg, "new_assignment_message");
      }
    }

    res.json({
      message: isScheduled
        ? "Draft scheduled successfully"
        : "Draft sent successfully",
      data: populated,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to send draft" });
  }
};

// GET /api/assignment-messages/drafts/count - Get draft count for current user
exports.getDraftCount = async function getDraftCount(req, res) {
  try {
    const sender = req.employee?._id;

    if (!isObjId(sender)) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const count = await AssignmentMessage.countDocuments({
      sender: sender,
      status: "draft",
      isScheduled: false,
    });

    res.json({ count });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to get draft count" });
  }
};
exports.editDisapprovedMessage = async function editDisapprovedMessage(
  req,
  res
) {
  try {
    const { id } = req.params;
    const { subject, note } = req.body;

    // Enhanced validation
    if (!id) {
      return res.status(400).json({ error: "Message ID is required" });
    }

    // Validate MongoDB ObjectId format
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid message ID format" });
    }

    if (subject === undefined && note === undefined) {
      return res
        .status(400)
        .json({ error: "No changes provided. Please update subject or note." });
    }

    // Validate subject length if provided
    if (subject !== undefined && subject.trim().length === 0) {
      return res.status(400).json({ error: "Subject cannot be empty" });
    }

    // Validate note length if provided
    if (note !== undefined && note.trim().length === 0) {
      return res.status(400).json({ error: "Note cannot be empty" });
    }

    // Find the message with proper error handling
    const msg = await AssignmentMessage.findById(id);
    if (!msg) {
      return res.status(404).json({ error: "Message not found" });
    }

    // Check approval status
    if (msg.approvalStatus !== "disapproved") {
      return res.status(400).json({
        error: "Only disapproved messages can be edited for resubmission",
        currentStatus: msg.approvalStatus,
      });
    }

    // Check ownership
    const isSender = String(msg.sender) === String(req.employee._id);
    if (!isSender) {
      return res.status(403).json({
        error: "You can only edit your own messages",
        messageOwner: msg.sender,
        currentUser: req.employee._id,
      });
    }

    // Update message fields
    const updateFields = {};
    if (subject !== undefined) {
      updateFields.subject = subject.trim();
    }
    if (note !== undefined) {
      updateFields.note = note.trim();
    }

    updateFields.approvalStatus = "pending";
    updateFields.updatedAt = new Date();
    updateFields.resubmittedAt = new Date(); // Track resubmission time

    // Update the message
    const updatedMsg = await AssignmentMessage.findByIdAndUpdate(
      id,
      { $set: updateFields },
      { new: true, runValidators: true }
    );

    if (!updatedMsg) {
      throw new Error("Failed to update message in database");
    }

    // Populate the updated message
    const populated = await AssignmentMessage.findById(updatedMsg._id).populate(
      [
        { path: "owner", select: "_id name companyEmail" },
        { path: "sender", select: "_id name companyEmail role" },
        { path: "receiver", select: "_id name companyEmail role" },
        { path: "client", select: "_id clientName" },
        { path: "attachments.uploadedBy", select: "_id name companyEmail" },
      ]
    );

    if (!populated) {
      throw new Error("Failed to populate updated message data");
    }

    // EMIT REAL-TIME EVENT FOR RESUBMISSION (with error handling)
    try {
      const io = getIO(req);
      if (io) {
        // Emit message update
        await emitMessageUpdate(io, populated, "disapproved_message_edited");

        // Send resubmission notification to Team Leads
        await sendResubmissionNotification(io, populated, req.employee);

        // Notify all relevant parties about the resubmission
        io.to("assignment_team_leads").emit("assignment_message_resubmitted", {
          message: populated,
          action: "resubmitted",
          resubmittedBy: {
            _id: req.employee._id,
            name: req.employee.name,
            companyEmail: req.employee.companyEmail,
          },
          timestamp: new Date(),
        });

        // Notify the sender that their message was resubmitted successfully
        io.to(`employee_${req.employee._id}`).emit(
          "message_resubmission_success",
          {
            message: populated,
            timestamp: new Date(),
          }
        );
      } else {
        console.warn(
          "⚠️ Socket.io instance not available for real-time updates"
        );
      }
    } catch (socketError) {
      console.error("❌ Socket.io event error (non-critical):", socketError);
      // Don't fail the entire request if socket events fail
    }
    res.json({
      success: true,
      message: "Disapproved message edited and submitted for review",
      data: populated,
      timestamp: new Date(),
    });
  } catch (e) {
    console.error("❌ Error in editDisapprovedMessage:", e);

    // More specific error responses
    if (e.name === "ValidationError") {
      return res.status(400).json({
        error: "Validation failed",
        details: Object.values(e.errors).map((err) => err.message),
      });
    }

    if (e.name === "CastError") {
      return res.status(400).json({ error: "Invalid data format" });
    }

    if (e.code === 11000) {
      return res.status(400).json({ error: "Duplicate entry found" });
    }

    res.status(500).json({
      error: "Failed to edit disapproved message",
      ...(process.env.NODE_ENV === "development" && { debug: e.message }),
    });
  }
};
// GET /api/assignment-messages/review
exports.getReviewMessages = async function getReviewMessages(req, res) {
  try {
    // Fetch all messages, populate sender so we can inspect supervisionMode
    const msgs = await AssignmentMessage.find()
      .sort({ createdAt: 1 })
      .populate([
        { path: "sender", select: "name supervisionMode" },
        { path: "receiver", select: "name companyEmail role" },
        { path: "client", select: "_id clientName" },
        { path: "attachments.uploadedBy", select: "name companyEmail" },
      ])
      .lean();

    // Keep only those whose sender.supervisionMode === "direct"
    const directMsgs = msgs.filter(
      (m) => m.sender && m.sender.supervisionMode === "direct"
    );

    res.json({
      items: directMsgs,
      total: directMsgs.length,
    });
  } catch (e) {
    console.error("getReviewMessages error:", e);
    res.status(500).json({ error: "Failed to fetch review messages" });
  }
};
exports.getStarredMessages = async function getStarredMessages(req, res) {
  try {
    const {
      client,
      owner,
      limit = 50,
      page = 1,
      filter,
      status,
      isScheduled,
    } = req.query;

    const currentUser = req.employee?._id;
    if (!isObjId(currentUser)) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const q = {
      starredBy: currentUser, // Messages starred by current user
    };

    // Apply other filters if provided
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
    }

    // Scheduled filter
    if (filter === "scheduled" || isScheduled === "true") {
      q.isScheduled = true;
      q.status = "scheduled";
    } else if (isScheduled === "false") {
      q.isScheduled = false;
    }

    // Apply visibility rules to ensure user can see these messages
    const qFinal = await applyVisibility(q, req);

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);

    const [items, total] = await Promise.all([
      AssignmentMessage.find(qFinal)
        .sort({ updatedAt: -1 }) // Sort by when they were starred/updated
        .skip((pageNum - 1) * lim)
        .limit(lim)
        .populate([
          { path: "owner", select: "_id name companyEmail" },
          { path: "sender", select: "_id name companyEmail role" },
          { path: "receiver", select: "_id name companyEmail role" },
          { path: "client", select: "_id clientName" },
          { path: "attachments.uploadedBy", select: "_id name companyEmail" },
          { path: "scheduledBy", select: "_id name companyEmail" },
          { path: "starredBy", select: "_id name companyEmail" }, // Populate who starred it
        ])
        .lean(),
      AssignmentMessage.countDocuments(qFinal),
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
    res.status(500).json({ error: "Failed to fetch starred messages" });
  }
};

// PATCH /api/assignment-messages/:id/star - Star a message
exports.starMessage = async function starMessage(req, res) {
  try {
    const { id } = req.params;
    const currentUser = req.employee?._id;

    if (!isObjId(currentUser)) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const msg = await AssignmentMessage.findById(id);
    if (!msg) {
      return res.status(404).json({ error: "Message not found" });
    }

    // Check if user has permission to see this message
    const canView = await AssignmentMessage.findOne({
      _id: id,
      $or: [{ sender: currentUser }, { receiver: currentUser }],
    });

    if (!canView) {
      return res
        .status(403)
        .json({ error: "You don't have permission to star this message" });
    }

    // Toggle star - add user to starredBy if not present, remove if present
    const isStarred = msg.starredBy.includes(currentUser);

    if (isStarred) {
      // Unstar: remove user from starredBy
      msg.starredBy.pull(currentUser);
    } else {
      // Star: add user to starredBy
      msg.starredBy.addToSet(currentUser);
    }

    // Update starred flag based on whether anyone has starred it
    msg.starred = msg.starredBy.length > 0;

    await msg.save();

    const populated = await msg.populate([
      { path: "owner", select: "_id name companyEmail" },
      { path: "sender", select: "_id name companyEmail role" },
      { path: "receiver", select: "_id name companyEmail role" },
      { path: "client", select: "_id clientName" },
      { path: "attachments.uploadedBy", select: "_id name companyEmail" },
      { path: "starredBy", select: "_id name companyEmail" },
    ]);

    // EMIT REAL-TIME EVENT
    const io = getIO(req);
    if (io) {
      await emitMessageUpdate(io, msg, isStarred ? "unstarred" : "starred");
    }

    res.json({
      message: isStarred ? "Message unstarred" : "Message starred",
      data: populated,
      starred: !isStarred,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to update star status" });
  }
};

// GET /api/assignment-messages/starred/count - Get starred message count for current user
exports.getStarredCount = async function getStarredCount(req, res) {
  try {
    const currentUser = req.employee?._id;

    if (!isObjId(currentUser)) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const count = await AssignmentMessage.countDocuments({
      starredBy: currentUser,
    });

    res.json({ count });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to get starred count" });
  }
};

exports.moveToTrash = async function (req, res) {
  try {
    const msg = await AssignmentMessage.findById(req.params.id);
    if (!msg) return res.status(404).json({ error: "Message not found" });

    // Check permissions - user must be sender or receiver
    const userId = req.employee._id.toString();
    const senderId =
      typeof msg.sender === "string" ? msg.sender : msg.sender?._id?.toString();
    const receiverIds = Array.isArray(msg.receiver)
      ? msg.receiver.map((r) => (typeof r === "string" ? r : r._id?.toString()))
      : [];

    const hasAccess = userId === senderId || receiverIds.includes(userId);

    if (!hasAccess) {
      return res
        .status(403)
        .json({ error: "You don't have permission to delete this message" });
    }

    msg.isTrashed = true;
    msg.trashedAt = new Date();
    msg.trashedBy = req.employee._id;
    await msg.save();

    const populated = await msg.populate([
      { path: "owner", select: "_id name companyEmail" },
      { path: "sender", select: "_id name companyEmail role" },
      { path: "receiver", select: "_id name companyEmail role" },
      { path: "client", select: "_id clientName" },
      { path: "trashedBy", select: "_id name companyEmail" },
    ]);

    // Emit socket event
    const io = getIO(req);
    if (io) await emitMessageUpdate(io, msg, "moved_to_trash");

    res.json({ message: "Message moved to trash", data: populated });
  } catch (e) {
    console.error("Error moving to trash:", e);
    res.status(500).json({ error: "Failed to move to trash" });
  }
};

// Restore from trash
exports.restoreFromTrash = async function (req, res) {
  try {
    const msg = await AssignmentMessage.findById(req.params.id);
    if (!msg) return res.status(404).json({ error: "Message not found" });

    // Check permissions
    const userId = req.employee._id.toString();
    const senderId =
      typeof msg.sender === "string" ? msg.sender : msg.sender?._id?.toString();
    const receiverIds = Array.isArray(msg.receiver)
      ? msg.receiver.map((r) => (typeof r === "string" ? r : r._id?.toString()))
      : [];

    const hasAccess = userId === senderId || receiverIds.includes(userId);

    if (!hasAccess) {
      return res
        .status(403)
        .json({ error: "You don't have permission to restore this message" });
    }

    msg.isTrashed = false;
    msg.trashedAt = undefined;
    msg.trashedBy = undefined;
    await msg.save();

    const populated = await msg.populate([
      { path: "owner", select: "_id name companyEmail" },
      { path: "sender", select: "_id name companyEmail role" },
      { path: "receiver", select: "_id name companyEmail role" },
      { path: "client", select: "_id clientName" },
    ]);

    // Emit socket event
    const io = getIO(req);
    if (io) await emitMessageUpdate(io, msg, "restored_from_trash");

    res.json({ message: "Message restored", data: populated });
  } catch (e) {
    console.error("Error restoring from trash:", e);
    res.status(500).json({ error: "Failed to restore" });
  }
};

exports.getTrashMessages = async function getTrashMessages(req, res) {
  try {
    const { limit = 50, page = 1, client } = req.query;
    const currentUser = req.employee?._id;

    if (!isObjId(currentUser)) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    // CRITICAL: Only show messages where current user is involved AND message is trashed
    const q = {
      isTrashed: true,
      $or: [
        { sender: currentUser },
        { receiver: currentUser },
        { receiver: { $in: [currentUser] } },
      ],
    };

    // Add client filter if provided
    if (client && mongoose.isValidObjectId(client)) {
      q.client = client;
    }
    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
    const populateFields = [
      { path: "sender", select: "_id name companyEmail" },
      { path: "receiver", select: "_id name companyEmail role" },
      { path: "client", select: "_id clientName" },
      { path: "trashedBy", select: "_id name companyEmail" },
    ];

    const items = await AssignmentMessage.find(q)
      .sort({ trashedAt: -1, updatedAt: -1 })
      .skip((pageNum - 1) * lim)
      .limit(lim)
      .populate(populateFields)
      .lean();

    const total = await AssignmentMessage.countDocuments(q);
    // Ensure receiver is always treated as array for consistency
    const normalizedItems = items.map((item) => ({
      ...item,
      receiver: Array.isArray(item.receiver)
        ? item.receiver
        : [item.receiver].filter(Boolean),
    }));

    res.json({
      items: normalizedItems,
      total,
      page: pageNum,
      pages: Math.ceil(total / lim),
      limit: lim,
    });
  } catch (e) {
    console.error("❌ Error in getTrashMessages:", e);
    console.error("❌ Error stack:", e.stack);

    res.status(500).json({
      error: "Failed to load trash messages",
      details: e.message,
      ...(process.env.NODE_ENV === "development" && { stack: e.stack }),
    });
  }
};
// Permanently delete a message
// DELETE /api/assignment-messages/thread/:clientId - Delete entire thread for a client
exports.deleteThread = async function deleteThread(req, res) {
  try {
    const { clientId } = req.params;

    if (!isObjId(clientId)) {
      return res.status(400).json({ error: "Valid client ID is required" });
    }

    // Check permissions - user must be involved in the thread
    const userId = req.employee._id.toString();

    // Find all messages for this client where user is sender or receiver
    const threadMessages = await AssignmentMessage.find({
      client: clientId,
      $or: [
        { sender: userId },
        { receiver: userId },
        { receiver: { $in: [userId] } },
      ],
    });

    if (threadMessages.length === 0) {
      return res.status(404).json({ error: "No thread found for this client" });
    }

    // Store message IDs for socket emission
    const messageIds = threadMessages.map((msg) => msg._id);
    const clientIdForEmission = threadMessages[0]?.client;

    // Delete all messages in the thread
    await AssignmentMessage.deleteMany({
      _id: { $in: messageIds },
    });

    // EMIT REAL-TIME EVENT FOR THREAD DELETION
    const io = getIO(req);
    if (io) {
      // Notify all participants in all deleted messages
      const allParticipants = new Set();

      threadMessages.forEach((message) => {
        // Add sender
        const senderId =
          typeof message.sender === "string"
            ? message.sender
            : message.sender?._id?.toString();
        if (senderId) allParticipants.add(senderId);

        // Add receivers
        if (message.receiver && Array.isArray(message.receiver)) {
          message.receiver.forEach((receiver) => {
            const receiverId =
              typeof receiver === "string"
                ? receiver
                : receiver?._id?.toString();
            if (receiverId) allParticipants.add(receiverId);
          });
        }
      });

      // Emit to all participants
      allParticipants.forEach((participantId) => {
        io.to(`employee_${participantId}`).emit("assignment_thread_deleted", {
          clientId: clientId,
          messageIds: messageIds,
          deletedBy: userId,
          timestamp: new Date(),
        });
      });
    }

    res.json({
      success: true,
      message: `Thread deleted successfully (${messageIds.length} messages removed)`,
      deletedCount: messageIds.length,
    });
  } catch (e) {
    console.error("Error deleting thread:", e);
    res.status(500).json({ error: "Failed to delete thread" });
  }
};

// DELETE /api/assignment-messages/thread/:threadId/permanent - Permanently delete thread from trash
exports.permanentlyDeleteThread = async function permanentlyDeleteThread(
  req,
  res
) {
  try {
    const { threadId } = req.params; // Changed from clientId to threadId

    if (!threadId) {
      return res.status(400).json({ error: "Valid thread ID is required" });
    }

    const userId = req.employee._id.toString();

    // Find all trashed messages for this thread where user is involved
    const trashedMessages = await AssignmentMessage.find({
      threadId: threadId, // Changed from client to threadId
      $or: [
        { sender: userId },
        { receiver: userId },
        { receiver: { $in: [userId] } },
      ],
      isTrashed: true,
    });

    if (trashedMessages.length === 0) {
      return res
        .status(404)
        .json({ error: "No trashed thread found with this thread ID" });
    }

    const messageIds = trashedMessages.map((msg) => msg._id);

    // Permanently delete all trashed messages in the thread
    await AssignmentMessage.deleteMany({
      _id: { $in: messageIds },
    });

    // EMIT REAL-TIME EVENT
    const io = getIO(req);
    if (io) {
      const allParticipants = new Set();

      trashedMessages.forEach((message) => {
        const senderId =
          typeof message.sender === "string"
            ? message.sender
            : message.sender?._id?.toString();
        if (senderId) allParticipants.add(senderId);

        if (message.receiver && Array.isArray(message.receiver)) {
          message.receiver.forEach((receiver) => {
            const receiverId =
              typeof receiver === "string"
                ? receiver
                : receiver?._id?.toString();
            if (receiverId) allParticipants.add(receiverId);
          });
        }
      });

      allParticipants.forEach((participantId) => {
        io.to(`employee_${participantId}`).emit(
          "assignment_thread_permanently_deleted",
          {
            threadId: threadId, // Changed from clientId to threadId
            messageIds: messageIds,
            deletedBy: userId,
            timestamp: new Date(),
            permanent: true,
          }
        );
      });
    }

    res.json({
      success: true,
      message: `Thread permanently deleted (${messageIds.length} messages removed)`,
      deletedCount: messageIds.length,
    });
  } catch (e) {
    console.error("Error permanently deleting thread:", e);
    res.status(500).json({ error: "Failed to permanently delete thread" });
  }
};
// PATCH /api/assignment-messages/thread/:threadId/trash - Move entire thread to trash
exports.moveThreadToTrash = async function moveThreadToTrash(req, res) {
  try {
    const { threadId } = req.params;
    const userId = req.employee._id.toString();

    if (!threadId) {
      return res.status(400).json({ error: "Valid thread ID is required" });
    }

    // Find all messages for this thread where user is involved
    const threadMessages = await AssignmentMessage.find({
      threadId: threadId,
      $or: [
        { sender: userId },
        { receiver: userId },
        { receiver: { $in: [userId] } },
      ],
      isTrashed: false, // Only non-trashed messages
    });

    if (threadMessages.length === 0) {
      return res
        .status(404)
        .json({ error: "No active thread found with this thread ID" });
    }

    // Move all messages to trash
    await AssignmentMessage.updateMany(
      {
        _id: { $in: threadMessages.map((msg) => msg._id) },
      },
      {
        isTrashed: true,
        trashedAt: new Date(),
        trashedBy: req.employee._id,
      }
    );

    // EMIT REAL-TIME EVENT
    const io = getIO(req);
    if (io) {
      const allParticipants = new Set();

      threadMessages.forEach((message) => {
        const senderId =
          typeof message.sender === "string"
            ? message.sender
            : message.sender?._id?.toString();
        if (senderId) allParticipants.add(senderId);

        if (message.receiver && Array.isArray(message.receiver)) {
          message.receiver.forEach((receiver) => {
            const receiverId =
              typeof receiver === "string"
                ? receiver
                : receiver?._id?.toString();
            if (receiverId) allParticipants.add(receiverId);
          });
        }
      });

      allParticipants.forEach((participantId) => {
        io.to(`employee_${participantId}`).emit("assignment_thread_trashed", {
          threadId: threadId,
          messageIds: threadMessages.map((msg) => msg._id),
          trashedBy: userId,
          timestamp: new Date(),
        });
      });
    }

    res.json({
      success: true,
      message: `Thread moved to trash (${threadMessages.length} messages)`,
      movedCount: threadMessages.length,
    });
  } catch (e) {
    console.error("Error moving thread to trash:", e);
    res.status(500).json({ error: "Failed to move thread to trash" });
  }
};
// PATCH /api/assignment-messages/thread/:clientId/restore - Restore entire thread from trash
exports.restoreThreadFromTrash = async function restoreThreadFromTrash(
  req,
  res
) {
  try {
    const { clientId } = req.params;

    if (!isObjId(clientId)) {
      return res.status(400).json({ error: "Valid client ID is required" });
    }

    const userId = req.employee._id.toString();

    // Find all trashed messages for this client where user is involved
    const trashedMessages = await AssignmentMessage.find({
      client: clientId,
      isTrashed: true,
      $or: [
        { sender: userId },
        { receiver: userId },
        { receiver: { $in: [userId] } },
      ],
    });

    if (trashedMessages.length === 0) {
      return res
        .status(404)
        .json({ error: "No trashed thread found for this client" });
    }

    // Restore all messages from trash
    await AssignmentMessage.updateMany(
      {
        _id: { $in: trashedMessages.map((msg) => msg._id) },
      },
      {
        isTrashed: false,
        trashedAt: undefined,
        trashedBy: undefined,
      }
    );

    // EMIT REAL-TIME EVENT
    const io = getIO(req);
    if (io) {
      const allParticipants = new Set();

      trashedMessages.forEach((message) => {
        const senderId =
          typeof message.sender === "string"
            ? message.sender
            : message.sender?._id?.toString();
        if (senderId) allParticipants.add(senderId);

        if (message.receiver && Array.isArray(message.receiver)) {
          message.receiver.forEach((receiver) => {
            const receiverId =
              typeof receiver === "string"
                ? receiver
                : receiver?._id?.toString();
            if (receiverId) allParticipants.add(receiverId);
          });
        }
      });

      allParticipants.forEach((participantId) => {
        io.to(`employee_${participantId}`).emit("assignment_thread_restored", {
          clientId: clientId,
          messageIds: trashedMessages.map((msg) => msg._id),
          restoredBy: userId,
          timestamp: new Date(),
        });
      });
    }

    res.json({
      success: true,
      message: `Thread restored from trash (${trashedMessages.length} messages)`,
      restoredCount: trashedMessages.length,
    });
  } catch (e) {
    console.error("Error restoring thread from trash:", e);
    res.status(500).json({ error: "Failed to restore thread from trash" });
  }
};
// Report message as spam
exports.reportSpam = async function reportSpam(req, res) {
  try {
    const { id } = req.params;
    const currentUser = req.employee?._id;

    if (!isObjId(currentUser)) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const msg = await AssignmentMessage.findById(id);
    if (!msg) {
      return res.status(404).json({ error: "Message not found" });
    }

    // Check if user has already reported this message
    const alreadyReported = msg.spamReporters.includes(currentUser);
    if (alreadyReported) {
      return res
        .status(400)
        .json({ error: "You have already reported this message as spam" });
    }

    // Update spam fields
    msg.isSpam = true;
    msg.spamReportCount += 1;
    msg.spamReporters.push(currentUser);

    // Set initial spam report time if this is the first report
    if (msg.spamReportCount === 1) {
      msg.spamReportedAt = new Date();
      msg.spamReportedBy = currentUser;
    }

    await msg.save();

    const populated = await msg.populate([
      { path: "owner", select: "_id name companyEmail" },
      { path: "sender", select: "_id name companyEmail role" },
      { path: "receiver", select: "_id name companyEmail role" },
      { path: "client", select: "_id clientName" },
      { path: "spamReportedBy", select: "_id name companyEmail" },
      { path: "spamReporters", select: "_id name companyEmail" },
    ]);

    // EMIT REAL-TIME EVENT
    const io = getIO(req);
    if (io) {
      await emitMessageUpdate(io, msg, "reported_as_spam");
    }

    res.json({
      success: true,
      message: "Message reported as spam successfully",
      data: populated,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to report message as spam" });
  }
};

// Remove from spam (for admins/moderators)
exports.removeFromSpam = async function removeFromSpam(req, res) {
  try {
    const { id } = req.params;
    const currentUser = req.employee?._id;

    if (!isObjId(currentUser)) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const msg = await AssignmentMessage.findById(id);
    if (!msg) {
      return res.status(404).json({ error: "Message not found" });
    }

    // Reset spam fields
    msg.isSpam = false;
    msg.spamReportCount = 0;
    msg.spamReporters = [];
    msg.spamReportedAt = undefined;
    msg.spamReportedBy = undefined;

    await msg.save();

    const populated = await msg.populate([
      { path: "owner", select: "_id name companyEmail" },
      { path: "sender", select: "_id name companyEmail role" },
      { path: "receiver", select: "_id name companyEmail role" },
      { path: "client", select: "_id clientName" },
    ]);

    // EMIT REAL-TIME EVENT
    const io = getIO(req);
    if (io) {
      await emitMessageUpdate(io, msg, "removed_from_spam");
    }

    res.json({
      success: true,
      message: "Message removed from spam successfully",
      data: populated,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to remove message from spam" });
  }
};

exports.getSpamMessages = async function getSpamMessages(req, res) {
  try {
    const { client, owner, limit = 50, page = 1 } = req.query;

    const currentUser = req.employee?._id;
    if (!isObjId(currentUser)) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    // Build base query for spam messages
    const q = {
      isSpam: true,
    };

    // Apply other filters if provided
    if (isObjId(owner)) {
      q.owner = owner;
    } else if (req.employee?.owner) {
      q.owner = req.employee.owner;
    }

    if (isObjId(client)) {
      q.client = client;
    }
    // Apply visibility rules
    const qFinal = await applyVisibility(q, req);
    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);

    // Execute query with proper error handling
    let items, total;
    try {
      [items, total] = await Promise.all([
        AssignmentMessage.find(qFinal)
          .sort({ spamReportedAt: -1, createdAt: -1 })
          .skip((pageNum - 1) * lim)
          .limit(lim)
          .populate([
            { path: "owner", select: "_id name companyEmail" },
            { path: "sender", select: "_id name companyEmail role" },
            { path: "receiver", select: "_id name companyEmail role" },
            { path: "client", select: "_id clientName" },
            { path: "attachments.uploadedBy", select: "_id name companyEmail" },
            { path: "spamReportedBy", select: "_id name companyEmail" },
            { path: "spamReporters", select: "_id name companyEmail" },
          ])
          .lean(),
        AssignmentMessage.countDocuments(qFinal),
      ]);
    } catch (dbError) {
      console.error("❌ Database query error:", dbError);
      return res.status(500).json({
        error: "Database query failed",
        details: dbError.message,
      });
    }

    res.json({
      items: items || [],
      total: total || 0,
      page: pageNum,
      pages: Math.ceil(total / lim) || 1,
      limit: lim,
    });
  } catch (e) {
    console.error("❌ Error in getSpamMessages:", e);
    console.error("❌ Error stack:", e.stack);

    res.status(500).json({
      error: "Failed to fetch spam messages",
      details: e.message,
      ...(process.env.NODE_ENV === "development" && { stack: e.stack }),
    });
  }
};

exports.searchMessages = async function searchMessages(req, res) {
  try {
    const {
      q: searchQuery, // Main search term
      client,
      sender,
      receiver,
      owner,
      status,
      isScheduled,
      approvalStatus,
      isTrashed,
      isSpam,
      starred, // Filter starred messages
      hasAttachments,
      searchIn = "all", // subject, note, attachments, all
      limit = 50,
      page = 1,
      dateFrom,
      dateTo,
      scheduledFrom,
      scheduledTo,
      sortBy = "newest", // newest, oldest, relevance
    } = req.query;

    const q = {};

    // ✅ Owner / client scope
    if (isObjId(owner)) q.owner = owner;
    else if (req.employee?.owner) q.owner = req.employee.owner;
    if (isObjId(client)) q.client = client;

    // ✅ Status filter
    if (
      status &&
      ["draft", "scheduled", "sent", "cancelled"].includes(status)
    ) {
      q.status = status;
      if (status === "draft") q.isScheduled = false;
    }

    // ✅ Scheduled filter
    if (isScheduled === "true") {
      q.isScheduled = true;
    } else if (isScheduled === "false") {
      q.isScheduled = false;
    }

    // ✅ Approval status filter
    if (
      approvalStatus &&
      ["pending", "approved", "disapproved"].includes(approvalStatus)
    ) {
      q.approvalStatus = approvalStatus;
    }

    // ✅ Trash/Spam filters
    if (isTrashed === "true" || isTrashed === true) {
      q.isTrashed = true;
    } else if (isSpam === "true" || isSpam === true) {
      q.isSpam = true;
    } else if (isTrashed === "false" && isSpam === "false") {
      // Default: exclude both trash and spam from normal searches
      q.isTrashed = { $ne: true };
      q.isSpam = { $ne: true };
    }

    // ✅ Starred filter
    if (starred === "true" && req.employee?._id) {
      q.starredBy = req.employee._id;
    }

    // ✅ Attachment filter
    if (hasAttachments === "true") {
      q["attachments.0"] = { $exists: true };
    } else if (hasAttachments === "false") {
      q.attachments = { $size: 0 };
    }

    // ✅ Date range filter
    const dateFilter = {};
    if (dateFrom) {
      const fromDate = new Date(dateFrom);
      if (!isNaN(fromDate)) dateFilter.$gte = fromDate;
    }
    if (dateTo) {
      const toDate = new Date(dateTo);
      if (!isNaN(toDate)) dateFilter.$lte = toDate;
    }
    if (Object.keys(dateFilter).length) {
      q.createdAt = dateFilter;
    }

    // ✅ Scheduled date range filter
    const scheduledFilter = {};
    if (scheduledFrom) {
      const fromDate = new Date(scheduledFrom);
      if (!isNaN(fromDate)) scheduledFilter.$gte = fromDate;
    }
    if (scheduledTo) {
      const toDate = new Date(scheduledTo);
      if (!isNaN(toDate)) scheduledFilter.$lte = toDate;
    }
    if (Object.keys(scheduledFilter).length) {
      q.scheduledFor = scheduledFilter;
    }

    // ✅ User-based filters
    if (isObjId(sender)) q.sender = sender;
    if (isObjId(receiver)) {
      q.$or = [{ receiver: receiver }, { receiver: { $in: [receiver] } }];
    }

    // ✅ Apply visibility rules
    const qFinal = await applyVisibility(q, req);

    // ✅ SEARCH LOGIC - Only add search conditions if searchQuery is provided
    if (searchQuery && searchQuery.trim().length > 0) {
      const searchTerm = searchQuery.trim();
      const searchConditions = [];

      // Determine which fields to search in
      const searchFields = Array.isArray(searchIn) ? searchIn : [searchIn];

      // Text search in specified fields
      if (searchFields.includes("subject") || searchFields.includes("all")) {
        searchConditions.push({
          subject: { $regex: searchTerm, $options: "i" },
        });
      }

      if (searchFields.includes("note") || searchFields.includes("all")) {
        searchConditions.push({ note: { $regex: searchTerm, $options: "i" } });
      }

      // Search in attachment filenames
      if (
        searchFields.includes("attachments") ||
        searchFields.includes("all")
      ) {
        searchConditions.push({
          "attachments.originalName": { $regex: searchTerm, $options: "i" },
        });
      }

      // If we have search conditions, add them to the query
      if (searchConditions.length > 0) {
        qFinal.$and = qFinal.$and || [];
        qFinal.$and.push({
          $or: searchConditions,
        });
      }
    }

    // ✅ Pagination
    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);

    // ✅ Determine sort order
    let sortCriteria = {};
    if (searchQuery && sortBy === "relevance") {
      // Basic relevance sorting
      sortCriteria = {
        createdAt: -1,
      };
    } else if (sortBy === "oldest") {
      sortCriteria = { createdAt: 1 };
    } else {
      sortCriteria = { createdAt: -1 }; // newest first (default)
    }

    // ✅ Execute search
    const [items, total] = await Promise.all([
      AssignmentMessage.find(qFinal)
        .sort(sortCriteria)
        .skip((pageNum - 1) * lim)
        .limit(lim)
        .populate([
          { path: "owner", select: "_id name companyEmail" },
          { path: "sender", select: "_id name companyEmail role" },
          { path: "receiver", select: "_id name companyEmail role" },
          { path: "client", select: "_id clientName" },
          { path: "attachments.uploadedBy", select: "_id name companyEmail" },
          { path: "scheduledBy", select: "_id name companyEmail" },
          { path: "starredBy", select: "_id name companyEmail" },
        ])
        .lean(),
      AssignmentMessage.countDocuments(qFinal),
    ]);

    // ✅ Ensure receiver is always treated as array for consistency
    const normalizedItems = items.map((item) => ({
      ...item,
      receiver: Array.isArray(item.receiver)
        ? item.receiver
        : [item.receiver].filter(Boolean),
    }));

    res.json({
      success: true,
      items: normalizedItems,
      total,
      page: pageNum,
      pages: Math.ceil(total / lim),
      limit: lim,
      searchQuery: searchQuery || null,
      filters: {
        client,
        sender,
        receiver,
        status,
        isScheduled,
        approvalStatus,
        isTrashed,
        isSpam,
        starred,
        hasAttachments,
        dateFrom,
        dateTo,
      },
      hasMore: total > pageNum * lim,
    });
  } catch (e) {
    console.error("❌ Error in searchMessages:", e);
    res.status(500).json({
      success: false,
      error: "Failed to search messages",
      details: process.env.NODE_ENV === "development" ? e.message : undefined,
    });
  }
};
// GET /api/assignment-messages/client/:clientId/threads
exports.getClientThreads = async function getClientThreads(req, res) {
  try {
    const { clientId } = req.params;
    const { limit = 50, page = 1 } = req.query;

    if (!isObjId(clientId)) {
      return res.status(400).json({ error: "Valid client ID is required" });
    }

    // Apply visibility rules
    const qFinal = await applyVisibility({ client: clientId }, req);

    // Group by threadId and get latest message from each thread
    const threads = await AssignmentMessage.aggregate([
      { $match: qFinal },
      { $sort: { createdAt: -1 } },
      {
        $group: {
          _id: "$threadId",
          latestMessage: { $first: "$$ROOT" },
          messageCount: { $sum: 1 },
          unreadCount: {
            $sum: {
              $cond: [{ $eq: ["$isRead", false] }, 1, 0],
            },
          },
          lastActivity: { $max: "$createdAt" },
        },
      },
      { $sort: { lastActivity: -1 } },
      { $skip: (page - 1) * limit },
      { $limit: parseInt(limit) },
    ]);

    // Populate the latest messages
    const populatedThreads = await AssignmentMessage.populate(threads, [
      { path: "latestMessage.sender", select: "_id name companyEmail" },
      { path: "latestMessage.receiver", select: "_id name companyEmail" },
      { path: "latestMessage.client", select: "_id clientName" },
    ]);

    res.json({
      items: populatedThreads,
      total: populatedThreads.length,
      page: parseInt(page),
      pages: Math.ceil(populatedThreads.length / limit),
      limit: parseInt(limit),
    });
  } catch (e) {
    console.error("Error in getClientThreads:", e);
    res.status(500).json({ error: "Failed to fetch client threads" });
  }
};

// GET /api/assignment-messages/threads/:threadId
exports.getMessagesByThread = async function getMessagesByThread(req, res) {
  try {
    const { threadId } = req.params;
    const { limit = 50, page = 1 } = req.query;

    if (!threadId) {
      return res.status(400).json({ error: "Thread ID is required" });
    }

    // Build base query
    const q = { threadId };

    // Apply visibility rules
    const qFinal = await applyVisibility(q, req);

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);

    const [items, total] = await Promise.all([
      AssignmentMessage.find(qFinal)
        .sort({ createdAt: 1 }) // Oldest first for proper conversation flow
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
      AssignmentMessage.countDocuments(qFinal),
    ]);

    // Add direct message flag
    const normalizedItems = items.map((item) => ({
      ...item,
      isDirectMessage: !item.client,
    }));

    res.json({
      items: normalizedItems,
      total,
      page: pageNum,
      pages: Math.ceil(total / lim),
      limit: lim,
      threadId,
      isDirectMessageThread: items.length > 0 && !items[0].client,
    });
  } catch (e) {
    console.error("Error in getMessagesByThread:", e);
    res.status(500).json({ error: "Failed to fetch thread messages" });
  }
};
exports.getMessageCounts = async function getMessageCounts(req, res) {
  try {
    const currentUser = req.employee?._id;
    const owner = req.employee?.owner;

    console.log('🔍 Counts request - User:', currentUser, 'Owner:', owner);

    if (!isObjId(currentUser) || !isObjId(owner)) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    // Get counts for different categories
    const [
      inboxCount,
      starredCount,
      sentCount,
      draftCount,
      scheduledCount,
      spamCount,
      trashCount
    ] = await Promise.all([
      // Inbox: messages where user is receiver, not trashed, not spam, status sent
      AssignmentMessage.countDocuments({
        $or: [
          { receiver: currentUser },
          { receiver: { $in: [currentUser] } }
        ],
        status: 'sent',
        isTrashed: false,
        isSpam: false
      }),

      // Starred: messages starred by current user
      AssignmentMessage.countDocuments({
        starredBy: currentUser,
        isTrashed: false
      }),

      // Sent: messages where user is sender, status sent
      AssignmentMessage.countDocuments({
        sender: currentUser,
        status: 'sent',
        isTrashed: false
      }),

      // Drafts: draft messages by current user
      AssignmentMessage.countDocuments({
        sender: currentUser,
        status: 'draft',
        isTrashed: false
      }),

      // Scheduled: scheduled messages by current user
      AssignmentMessage.countDocuments({
        sender: currentUser,
        status: 'scheduled',
        isTrashed: false
      }),

      // Spam: spam messages where user is receiver
      AssignmentMessage.countDocuments({
        $or: [
          { receiver: currentUser },
          { receiver: { $in: [currentUser] } }
        ],
        isSpam: true,
        isTrashed: false
      }),

      // Trash: trashed messages where user is involved
      AssignmentMessage.countDocuments({
        $or: [
          { sender: currentUser },
          { receiver: currentUser },
          { receiver: { $in: [currentUser] } }
        ],
        isTrashed: true
      })
    ]);

    // Debug: Check if there are any starred messages at all
    const allStarredMessages = await AssignmentMessage.find({
      starredBy: { $exists: true, $ne: [] }
    }).select('starredBy').limit(5).lean();
    
    console.log('🔍 Starred messages sample:', allStarredMessages);
    console.log('🔍 Counts result:', {
      inbox: inboxCount,
      starred: starredCount,
      sent: sentCount,
      draft: draftCount,
      scheduled: scheduledCount,
      spam: spamCount,
      trash: trashCount
    });

    res.json({
      inbox: inboxCount,
      starred: starredCount,
      sent: sentCount,
      draft: draftCount,
      scheduled: scheduledCount,
      spam: spamCount,
      trash: trashCount,
      archive: 0
    });

  } catch (e) {
    console.error("Error in getMessageCounts:", e);
    res.status(500).json({ error: "Failed to fetch message counts" });
  }
};