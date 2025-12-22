const AssignmentMessage = require("../models/AssignmentMessage");
const Employee = require("../models/Employees");
const path = require("path");
const mongoose = require("mongoose");
const ClientInfo = require("../models/ClientInfo");
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

  if (cleanNew === cleanOriginal) {
    return originalMessage.threadId;
  }

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
  if (["teamlead", "team lead", "team_lead", "team-lead", "lead"].includes(r))
    return "team_lead";
  if (r === "manager") return "manager";
  if (["employee", "staff", "associate"].includes(r)) return "employee";
  return r;
}

async function applyVisibility(q, req) {
  // 🚨 CRITICAL: Return impossible query if no authenticated user
  if (!req.employee?._id) {
    return { _id: null };
  }

  const me = oid(String(req.employee._id));
  if (!me) {
    return { _id: null };
  }

  const currentUserRole = normalizeRole(req.employee?.role || "");
  const ownerId = req.employee?.owner ? oid(req.employee.owner) : null;

  // 🚨 CRITICAL: Base visibility - user must ALWAYS be participant
  const participantFilter = {
    $or: [{ sender: me }, { receiver: me }, { receiver: { $in: [me] } }],
  };

  // 🧑‍💼 MANAGER: Can see messages within their organization WHERE THEY ARE PARTICIPANTS
  if (currentUserRole === "manager" && ownerId) {
    const managerQuery = {
      $and: [
        { owner: ownerId }, // Within their organization
        participantFilter, // AND they are participant
      ],
    };

    // For thread-based queries, maintain thread context but ensure participation
    if (q.threadId) {
      managerQuery.$and.push({ threadId: q.threadId });

      // Verify manager has access to this thread
      const threadAccess = await AssignmentMessage.findOne({
        threadId: q.threadId,
        $and: [{ owner: ownerId }, participantFilter],
      });

      if (!threadAccess) {
        return { _id: null }; // No access to this thread
      }
    }

    // Handle scheduled messages for managers
    if (q.isScheduled === true && q.status === "scheduled") {
      const now = new Date();
      return {
        ...managerQuery,
        isScheduled: true,
        status: "scheduled",
        $or: [
          { scheduledFor: { $lte: now } }, // Past scheduled messages they can see
          { sender: me }, // Or their own future scheduled messages
        ],
      };
    }

    // Apply trash/spam filters if present
    if (q.isTrashed !== undefined) {
      managerQuery.$and.push({ isTrashed: q.isTrashed });
    }
    if (q.isSpam !== undefined) {
      managerQuery.$and.push({ isSpam: q.isSpam });
    }

    return managerQuery;
  }

  // 🎯 TEAM LEAD: Can see messages within their organization WHERE THEY ARE PARTICIPANTS
  if (currentUserRole === "team_lead" && ownerId) {
    const teamLeadQuery = {
      $and: [
        { owner: ownerId }, // Within their organization
        participantFilter, // AND they are participant
      ],
    };

    // For thread-based queries
    if (q.threadId) {
      teamLeadQuery.$and.push({ threadId: q.threadId });

      // Verify team lead has access to this thread
      const threadAccess = await AssignmentMessage.findOne({
        threadId: q.threadId,
        $and: [{ owner: ownerId }, participantFilter],
      });

      if (!threadAccess) {
        return { _id: null };
      }
    }

    // Special case: Team leads can see pending approval messages from their organization
    // but ONLY if they are participants OR if they need to review them
    if (q.approvalStatus === "pending" || q.filter === "review") {
      // For review filter, team leads can see pending messages from their org
      // that require their approval (direct supervision mode)
      const reviewQuery = {
        $and: [
          { owner: ownerId },
          { approvalStatus: "pending" },
          {
            $or: [
              participantFilter, // They are participant
              // OR it's a message from employees under their supervision
              {
                sender: {
                  $in: await getEmployeesUnderSupervision(ownerId, "team_lead"),
                },
              },
            ],
          },
        ],
      };

      // Apply additional filters
      if (q.threadId) reviewQuery.$and.push({ threadId: q.threadId });
      if (q.isTrashed !== undefined)
        reviewQuery.$and.push({ isTrashed: q.isTrashed });
      if (q.isSpam !== undefined) reviewQuery.$and.push({ isSpam: q.isSpam });

      return reviewQuery;
    }

    // Handle scheduled messages for team leads
    if (q.isScheduled === true && q.status === "scheduled") {
      const now = new Date();
      return {
        ...teamLeadQuery,
        isScheduled: true,
        status: "scheduled",
        $or: [{ scheduledFor: { $lte: now } }, { sender: me }],
      };
    }

    // Apply filters
    if (q.isTrashed !== undefined) {
      teamLeadQuery.$and.push({ isTrashed: q.isTrashed });
    }
    if (q.isSpam !== undefined) {
      teamLeadQuery.$and.push({ isSpam: q.isSpam });
    }

    return teamLeadQuery;
  }

  // 👷 NORMAL EMPLOYEE: STRICT participant-based visibility ONLY
  const employeeQuery = {
    $and: [participantFilter],
  };

  // For thread-based queries, verify access to the thread
  if (q.threadId) {
    employeeQuery.$and.push({ threadId: q.threadId });

    const threadAccess = await AssignmentMessage.findOne({
      threadId: q.threadId,
      $or: participantFilter.$or,
    });

    if (!threadAccess) {
      return { _id: null }; // No access to this thread
    }
  }

  // Handle scheduled messages specifically for employees
  const now = new Date();
  if (q.isScheduled === true && q.status === "scheduled") {
    return {
      $and: [
        participantFilter,
        { isScheduled: true },
        { status: "scheduled" },
        {
          $or: [
            { scheduledFor: { $lte: now } }, // Past scheduled messages
            { sender: me }, // Or their own future scheduled messages
          ],
        },
      ],
    };
  }

  // Handle normal messages with scheduled logic
  const baseConditions = {
    $or: [
      { isScheduled: { $ne: true } }, // Not scheduled
      { isScheduled: true, status: "sent" }, // Scheduled but sent
      {
        isScheduled: true,
        status: "scheduled",
        scheduledFor: { $lte: now }, // Scheduled but time has passed
      },
    ],
  };

  employeeQuery.$and.push(baseConditions);

  // Apply additional filters
  if (q.owner && isObjId(q.owner)) {
    employeeQuery.$and.push({ owner: q.owner });
  }
  if (q.client && isObjId(q.client)) {
    employeeQuery.$and.push({ client: q.client });
  }
  if (q.sender && isObjId(q.sender)) {
    employeeQuery.$and.push({ sender: q.sender });
  }
  if (
    q.status &&
    ["draft", "scheduled", "sent", "cancelled"].includes(q.status)
  ) {
    employeeQuery.$and.push({ status: q.status });
  }
  if (
    q.approvalStatus &&
    ["pending", "approved", "disapproved"].includes(q.approvalStatus)
  ) {
    employeeQuery.$and.push({ approvalStatus: q.approvalStatus });
  }
  if (q.isTrashed !== undefined) {
    employeeQuery.$and.push({ isTrashed: q.isTrashed });
  }
  if (q.isSpam !== undefined) {
    employeeQuery.$and.push({ isSpam: q.isSpam });
  }
  if (q.isScheduled !== undefined) {
    employeeQuery.$and.push({ isScheduled: q.isScheduled });
  }

  return employeeQuery;
}

// Helper function to get employees under supervision
async function getEmployeesUnderSupervision(ownerId, supervisorRole) {
  try {
    const employees = await Employee.find({
      owner: ownerId,
      ...(supervisorRole === "team_lead" && {
        $or: [
          { supervisionMode: "direct" },
          { supervisionMode: "needs_approval" },
        ],
      }),
    })
      .select("_id")
      .lean();

    return employees.map((emp) => emp._id);
  } catch (error) {
    console.error("Error getting employees under supervision:", error);
    return [];
  }
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
      .populate("attachments.uploadedBy");

    if (!populatedMessage) return;

    // 🔥 CRITICAL: Get ONLY the actual recipients from the database
    const actualRecipients = new Set();

    // Add sender
    const senderId = String(
      typeof populatedMessage.sender === "string"
        ? populatedMessage.sender
        : populatedMessage.sender?._id
    );
    if (senderId && senderId !== "undefined") {
      actualRecipients.add(senderId);
    }

    // 🔥 ONLY add receivers that are actually in the receiver array
    if (Array.isArray(populatedMessage.receiver)) {
      populatedMessage.receiver.forEach((receiver) => {
        const receiverId = String(
          typeof receiver === "string" ? receiver : receiver?._id
        );
        // 🔥 Only add if it's a valid receiver ID
        if (receiverId && receiverId !== "undefined") {
          actualRecipients.add(receiverId);
        }
      });
    }

    // 🔥 Emit ONLY to actual recipients
    actualRecipients.forEach((recipientId) => {
      if (recipientId) {
        io.to(`employee_${recipientId}`).emit(eventName, populatedMessage);
      }
    });
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

    // 🔥 CRITICAL: Only get actual participants, not thread participants
    const actualParticipants = new Set();

    // Add sender
    const senderId = String(populatedMessage.sender._id);
    actualParticipants.add(senderId);

    // Add ONLY the receivers from this specific message
    if (populatedMessage.receiver && Array.isArray(populatedMessage.receiver)) {
      populatedMessage.receiver.forEach((receiver) => {
        const receiverId = String(receiver._id);
        actualParticipants.add(receiverId);
      });
    }
    // Emit to actual participants only
    actualParticipants.forEach((participantId) => {
      io.to(`employee_${participantId}`).emit("assignment_message_updated", {
        message: populatedMessage,
        action: action,
        timestamp: new Date(),
      });
    });

    // 🔥 REMOVED: Thread-based and role-based broadcasting for sensitive operations
    if (action === "approved" || action === "disapproved") {
      // Keep approval/disapproval logic but ensure it's properly filtered
      const role =
        action === "approved" ? "assignment_managers" : "assignment_team_leads";
      io.to(role).emit(`assignment_message_${action}`, {
        message: populatedMessage,
        action: action,
        timestamp: new Date(),
      });
    }
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
      includeDirectMessages = "true",
      excludeHrPolicy = "false",
    } = req.query;

    const q = {};

    // Owner scope
    if (isObjId(owner)) q.owner = owner;
    else if (req.employee?.owner) q.owner = req.employee.owner;

    // Client scope
    if (isObjId(client)) {
      q.client = client;
    } else if (client === "none" || client === "direct") {
      q.client = { $exists: false };
    }

    // Status handling
    if (
      status &&
      ["draft", "scheduled", "sent", "cancelled"].includes(status)
    ) {
      q.status = status;
      if (status === "scheduled") {
        q.isScheduled = true;
      }
    } else {
      q.status = { $in: ["sent", "scheduled"] };
    }

    // Trash/Spam logic
    if (isTrashed === "true" || isTrashed === true) {
      q.isTrashed = true;
    } else if (isSpam === "true" || isSpam === true) {
      q.isSpam = true;
    } else {
      q.isTrashed = { $ne: true };
      q.isSpam = { $ne: true };
    }

    // 🔥 CRITICAL FIX: Review filter logic
    if (filter === "review") {
      // For review filter: show ONLY direct supervision pending messages
      q.approvalStatus = "pending";
      // Populate sender to check supervisionMode
      // This will be handled in the frontend filtering
    } else if (approvalStatus === "pending") {
      q.approvalStatus = "pending";
    } else {
      // For normal inbox, include ALL messages (including pending) for receivers
      // No approvalStatus filter for inbox
    }

    // HR Policy exclusion
    const shouldExcludeHrPolicy =
      excludeHrPolicy === "true" || excludeHrPolicy === true;
    if (shouldExcludeHrPolicy) {
      q.isHrPolicy = { $ne: true };
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

    // User-based filtering
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

    // Apply visibility rules
    const qFinal = await applyVisibility(q, req);

    // Validation
    const hasExplicitFilter =
      q.owner ||
      q.client !== undefined ||
      q.sender ||
      q.receiver ||
      q.$or ||
      q.status ||
      q.isScheduled !== undefined ||
      q.approvalStatus !== undefined ||
      q.isTrashed !== undefined ||
      q.isSpam !== undefined ||
      q.isHrPolicy !== undefined;

    if (!hasExplicitFilter) {
      return res.status(400).json({
        error:
          "Provide at least one scope: owner, client, sender, receiver, participant, status, approvalStatus, isTrashed, isSpam, isScheduled, or excludeHrPolicy",
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
          {
            path: "sender",
            select: "_id name companyEmail role supervisionMode",
          }, // 🔥 ADDED supervisionMode
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

    // 🔥 CRITICAL: Filter for review messages on backend for team leads
    let finalItems = items;
    if (filter === "review" && isTeamLead) {
      finalItems = items.filter(
        (item) =>
          item.sender?.supervisionMode === "direct" &&
          item.approvalStatus === "pending"
      );
    }

    // HR Policy logic (keep your existing HR policy code)
    let hrPolicyMessage = null;
    if (pageNum === 1 && !shouldExcludeHrPolicy && !isTrashed && !isSpam) {
      // ... your existing HR policy code
    }

    // Ensure receiver is always treated as array for consistency
    const normalizedItems = finalItems.map((item) => ({
      ...item,
      receiver: Array.isArray(item.receiver)
        ? item.receiver
        : [item.receiver].filter(Boolean),
      isDirectMessage: !item.client,
    }));

    res.json({
      items: normalizedItems,
      total: total,
      page: pageNum,
      pages: Math.ceil(total / lim),
      limit: lim,
      userRole: currentUserRole,
      isTeamLead: isTeamLead,
      messageTypes: {
        clientBased: normalizedItems.filter(
          (item) => item.client && !item.isVirtual
        ).length,
        directMessages: normalizedItems.filter(
          (item) => !item.client && !item.isVirtual
        ).length,
        totalMessages: normalizedItems.length,
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

// exports.createMessage = async function createMessage(req, res) {
//   try {
//     const {
//       owner: ownerBody,
//       client,
//       sender: senderBody,
//       receiver: receiverBody,
//       receivers: receiversBody,
//       subject,
//       note,
//       isScheduled: isScheduledBody,
//       scheduledFor,
//       replyTo,
//       isForward = false,
//       threadId: providedThreadId,
//       isFromClient,
//       isFromCompanyEmployee,
//       clientEmployeeName,
//       clientEmployeeEmail,
//       clientName,
//       clientEmployees: clientEmployeesBody,
//       companyEmployees: companyEmployeesBody,
//       cc: ccBody,
//     } = req.body;

//     const owner = ownerBody || req.employee?.owner;
//     const sender = senderBody || req.employee?._id;

//     if (!isObjId(owner) || !isObjId(sender)) {
//       return res.status(400).json({
//         error: "owner and sender are required (ObjectId strings)",
//       });
//     }

//     // Get sender role early to determine inheritance rules
//     const senderDoc = await Employee.findById(sender)
//       .select("_id role supervisor supervisionMode owner")
//       .lean();
//     const senderRole = normalizeRole(senderDoc?.role || "");

//     // Handle thread ID generation
//     let threadId = providedThreadId;
//     let originalMessage = null;
//     let threadMessages = [];

//     // If we have a threadId, fetch all messages in the thread to check context
//     if (providedThreadId || replyTo) {
//       try {
//         // First try to get the thread messages
//         if (providedThreadId) {
//           threadMessages = await AssignmentMessage.find({
//             threadId: providedThreadId,
//           })
//             .sort({ createdAt: -1 })
//             .limit(20)
//             .lean();
//         }

//         // If replyTo is provided, get that specific message
//         if (replyTo) {
//           originalMessage = await AssignmentMessage.findById(replyTo).lean();
//           if (originalMessage && !providedThreadId) {
//             threadId = originalMessage.threadId;
//             // Also get thread messages using the original message's threadId
//             threadMessages = await AssignmentMessage.find({
//               threadId: originalMessage.threadId,
//             })
//               .sort({ createdAt: -1 })
//               .limit(20)
//               .lean();
//           }
//         }
//       } catch (err) {
//         console.error("Error fetching thread messages:", err);
//       }
//     }

//     // 🔥🔥🔥 CRITICAL FIX: Only managers can have client/company employee context
//     // For non-managers, always set these fields to false/null regardless of request
//     let inheritedIsFromClient = false;
//     let inheritedIsFromCompanyEmployee = false;
//     let inheritedClientEmployeeName = null;
//     let inheritedClientEmployeeEmail = null;
//     let inheritedClientName = null;

//     // ONLY managers can have client/company employee context
//     if (senderRole === "manager") {
//       // Check if context is explicitly provided in request
//       if (isFromClient || isFromCompanyEmployee) {
//         inheritedIsFromClient = isFromClient || false;
//         inheritedIsFromCompanyEmployee = isFromCompanyEmployee || false;
//         inheritedClientEmployeeName = clientEmployeeName || null;
//         inheritedClientEmployeeEmail = clientEmployeeEmail || null;
//         inheritedClientName = clientName || null;
//       }
//       // Managers can also inherit from thread if not explicitly set
//       else if (threadMessages.length > 0) {
//         const threadWithCompanyEmployee = threadMessages.find(
//           (msg) => msg.isFromCompanyEmployee || msg.isFromClient
//         );

//         if (threadWithCompanyEmployee) {
//           inheritedIsFromClient = threadWithCompanyEmployee.isFromClient;
//           inheritedIsFromCompanyEmployee =
//             threadWithCompanyEmployee.isFromCompanyEmployee;
//           inheritedClientEmployeeName =
//             threadWithCompanyEmployee.clientEmployeeName;
//           inheritedClientEmployeeEmail =
//             threadWithCompanyEmployee.clientEmployeeEmail;
//           inheritedClientName = threadWithCompanyEmployee.clientName;
//         }
//       }
//     } else {
//       inheritedIsFromClient = false;
//       inheritedIsFromCompanyEmployee = false;
//       inheritedClientEmployeeName = null;
//       inheritedClientEmployeeEmail = null;
//       inheritedClientName = null;
//     }

//     // Generate thread ID if not provided
//     if (!threadId) {
//       if (originalMessage) {
//         threadId = getThreadIdForReply(originalMessage, subject, isForward);
//       } else if (client && isObjId(client)) {
//         threadId = generateThreadId(client, subject);
//       } else if (inheritedIsFromClient || inheritedIsFromCompanyEmployee) {
//         const normalizedSubject = (subject || "external_message")
//           .toLowerCase()
//           .replace(/[^a-z0-9]/g, "_")
//           .substring(0, 50);

//         if (inheritedClientEmployeeEmail) {
//           threadId = `external_${inheritedClientEmployeeEmail}_${normalizedSubject}_${Date.now()}`;
//         } else if (inheritedClientName) {
//           threadId = `external_${inheritedClientName}_${normalizedSubject}_${Date.now()}`;
//         } else {
//           threadId = `external_${normalizedSubject}_${Date.now()}`;
//         }
//       } else {
//         const participants = [
//           sender,
//           ...normalizeIds(receiverBody),
//           ...normalizeIds(receiversBody),
//         ]
//           .filter((id) => id !== String(sender))
//           .sort()
//           .join("_")
//           .substring(0, 100);

//         const normalizedSubject = (subject || "direct_message")
//           .toLowerCase()
//           .replace(/[^a-z0-9]/g, "_")
//           .substring(0, 50);

//         threadId = `direct_${participants}_${normalizedSubject}_${Date.now()}`;
//       }
//     }

//     // Start with explicitly specified receivers
//     let receivers = [];
//     if (receiverBody) receivers = receivers.concat(normalizeIds(receiverBody));
//     if (receiversBody)
//       receivers = receivers.concat(normalizeIds(receiversBody));

//     receivers = receivers.filter((id) => id !== String(sender));

//     // 🔥 MODIFIED: Check client-level supervision instead of employee-level
//     let approvalStatus;
//     let clientSupervisionMode = "direct"; // default

//     // Only check client supervision if client is specified
//     if (client && isObjId(client)) {
//       // Get client supervision mode from ClientInfo model
//       const clientDoc = await ClientInfo.findById(client)
//         .select("supervision")
//         .lean();

//       clientSupervisionMode = clientDoc?.supervision || "direct"; // default to direct

//       if (inheritedIsFromClient || inheritedIsFromCompanyEmployee) {
//         approvalStatus = "approved";
//       } else if (clientSupervisionMode === "needs_approval") {
//         // Messages for this client need approval
//         approvalStatus = "pending";
//       } else if (clientSupervisionMode === "direct") {
//         // Direct supervision - no approval needed
//         approvalStatus = "approved";
//       } else {
//         // Default to approved for any other mode
//         approvalStatus = "approved";
//       }
//     } else {
//       // Direct messages (no client) are always approved
//       approvalStatus = "approved";
//     }

//     let clientEmployees = [];
//     if (clientEmployeesBody) {
//       clientEmployees = normalizeIds(clientEmployeesBody);
//     } else if (companyEmployeesBody) {
//       clientEmployees = normalizeIds(companyEmployeesBody);
//     }

//     // 🔥 FIX: ONLY add client employees to receivers if sender is a manager
//     if (senderRole === "manager") {
//       clientEmployees.forEach((clientEmployeeId) => {
//         if (!receivers.includes(clientEmployeeId)) {
//           receivers.push(clientEmployeeId);
//         }
//       });
//     } else {
//       console.log(
//         `👤 ${senderRole} sending message - client employees NOT automatically added`
//       );
//     }

//     let assignedTeamMemberId = null;
//     if (client && isObjId(client)) {
//       const clientDoc = await ClientInfo.findById(client)
//         .populate("assignedTo", "_id role")
//         .lean();

//       if (clientDoc && clientDoc.assignedTo && clientDoc.assignedTo._id) {
//         assignedTeamMemberId = String(clientDoc.assignedTo._id);
//         if (
//           !receivers.includes(assignedTeamMemberId) &&
//           assignedTeamMemberId !== String(sender)
//         ) {
//           receivers.push(assignedTeamMemberId);
//         }
//       }
//     }

//     const { tls, managers } = await findTLsAndManagersByOwner(owner);

//     // 🔥 MODIFIED: Handle receiver logic based on CLIENT supervision mode
//     if (client && isObjId(client)) {
//       if (clientSupervisionMode === "needs_approval") {
//         // Needs approval: add TLs to receivers and set status to pending
//         if (tls.length > 0 && !receivers.some((r) => tls.includes(r))) {
//           receivers = [...receivers, ...tls.map((id) => String(id))];
//           approvalStatus = "pending";
//         }
//       } else if (clientSupervisionMode === "direct") {
//         // Direct supervision: add managers to receivers
//         if (
//           managers.length > 0 &&
//           !receivers.some((r) => managers.includes(r))
//         ) {
//           receivers = [...receivers, ...managers.map((id) => String(id))];
//           approvalStatus = "approved";
//         }
//       }
//       // For other supervision modes or if no TLs/managers found
//       // Keep the existing receiver list
//     }

//     // Handle sender role-based logic (managers, team leads) - these bypass client supervision
//     if (senderRole === "manager") {
//       approvalStatus = null; // Managers bypass approval
//       // Filter receivers based on explicit selection
//       receivers = receivers.filter((receiverId) => {
//         const isExplicitReceiver =
//           normalizeIds(receiverBody).includes(receiverId) ||
//           normalizeIds(receiversBody).includes(receiverId);
//         const isAssignedTeamMember = receiverId === assignedTeamMemberId;
//         const isClientEmployee = clientEmployees.includes(receiverId);

//         return isExplicitReceiver || isAssignedTeamMember || isClientEmployee;
//       });

//       // If manager is sending as company employee in a thread, include TLs
//       if (
//         (inheritedIsFromCompanyEmployee || inheritedIsFromClient) &&
//         tls.length > 0
//       ) {
//         const primaryTeamLead = tls[0];
//         if (!receivers.includes(primaryTeamLead)) {
//           receivers.push(primaryTeamLead);
//         }
//       }
//     } else if (senderRole === "team_lead") {
//       approvalStatus = null; // Team leads bypass approval
//     }

//     // 🔥 MODIFIED: Handle reply logic with CLIENT supervision
//     if (replyTo && originalMessage) {
//       if (client && isObjId(client)) {
//         // Get the client's supervision mode for the reply
//         const replyClientDoc = await ClientInfo.findById(client)
//           .select("supervision")
//           .lean();
//         const replyClientSupervision = replyClientDoc?.supervision || "direct";

//         if (replyClientSupervision === "needs_approval") {
//           if (tls.length > 0 && !receivers.some((r) => tls.includes(r))) {
//             receivers = [...receivers, ...tls];
//             approvalStatus = "pending";
//           }
//         }
//       }
//     }

//     // Ensure we have at least one receiver
//     if (receivers.length === 0) {
//       if (replyTo || providedThreadId) {
//         let threadParticipants = new Set();

//         if (replyTo && originalMessage) {
//           const originalSender = String(originalMessage.sender);
//           if (
//             originalSender !== String(sender) &&
//             !(
//               senderRole === "employee" &&
//               clientSupervisionMode === "needs_approval"
//             )
//           ) {
//             threadParticipants.add(originalSender);
//           }

//           if (Array.isArray(originalMessage.receiver)) {
//             originalMessage.receiver.forEach((receiverId) => {
//               const receiverStr = String(receiverId);
//               if (
//                 receiverStr !== String(sender) &&
//                 !(
//                   senderRole === "employee" &&
//                   clientSupervisionMode === "needs_approval"
//                 )
//               ) {
//                 threadParticipants.add(receiverStr);
//               }
//             });
//           }
//         }

//         if (
//           threadParticipants.size === 0 &&
//           providedThreadId &&
//           !(
//             senderRole === "employee" &&
//             clientSupervisionMode === "needs_approval"
//           )
//         ) {
//           const threadMessagesForParticipants = await AssignmentMessage.find({
//             threadId: providedThreadId,
//           }).limit(10);

//           threadMessagesForParticipants.forEach((msg) => {
//             const msgSender = String(msg.sender);
//             if (msgSender !== String(sender)) {
//               threadParticipants.add(msgSender);
//             }

//             if (Array.isArray(msg.receiver)) {
//               msg.receiver.forEach((receiverId) => {
//                 const receiverStr = String(receiverId);
//                 if (receiverStr !== String(sender)) {
//                   threadParticipants.add(receiverStr);
//                 }
//               });
//             }
//           });
//         }

//         if (threadParticipants.size > 0) {
//           receivers = Array.from(threadParticipants);
//         }
//       }

//       if (receivers.length === 0) {
//         if (
//           !client &&
//           !inheritedIsFromClient &&
//           !inheritedIsFromCompanyEmployee
//         ) {
//           return res.status(400).json({
//             error:
//               "For direct messages, you must specify at least one receiver",
//           });
//         }

//         // 🔥 MODIFIED: Use CLIENT supervision mode instead of employee supervision
//         if (senderRole === "employee") {
//           if (
//             client &&
//             isObjId(client) &&
//             clientSupervisionMode === "needs_approval"
//           ) {
//             // Needs approval: send to TLs
//             if (tls.length > 0) {
//               receivers = [...tls];
//               approvalStatus = "pending";
//             } else {
//               return res.status(400).json({
//                 error:
//                   "No team leads available for approval. Please specify at least one receiver for your message.",
//               });
//             }
//           } else if (
//             client &&
//             isObjId(client) &&
//             clientSupervisionMode === "direct"
//           ) {
//             // Direct supervision: send to managers
//             if (managers.length > 0) {
//               receivers = [...managers];
//               approvalStatus = "approved";
//             } else {
//               return res.status(400).json({
//                 error:
//                   "No managers available. Please specify at least one receiver for your message.",
//               });
//             }
//           } else {
//             // No client or other supervision mode
//             return res.status(400).json({
//               error: "Please specify at least one receiver for your message",
//             });
//           }
//         } else if (senderRole === "team_lead") {
//           return res.status(400).json({
//             error:
//               "Team leads must specify at least one receiver for their messages",
//           });
//         } else if (senderRole === "manager") {
//           return res.status(400).json({
//             error:
//               "Managers must specify at least one receiver for their messages",
//           });
//         } else {
//           return res.status(400).json({
//             error: "Please specify at least one receiver for your message",
//           });
//         }
//       }
//     }

//     // Remove duplicates and remove sender from receivers
//     receivers = Array.from(new Set(receivers.map((id) => String(id)))).filter(
//       (id) => id !== String(sender)
//     );

//     if (receivers.length === 0) {
//       return res.status(400).json({
//         error:
//           "No valid receivers found. Please specify at least one recipient.",
//       });
//     }

//     // Handle scheduling
//     const isScheduled = isScheduledBody === true || isScheduledBody === "true";
//     let status = "sent";
//     let scheduledAt = null;
//     let scheduledBy = null;
//     let sentAt = new Date();

//     if (isScheduled) {
//       const validation = validateScheduleTime(scheduledFor);
//       if (!validation.valid) {
//         return res.status(400).json({ error: validation.error });
//       }

//       status = "scheduled";
//       scheduledAt = new Date();
//       scheduledBy = sender;
//       sentAt = null;
//     }

//     // Process CC emails
//     let ccEmails = [];

//     if (ccBody) {
//       if (Array.isArray(ccBody)) {
//         ccEmails = ccBody
//           .filter((item) => {
//             if (typeof item === "string" && item.includes("@")) {
//               return true;
//             }
//             if (item && item.email && item.email.includes("@")) {
//               return true;
//             }
//             if (item && typeof item === "object" && item.email) {
//               return true;
//             }
//             return false;
//           })
//           .map((item) => {
//             if (typeof item === "string") {
//               return {
//                 email: item.trim().toLowerCase(),
//                 name: item.split("@")[0],
//               };
//             }
//             if (item && item.email) {
//               return {
//                 email: item.email.trim().toLowerCase(),
//                 name: item.name || item.email.split("@")[0],
//               };
//             }
//             return null;
//           })
//           .filter((item) => item !== null);
//       } else if (typeof ccBody === "string" && ccBody.includes("@")) {
//         ccEmails = [
//           {
//             email: ccBody.trim().toLowerCase(),
//             name: ccBody.split("@")[0],
//           },
//         ];
//       }
//     }

//     const msgData = {
//       owner,
//       sender,
//       receiver: receivers,
//       subject: subject || "",
//       note: note || "",
//       approvalStatus: approvalStatus,
//       isScheduled,
//       status,
//       scheduledFor: isScheduled ? new Date(scheduledFor) : undefined,
//       scheduledAt,
//       scheduledBy,
//       sentAt: !isScheduled ? new Date() : undefined,
//       threadId,
//       replyTo: replyTo || undefined,
//       // 🔥 CRITICAL: Only managers can have these fields
//       isFromClient: inheritedIsFromClient,
//       isFromCompanyEmployee: inheritedIsFromCompanyEmployee,
//       clientEmployeeName: inheritedClientEmployeeName,
//       clientEmployeeEmail: inheritedClientEmployeeEmail,
//       clientName: inheritedClientName,
//     };

//     // Add client if present
//     if (client && isObjId(client)) {
//       msgData.client = client;
//     }

//     // Add CC emails if present
//     if (ccEmails.length > 0) {
//       msgData.cc = ccEmails;
//     }

//     // Create the message
//     const msg = await AssignmentMessage.create(msgData);

//     const populated = await msg.populate([
//       { path: "owner", select: "_id name companyEmail" },
//       { path: "sender", select: "_id name companyEmail role" },
//       { path: "receiver", select: "_id name companyEmail role" },
//       { path: "client", select: "_id clientName assignedTo" },
//       { path: "scheduledBy", select: "_id name companyEmail" },
//     ]);

//     // Emit socket event
//     const io = getIO(req);
//     if (io && !isScheduled) {
//       await emitToAssignmentClients(io, msg, "new_assignment_message");
//     }

//     res.status(201).json(populated);
//   } catch (e) {
//     console.error("❌ Error in createMessage:", e);
//     if (e.name === "ValidationError") {
//       console.error("❌ Validation errors:", e.errors);
//       return res.status(400).json({
//         error: "Validation failed",
//         details: Object.values(e.errors).map((err) => err.message),
//       });
//     }
//     res.status(500).json({ error: "Failed to create assignment message" });
//   }
// };


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
      replyTo,
      isForward = false,
      threadId: providedThreadId,
      isFromClient,
      isFromCompanyEmployee,
      clientEmployeeName,
      clientEmployeeEmail,
      clientName,
      clientEmployees: clientEmployeesBody,
      companyEmployees: companyEmployeesBody,
      cc: ccBody,
    } = req.body;

    const owner = ownerBody || req.employee?.owner;
    const sender = senderBody || req.employee?._id;

    if (!isObjId(owner) || !isObjId(sender)) {
      return res.status(400).json({
        error: "owner and sender are required (ObjectId strings)",
      });
    }

    // Get sender role early to determine inheritance rules
    const senderDoc = await Employee.findById(sender)
      .select("_id role supervisor supervisionMode owner")
      .lean();
    const senderRole = normalizeRole(senderDoc?.role || "");

    // Handle thread ID generation
    let threadId = providedThreadId;
    let originalMessage = null;
    let threadMessages = [];

    // If we have a threadId, fetch all messages in the thread to check context
    if (providedThreadId || replyTo) {
      try {
        // First try to get the thread messages
        if (providedThreadId) {
          threadMessages = await AssignmentMessage.find({
            threadId: providedThreadId,
          })
            .sort({ createdAt: -1 })
            .limit(20)
            .lean();
        }

        // If replyTo is provided, get that specific message
        if (replyTo) {
          originalMessage = await AssignmentMessage.findById(replyTo).lean();
          if (originalMessage && !providedThreadId) {
            threadId = originalMessage.threadId;
            // Also get thread messages using the original message's threadId
            threadMessages = await AssignmentMessage.find({
              threadId: originalMessage.threadId,
            })
              .sort({ createdAt: -1 })
              .limit(20)
              .lean();
          }
        }
      } catch (err) {
        console.error("Error fetching thread messages:", err);
      }
    }

    // 🔥🔥🔥 CRITICAL FIX: Only managers can have client/company employee context
    // For non-managers, always set these fields to false/null regardless of request
    let inheritedIsFromClient = false;
    let inheritedIsFromCompanyEmployee = false;
    let inheritedClientEmployeeName = null;
    let inheritedClientEmployeeEmail = null;
    let inheritedClientName = null;

    // ONLY managers can have client/company employee context
    if (senderRole === "manager") {
      // Check if context is explicitly provided in request
      if (isFromClient || isFromCompanyEmployee) {
        inheritedIsFromClient = isFromClient || false;
        inheritedIsFromCompanyEmployee = isFromCompanyEmployee || false;
        inheritedClientEmployeeName = clientEmployeeName || null;
        inheritedClientEmployeeEmail = clientEmployeeEmail || null;
        inheritedClientName = clientName || null;
      }
      // Managers can also inherit from thread if not explicitly set
      else if (threadMessages.length > 0) {
        const threadWithCompanyEmployee = threadMessages.find(
          (msg) => msg.isFromCompanyEmployee || msg.isFromClient
        );

        if (threadWithCompanyEmployee) {
          inheritedIsFromClient = threadWithCompanyEmployee.isFromClient;
          inheritedIsFromCompanyEmployee =
            threadWithCompanyEmployee.isFromCompanyEmployee;
          inheritedClientEmployeeName =
            threadWithCompanyEmployee.clientEmployeeName;
          inheritedClientEmployeeEmail =
            threadWithCompanyEmployee.clientEmployeeEmail;
          inheritedClientName = threadWithCompanyEmployee.clientName;
        }
      }
    } else {
      inheritedIsFromClient = false;
      inheritedIsFromCompanyEmployee = false;
      inheritedClientEmployeeName = null;
      inheritedClientEmployeeEmail = null;
      inheritedClientName = null;
    }

    // Generate thread ID if not provided
    if (!threadId) {
      if (originalMessage) {
        threadId = getThreadIdForReply(originalMessage, subject, isForward);
      } else if (client && isObjId(client)) {
        threadId = generateThreadId(client, subject);
      } else if (inheritedIsFromClient || inheritedIsFromCompanyEmployee) {
        const normalizedSubject = (subject || "external_message")
          .toLowerCase()
          .replace(/[^a-z0-9]/g, "_")
          .substring(0, 50);

        if (inheritedClientEmployeeEmail) {
          threadId = `external_${inheritedClientEmployeeEmail}_${normalizedSubject}_${Date.now()}`;
        } else if (inheritedClientName) {
          threadId = `external_${inheritedClientName}_${normalizedSubject}_${Date.now()}`;
        } else {
          threadId = `external_${normalizedSubject}_${Date.now()}`;
        }
      } else {
        const participants = [
          sender,
          ...normalizeIds(receiverBody),
          ...normalizeIds(receiversBody),
        ]
          .filter((id) => id !== String(sender))
          .sort()
          .join("_")
          .substring(0, 100);

        const normalizedSubject = (subject || "direct_message")
          .toLowerCase()
          .replace(/[^a-z0-9]/g, "_")
          .substring(0, 50);

        threadId = `direct_${participants}_${normalizedSubject}_${Date.now()}`;
      }
    }

    // Start with explicitly specified receivers
    let receivers = [];
    if (receiverBody) receivers = receivers.concat(normalizeIds(receiverBody));
    if (receiversBody)
      receivers = receivers.concat(normalizeIds(receiversBody));

    receivers = receivers.filter((id) => id !== String(sender));

    // 🔥 MODIFIED: Check client-level supervision instead of employee-level
    let approvalStatus;
    let clientSupervisionMode = "direct"; // default

    // Only check client supervision if client is specified
    if (client && isObjId(client)) {
      // Get client supervision mode from ClientInfo model
      const clientDoc = await ClientInfo.findById(client)
        .select("supervision")
        .lean();

      clientSupervisionMode = clientDoc?.supervision || "direct"; // default to direct

      if (inheritedIsFromClient || inheritedIsFromCompanyEmployee) {
        approvalStatus = "approved";
      } else if (clientSupervisionMode === "needs_approval") {
        // Messages for this client need approval
        approvalStatus = "pending";
      } else if (clientSupervisionMode === "direct") {
        // Direct supervision - no approval needed
        approvalStatus = "approved";
      } else {
        // Default to approved for any other mode
        approvalStatus = "approved";
      }
    } else {
      // Direct messages (no client) - set approvalStatus to null
      approvalStatus = null;
    }

    let clientEmployees = [];
    if (clientEmployeesBody) {
      clientEmployees = normalizeIds(clientEmployeesBody);
    } else if (companyEmployeesBody) {
      clientEmployees = normalizeIds(companyEmployeesBody);
    }

    // 🔥 FIX: ONLY add client employees to receivers if sender is a manager
    if (senderRole === "manager") {
      clientEmployees.forEach((clientEmployeeId) => {
        if (!receivers.includes(clientEmployeeId)) {
          receivers.push(clientEmployeeId);
        }
      });
    } else {
      console.log(
        `👤 ${senderRole} sending message - client employees NOT automatically added`
      );
    }

    let assignedTeamMemberId = null;
    if (client && isObjId(client)) {
      const clientDoc = await ClientInfo.findById(client)
        .populate("assignedTo", "_id role")
        .lean();

      if (clientDoc && clientDoc.assignedTo && clientDoc.assignedTo._id) {
        assignedTeamMemberId = String(clientDoc.assignedTo._id);
        if (
          !receivers.includes(assignedTeamMemberId) &&
          assignedTeamMemberId !== String(sender)
        ) {
          receivers.push(assignedTeamMemberId);
        }
      }
    }

    const { tls, managers } = await findTLsAndManagersByOwner(owner);

    // 🔥 MODIFIED: Handle receiver logic based on CLIENT supervision mode
    if (client && isObjId(client)) {
      if (clientSupervisionMode === "needs_approval") {
        // Needs approval: add TLs to receivers and set status to pending
        if (tls.length > 0 && !receivers.some((r) => tls.includes(r))) {
          receivers = [...receivers, ...tls.map((id) => String(id))];
          approvalStatus = "pending";
        }
      } else if (clientSupervisionMode === "direct") {
        // Direct supervision: add managers to receivers
        if (
          managers.length > 0 &&
          !receivers.some((r) => managers.includes(r))
        ) {
          receivers = [...receivers, ...managers.map((id) => String(id))];
          // Keep approvalStatus as already set (should be "approved")
        }
      }
      // For other supervision modes or if no TLs/managers found
      // Keep the existing receiver list
    }

    // Handle sender role-based logic (managers, team leads) - these bypass client supervision
    if (senderRole === "manager") {
      approvalStatus = null; // Managers bypass approval - set to null
      // Filter receivers based on explicit selection
      receivers = receivers.filter((receiverId) => {
        const isExplicitReceiver =
          normalizeIds(receiverBody).includes(receiverId) ||
          normalizeIds(receiversBody).includes(receiverId);
        const isAssignedTeamMember = receiverId === assignedTeamMemberId;
        const isClientEmployee = clientEmployees.includes(receiverId);

        return isExplicitReceiver || isAssignedTeamMember || isClientEmployee;
      });

      // If manager is sending as company employee in a thread, include TLs
      if (
        (inheritedIsFromCompanyEmployee || inheritedIsFromClient) &&
        tls.length > 0
      ) {
        const primaryTeamLead = tls[0];
        if (!receivers.includes(primaryTeamLead)) {
          receivers.push(primaryTeamLead);
        }
      }
    } else if (senderRole === "team_lead") {
      approvalStatus = null; // Team leads bypass approval - set to null
    }

    // 🔥 MODIFIED: Handle reply logic with CLIENT supervision
    if (replyTo && originalMessage) {
      if (client && isObjId(client)) {
        // Get the client's supervision mode for the reply
        const replyClientDoc = await ClientInfo.findById(client)
          .select("supervision")
          .lean();
        const replyClientSupervision = replyClientDoc?.supervision || "direct";

        if (replyClientSupervision === "needs_approval") {
          if (tls.length > 0 && !receivers.some((r) => tls.includes(r))) {
            receivers = [...receivers, ...tls];
            approvalStatus = "pending";
          }
        }
      }
    }

    // Ensure we have at least one receiver
    if (receivers.length === 0) {
      if (replyTo || providedThreadId) {
        let threadParticipants = new Set();

        if (replyTo && originalMessage) {
          const originalSender = String(originalMessage.sender);
          if (
            originalSender !== String(sender) &&
            !(
              senderRole === "employee" &&
              clientSupervisionMode === "needs_approval"
            )
          ) {
            threadParticipants.add(originalSender);
          }

          if (Array.isArray(originalMessage.receiver)) {
            originalMessage.receiver.forEach((receiverId) => {
              const receiverStr = String(receiverId);
              if (
                receiverStr !== String(sender) &&
                !(
                  senderRole === "employee" &&
                  clientSupervisionMode === "needs_approval"
                )
              ) {
                threadParticipants.add(receiverStr);
              }
            });
          }
        }

        if (
          threadParticipants.size === 0 &&
          providedThreadId &&
          !(
            senderRole === "employee" &&
            clientSupervisionMode === "needs_approval"
          )
        ) {
          const threadMessagesForParticipants = await AssignmentMessage.find({
            threadId: providedThreadId,
          }).limit(10);

          threadMessagesForParticipants.forEach((msg) => {
            const msgSender = String(msg.sender);
            if (msgSender !== String(sender)) {
              threadParticipants.add(msgSender);
            }

            if (Array.isArray(msg.receiver)) {
              msg.receiver.forEach((receiverId) => {
                const receiverStr = String(receiverId);
                if (receiverStr !== String(sender)) {
                  threadParticipants.add(receiverStr);
                }
              });
            }
          });
        }

        if (threadParticipants.size > 0) {
          receivers = Array.from(threadParticipants);
        }
      }

      if (receivers.length === 0) {
        if (
          !client &&
          !inheritedIsFromClient &&
          !inheritedIsFromCompanyEmployee
        ) {
          return res.status(400).json({
            error:
              "For direct messages, you must specify at least one receiver",
          });
        }

        // 🔥 MODIFIED: Use CLIENT supervision mode instead of employee supervision
        if (senderRole === "employee") {
          if (
            client &&
            isObjId(client) &&
            clientSupervisionMode === "needs_approval"
          ) {
            // Needs approval: send to TLs
            if (tls.length > 0) {
              receivers = [...tls];
              approvalStatus = "pending";
            } else {
              return res.status(400).json({
                error:
                  "No team leads available for approval. Please specify at least one receiver for your message.",
              });
            }
          } else if (
            client &&
            isObjId(client) &&
            clientSupervisionMode === "direct"
          ) {
            // Direct supervision: send to managers
            if (managers.length > 0) {
              receivers = [...managers];
              approvalStatus = "approved";
            } else {
              return res.status(400).json({
                error:
                  "No managers available. Please specify at least one receiver for your message.",
              });
            }
          } else {
            // No client or other supervision mode
            return res.status(400).json({
              error: "Please specify at least one receiver for your message",
            });
          }
        } else if (senderRole === "team_lead") {
          return res.status(400).json({
            error:
              "Team leads must specify at least one receiver for their messages",
          });
        } else if (senderRole === "manager") {
          return res.status(400).json({
            error:
              "Managers must specify at least one receiver for their messages",
          });
        } else {
          return res.status(400).json({
            error: "Please specify at least one receiver for your message",
          });
        }
      }
    }

    // Remove duplicates and remove sender from receivers
    receivers = Array.from(new Set(receivers.map((id) => String(id)))).filter(
      (id) => id !== String(sender)
    );

    if (receivers.length === 0) {
      return res.status(400).json({
        error:
          "No valid receivers found. Please specify at least one recipient.",
      });
    }

    // Handle scheduling
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

    // Process CC emails
    let ccEmails = [];

    if (ccBody) {
      if (Array.isArray(ccBody)) {
        ccEmails = ccBody
          .filter((item) => {
            if (typeof item === "string" && item.includes("@")) {
              return true;
            }
            if (item && item.email && item.email.includes("@")) {
              return true;
            }
            if (item && typeof item === "object" && item.email) {
              return true;
            }
            return false;
          })
          .map((item) => {
            if (typeof item === "string") {
              return {
                email: item.trim().toLowerCase(),
                name: item.split("@")[0],
              };
            }
            if (item && item.email) {
              return {
                email: item.email.trim().toLowerCase(),
                name: item.name || item.email.split("@")[0],
              };
            }
            return null;
          })
          .filter((item) => item !== null);
      } else if (typeof ccBody === "string" && ccBody.includes("@")) {
        ccEmails = [
          {
            email: ccBody.trim().toLowerCase(),
            name: ccBody.split("@")[0],
          },
        ];
      }
    }

    const msgData = {
      owner,
      sender,
      receiver: receivers,
      subject: subject || "",
      note: note || "",
      approvalStatus: approvalStatus, // This will be null for non-client messages
      isScheduled,
      status,
      scheduledFor: isScheduled ? new Date(scheduledFor) : undefined,
      scheduledAt,
      scheduledBy,
      sentAt: !isScheduled ? new Date() : undefined,
      threadId,
      replyTo: replyTo || undefined,
      // 🔥 CRITICAL: Only managers can have these fields
      isFromClient: inheritedIsFromClient,
      isFromCompanyEmployee: inheritedIsFromCompanyEmployee,
      clientEmployeeName: inheritedClientEmployeeName,
      clientEmployeeEmail: inheritedClientEmployeeEmail,
      clientName: inheritedClientName,
    };

    // Add client if present
    if (client && isObjId(client)) {
      msgData.client = client;
    }

    // Add CC emails if present
    if (ccEmails.length > 0) {
      msgData.cc = ccEmails;
    }

    // Create the message
    const msg = await AssignmentMessage.create(msgData);

    const populated = await msg.populate([
      { path: "owner", select: "_id name companyEmail" },
      { path: "sender", select: "_id name companyEmail role" },
      { path: "receiver", select: "_id name companyEmail role" },
      { path: "client", select: "_id clientName assignedTo" },
      { path: "scheduledBy", select: "_id name companyEmail" },
    ]);

    // Emit socket event
    const io = getIO(req);
    if (io && !isScheduled) {
      await emitToAssignmentClients(io, msg, "new_assignment_message");
    }

    res.status(201).json(populated);
  } catch (e) {
    console.error("❌ Error in createMessage:", e);
    if (e.name === "ValidationError") {
      console.error("❌ Validation errors:", e.errors);
      return res.status(400).json({
        error: "Validation failed",
        details: Object.values(e.errors).map((err) => err.message),
      });
    }
    res.status(500).json({ error: "Failed to create assignment message" });
  }
};
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

        // 🔥 FIXED: Use targeted emission instead of broadcast
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

    // Prevent double approval
    if (msg.approvalStatus === "approved") {
      return res.status(400).json({ error: "Message already approved" });
    }

    // Get managers for the owner
    const { managers } = await findTLsAndManagersByOwner(msg.owner);
    if (managers.length === 0) {
      return res.status(400).json({ error: "No managers found to assign to" });
    }

    // Update receiver: Add managers, keep existing receivers, avoid duplicates
    const currentReceivers = Array.isArray(msg.receiver)
      ? msg.receiver.map((r) => String(r))
      : [];
    const newReceivers = Array.from(
      new Set([...currentReceivers, ...managers])
    ).filter((id) => id !== String(msg.sender));

    // Update the ORIGINAL message
    msg.receiver = newReceivers;
    msg.approvalStatus = "approved";
    msg.approvedAt = new Date();
    msg.approvedBy = req.employee._id;

    await msg.save();

    // Populate updated message
    const populated = await msg.populate([
      { path: "owner", select: "_id name companyEmail" },
      { path: "sender", select: "_id name companyEmail role" },
      { path: "receiver", select: "_id name companyEmail role" },
      { path: "client", select: "_id clientName" },
      { path: "approvedBy", select: "_id name companyEmail" },
    ]);

    // 🔥 ENHANCED REAL-TIME EMISSION - FIXED FOR MANAGERS
    const io = getIO(req);
    if (io) {
      io.to("assignment_managers").emit("assignment_message_approved", {
        messageId: populated._id,
        approvalStatus: "approved",
        message: populated,
        approvedBy: {
          _id: req.employee._id,
          name: req.employee.name,
          companyEmail: req.employee.companyEmail,
        },
        timestamp: new Date(),
        action: "approved", // Add this for consistency
        isNewMessage: true, // Indicate this is a new message for managers
      });

      // 2. Emit to all individual participants (existing logic)
      const allParticipants = new Set();

      // Add sender
      const senderId = String(populated.sender._id);
      allParticipants.add(senderId);

      // Add original receivers
      currentReceivers.forEach((receiverId) => {
        allParticipants.add(String(receiverId));
      });

      // Add new receivers (managers)
      managers.forEach((managerId) => {
        allParticipants.add(String(managerId));
      });

      // Add current user (team lead)
      allParticipants.add(String(req.employee._id));

      // Emit to all individual participants
      allParticipants.forEach((participantId) => {
        io.to(`employee_${participantId}`).emit("assignment_message_approved", {
          messageId: populated._id,
          approvalStatus: "approved",
          message: populated,
          approvedBy: {
            _id: req.employee._id,
            name: req.employee.name,
            companyEmail: req.employee.companyEmail,
          },
          timestamp: new Date(),
        });
      });

      // 3. Emit general update for compatibility
      allParticipants.forEach((participantId) => {
        io.to(`employee_${participantId}`).emit("assignment_message_updated", {
          message: populated,
          action: "approved",
          timestamp: new Date(),
        });
      });

      // 4. Emit to team leads room
      io.to("assignment_team_leads").emit("assignment_message_approved", {
        messageId: populated._id,
        approvalStatus: "approved",
        message: populated,
        approvedBy: {
          _id: req.employee._id,
          name: req.employee.name,
          companyEmail: req.employee.companyEmail,
        },
        timestamp: new Date(),
      });

      // 5. Emit to thread room if exists
      if (populated.threadId) {
        io.to(`thread_${populated.threadId}`).emit(
          "assignment_message_approved",
          {
            messageId: populated._id,
            approvalStatus: "approved",
            message: populated,
            approvedBy: {
              _id: req.employee._id,
              name: req.employee.name,
              companyEmail: req.employee.companyEmail,
            },
            timestamp: new Date(),
          }
        );
      }
    }

    return res.json({
      success: true,
      message: "Message approved and assigned to manager(s)",
      data: populated,
      managersAdded: managers,
    });
  } catch (e) {
    console.error("Error in approveMessage:", e);
    res.status(500).json({ error: "Failed to approve message" });
  }
};

exports.disapproveMessage = async function disapproveMessage(req, res) {
  try {
    const { id } = req.params;

    // ✅ FIX: Safely handle optional disapprovalNote
    const disapprovalNote = req.body?.disapprovalNote || null;

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
    if (disapprovalNote && disapprovalNote.trim() !== "") {
      msg.disapprovalNote = disapprovalNote.trim();
    } else {
      // Optional: Set a default note or leave it undefined
      msg.disapprovalNote = "Message requires revisions before resubmission.";
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

    // 🔥 FIXED: Emit specific disapproval event
    const io = getIO(req);
    if (io) {
      // Get all participants
      const allParticipants = new Set();

      const senderId = String(populated.sender._id);
      allParticipants.add(senderId);

      if (populated.receiver && Array.isArray(populated.receiver)) {
        populated.receiver.forEach((receiver) => {
          const receiverId = String(receiver._id);
          allParticipants.add(receiverId);
        });
      }

      allParticipants.add(String(req.employee._id));

      // Emit to all participants
      allParticipants.forEach((participantId) => {
        io.to(`employee_${participantId}`).emit(
          "assignment_message_disapproved",
          {
            messageId: populated._id,
            approvalStatus: "disapproved",
            message: populated,
            disapprovedBy: {
              _id: req.employee._id,
              name: req.employee.name,
              companyEmail: req.employee.companyEmail,
            },
            timestamp: new Date(),
            disapprovalNote: msg.disapprovalNote, // Include the note in the emission
          }
        );
      });

      await emitMessageUpdate(io, msg, "disapproved");
    }

    res.json({
      success: true,
      message: "Message disapproved successfully",
      data: populated,
      disapprovalNote: msg.disapprovalNote,
    });
  } catch (e) {
    console.error("Error in disapproveMessage:", e);
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
// In your createDraft function, add this before saving:
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

    // Validate required fields
    if (!isObjId(owner) || !isObjId(sender)) {
      return res.status(400).json({
        error: "owner and sender are required (ObjectId strings)",
      });
    }

    let receivers = [];
    if (receiverBody) receivers = receivers.concat(normalizeIds(receiverBody));
    if (receiversBody)
      receivers = receivers.concat(normalizeIds(receiversBody));

    // Remove sender from receivers and remove duplicates
    receivers = Array.from(new Set(receivers.map((id) => String(id)))).filter(
      (id) => id !== String(sender)
    );

    // Ensure at least one receiver
    if (receivers.length === 0) {
      return res.status(400).json({
        error: "At least one receiver is required to save a draft",
      });
    }

    const draftData = {
      owner,
      sender,
      receiver: receivers,
      subject: subject || "Draft",
      note: note || "",
      status: "draft",
      isScheduled: false,
      // Only include client if provided and valid
      ...(client && isObjId(client) && { client }),
    };

    // 🔥 FIXED: Generate threadId manually to avoid model middleware issues
    if (!draftData.threadId) {
      if (client && isObjId(client)) {
        // Client-based thread
        const normalizedSubject = (subject || "draft")
          .toLowerCase()
          .replace(/[^a-z0-9]/g, "_")
          .substring(0, 50);
        draftData.threadId = `thread_${client}_${normalizedSubject}_${Date.now()}`;
      } else {
        // Direct message thread
        const participants = [String(sender), ...receivers]
          .sort()
          .join("_")
          .substring(0, 100);

        const normalizedSubject = (subject || "direct_draft")
          .toLowerCase()
          .replace(/[^a-z0-9]/g, "_")
          .substring(0, 50);

        draftData.threadId = `direct_${participants}_${normalizedSubject}_${Date.now()}`;
      }
    }

    const draft = await AssignmentMessage.create(draftData);

    const populated = await draft.populate([
      { path: "owner", select: "_id name companyEmail" },
      { path: "sender", select: "_id name companyEmail role" },
      { path: "receiver", select: "_id name companyEmail role" },
      ...(client && isObjId(client)
        ? [{ path: "client", select: "_id clientName" }]
        : []),
    ]);

    res.status(201).json({
      success: true,
      message: "Draft saved successfully",
      data: populated,
    });
  } catch (e) {
    console.error("Error in createDraft:", e);
    if (e.name === "ValidationError") {
      return res.status(400).json({
        error: "Validation failed",
        details: Object.values(e.errors).map((err) => err.message),
      });
    }
    res.status(500).json({ error: "Failed to create draft" });
  }
};

// PATCH /api/assignment-messages/:id - Update draft (FIXED VERSION)
exports.updateMessage = async function updateMessage(req, res) {
  try {
    const {
      subject,
      note,
      receiver: receiverBody,
      receivers: receiversBody,
    } = req.body;
    const msg = await AssignmentMessage.findById(req.params.id);

    if (!msg) return res.status(404).json({ error: "Message not found" });

    // Check if user has permission to update this message
    if (String(msg.sender) !== String(req.employee._id)) {
      return res.status(403).json({
        error: "You can only update your own messages",
      });
    }

    // Update fields if provided
    if (typeof subject === "string") msg.subject = subject;
    if (typeof note === "string") msg.note = note;

    // Handle receiver updates for drafts
    if (receiverBody || receiversBody) {
      let receivers = [];
      if (receiverBody)
        receivers = receivers.concat(normalizeIds(receiverBody));
      if (receiversBody)
        receivers = receivers.concat(normalizeIds(receiversBody));

      receivers = Array.from(new Set(receivers.map((id) => String(id)))).filter(
        (id) => id !== String(msg.sender)
      );

      // 🔥 CRITICAL: Validate receivers for drafts
      if (msg.status === "draft" && receivers.length === 0) {
        return res.status(400).json({
          error: "At least one receiver is required to save a draft",
        });
      }

      msg.receiver = receivers;
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

    // EMIT REAL-TIME EVENT
    const io = getIO(req);
    if (io) {
      await emitMessageUpdate(io, msg, "updated");
    }

    res.json({
      success: true,
      message: "Draft updated successfully",
      data: populated,
    });
  } catch (e) {
    console.error("Error in updateMessage:", e);
    if (e.name === "ValidationError") {
      return res.status(400).json({
        error: "Validation failed",
        details: Object.values(e.errors).map((err) => err.message),
      });
    }
    res.status(500).json({ error: "Failed to update message" });
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

    // 🔥 FIXED: Only emit for immediate sends, not scheduled
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

    // Initialize variables with defaults
    let subject, note;
    let removedAttachments = [];
    let files = [];

    // Safely get request body data
    const requestBody = req.body || {};

    // Try to parse JSON if request body is a string (can happen with FormData)
    let parsedBody = requestBody;
    if (typeof requestBody === "string" && requestBody.trim().startsWith("{")) {
      try {
        parsedBody = JSON.parse(requestBody);
      } catch (e) {
        console.error("Failed to parse JSON body:", e);
        parsedBody = {};
      }
    }

    // Extract subject and note with fallbacks
    subject = parsedBody.subject || parsedBody.Subject || "";
    note = parsedBody.note || parsedBody.Note || "";

    // Handle removed attachments
    if (parsedBody.removedAttachments || parsedBody.removedattachments) {
      const removedAttachmentsRaw =
        parsedBody.removedAttachments || parsedBody.removedattachments;
      try {
        if (typeof removedAttachmentsRaw === "string") {
          if (removedAttachmentsRaw.trim().startsWith("[")) {
            removedAttachments = JSON.parse(removedAttachmentsRaw);
          } else {
            removedAttachments = [removedAttachmentsRaw].filter(Boolean);
          }
        } else if (Array.isArray(removedAttachmentsRaw)) {
          removedAttachments = removedAttachmentsRaw;
        } else if (removedAttachmentsRaw) {
          removedAttachments = [removedAttachmentsRaw].filter(Boolean);
        }
      } catch (e) {
        console.error("Error parsing removedAttachments:", e);
        removedAttachments = [];
      }
    }

    // Handle files from FormData
    if (req.files) {
      // Handle different file upload configurations
      if (Array.isArray(req.files)) {
        files = req.files;
      } else if (req.files.files && Array.isArray(req.files.files)) {
        files = req.files.files;
      } else if (
        req.files.attachments &&
        Array.isArray(req.files.attachments)
      ) {
        files = req.files.attachments;
      } else if (typeof req.files === "object") {
        // If it's an object with file objects
        files = Object.values(req.files).flat();
      }
    }

    // Validation - check if id is valid
    if (!id || id.trim() === "") {
      return res.status(400).json({
        error: "Message ID is required and must not be empty",
      });
    }

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        error: "Invalid message ID format. Must be a valid MongoDB ObjectId",
      });
    }

    // Find the message first to check its current status
    const msg = await AssignmentMessage.findById(id);
    if (!msg) {
      return res.status(404).json({
        error: "Message not found",
        messageId: id,
      });
    }

    // Check if message is disapproved
    if (msg.approvalStatus !== "disapproved") {
      return res.status(400).json({
        error: "Only disapproved messages can be edited for resubmission",
        currentStatus: msg.approvalStatus,
        allowedStatus: "disapproved",
      });
    }

    // Check permissions
    const currentUserId = req.employee?._id;
    const messageSenderId = String(msg.sender);

    if (!currentUserId) {
      return res.status(401).json({
        error: "Authentication required. No employee ID found.",
      });
    }

    const isSender = messageSenderId === String(currentUserId);
    const userRole = req.employee?.role?.toLowerCase() || "";
    const isTeamLead = userRole.includes("team") && userRole.includes("lead");
    const isManager = userRole.includes("manager");

    // Allow sender or team leads to edit
    if (!isSender && !isTeamLead && !isManager) {
      return res.status(403).json({
        error: "You don't have permission to edit this message",
        messageOwner: messageSenderId,
        currentUser: currentUserId,
        userRole: req.employee?.role || "unknown",
        allowedRoles: ["sender", "team_lead", "manager"],
      });
    }

    // Check if any changes are provided
    const hasSubjectChange =
      subject !== undefined &&
      subject !== null &&
      String(subject).trim() !== "";
    const hasNoteChange =
      note !== undefined && note !== null && String(note).trim() !== "";
    const hasFileChanges = files.length > 0 || removedAttachments.length > 0;

    if (!hasSubjectChange && !hasNoteChange && !hasFileChanges) {
      return res.status(400).json({
        error: "No changes provided",
        instructions:
          "Please update at least one of: subject, note, or attachments.",
        currentSubject: msg.subject || "No subject",
        currentNoteLength: msg.note?.length || 0,
        currentAttachmentsCount: msg.attachments?.length || 0,
      });
    }

    // Prepare update data - keep existing values if not provided
    const updateData = {
      approvalStatus: "pending",
      updatedAt: new Date(),
      resubmittedAt: new Date(),
      lastEditedBy: currentUserId,
      lastEditedAt: new Date(),
    };

    // Only update subject if provided and different
    if (hasSubjectChange) {
      const trimmedSubject = String(subject).trim();
      if (trimmedSubject !== msg.subject) {
        updateData.subject = trimmedSubject;
      }
    } else {
      // Keep existing subject
      updateData.subject = msg.subject || "";
    }

    // Only update note if provided and different
    if (hasNoteChange) {
      const trimmedNote = String(note).trim();
      if (trimmedNote !== msg.note) {
        updateData.note = trimmedNote;
      }
    } else {
      // Keep existing note
      updateData.note = msg.note || "";
    }
    // Apply basic updates first
    const updatedMsg = await AssignmentMessage.findByIdAndUpdate(
      id,
      { $set: updateData },
      { new: true, runValidators: true }
    );

    if (!updatedMsg) {
      throw new Error(`Failed to update message ${id} in database`);
    }

    // Handle removed attachments
    if (removedAttachments.length > 0) {
      updatedMsg.attachments = updatedMsg.attachments.filter(
        (attachment) => !removedAttachments.includes(attachment._id.toString())
      );
    }

    // Handle new file uploads
    if (files.length > 0) {
      const newAttachments = files.map((f) => ({
        filename: path.basename(f.filename || f.originalname),
        originalName: f.originalname || f.filename || "unnamed_file",
        mimetype: f.mimetype || "application/octet-stream",
        size: f.size || 0,
        url: buildPublicUrl(req, f.filename || f.originalname),
        uploadedAt: new Date(),
        uploadedBy: currentUserId,
      }));

      updatedMsg.attachments.push(...newAttachments);
    }

    // Save the updated message with attachments
    await updatedMsg.save();
    // Populate the updated message
    const populated = await AssignmentMessage.findById(updatedMsg._id)
      .populate([
        { path: "owner", select: "_id name companyEmail" },
        { path: "sender", select: "_id name companyEmail role" },
        { path: "receiver", select: "_id name companyEmail role" },
        { path: "client", select: "_id clientName" },
        { path: "attachments.uploadedBy", select: "_id name companyEmail" },
        {
          path: "lastEditedBy",
          select: "_id name companyEmail role",
          model: "Employee",
        },
      ])
      .lean();

    if (!populated) {
      throw new Error("Failed to populate updated message data");
    }

    // Ensure lastEditedBy has proper structure
    if (populated.lastEditedBy && typeof populated.lastEditedBy === "object") {
      populated.lastEditedBy = {
        _id: populated.lastEditedBy._id,
        name: populated.lastEditedBy.name || "Unknown User",
        companyEmail:
          populated.lastEditedBy.companyEmail || "unknown@company.com",
        role: populated.lastEditedBy.role || "employee",
      };
    } else {
      populated.lastEditedBy = {
        _id: currentUserId,
        name: req.employee.name || "Unknown User",
        companyEmail: req.employee.companyEmail || "unknown@company.com",
        role: req.employee.role || "employee",
      };
    }

    // 🔥 Real-time emission
    try {
      const io = getIO(req);
      if (io) {
        // Emit to all participants
        const allParticipants = new Set();

        // Add sender
        if (populated.sender && populated.sender._id) {
          allParticipants.add(String(populated.sender._id));
        }

        // Add receivers
        if (populated.receiver && Array.isArray(populated.receiver)) {
          populated.receiver.forEach((receiver) => {
            if (receiver && receiver._id) {
              allParticipants.add(String(receiver._id));
            }
          });
        }

        // Add the editor
        allParticipants.add(String(currentUserId));

        // Emit resubmission event
        const resubmitEvent = {
          message: populated,
          action: "resubmitted",
          resubmittedBy: {
            _id: currentUserId,
            name: req.employee.name,
            companyEmail: req.employee.companyEmail,
            role: req.employee.role,
          },
          timestamp: new Date(),
        };

        allParticipants.forEach((participantId) => {
          io.to(`employee_${participantId}`).emit(
            "assignment_message_resubmitted",
            resubmitEvent
          );
        });

        // Special notification to team leads
        io.to("assignment_team_leads").emit(
          "assignment_message_resubmitted",
          resubmitEvent
        );
      }
    } catch (socketError) {
      console.error("❌ Socket.io event error:", socketError);
      // Don't fail the request if socket fails
    }

    res.json({
      success: true,
      message: "Disapproved message edited and submitted for review",
      data: populated,
      changes: {
        subjectChanged: hasSubjectChange,
        noteChanged: hasNoteChange,
        filesAdded: files.length,
        attachmentsRemoved: removedAttachments.length,
      },
      timestamp: new Date(),
    });
  } catch (e) {
    console.error("❌ Error in editDisapprovedMessage:", e);
    console.error("❌ Error stack:", e.stack);

    // More specific error responses
    if (e.name === "ValidationError") {
      return res.status(400).json({
        error: "Validation failed",
        details: Object.values(e.errors).map((err) => err.message),
      });
    }

    if (e.name === "CastError") {
      return res.status(400).json({
        error: "Invalid data format",
        details: e.message,
      });
    }

    if (e.code === 11000) {
      return res.status(400).json({
        error: "Duplicate entry found",
        details: e.message,
      });
    }

    res.status(500).json({
      error: "Failed to edit disapproved message",
      details: process.env.NODE_ENV === "development" ? e.message : undefined,
      timestamp: new Date(),
    });
  }
};
// GET /api/assignment-messages/review
exports.getReviewMessages = async function getReviewMessages(req, res) {
  try {
    const { page = 1, limit = 10 } = req.query;
    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const lim = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 50);

    // Fetch all messages with pagination
    const [allMsgs, total] = await Promise.all([
      AssignmentMessage.find()
        .sort({ createdAt: -1 }) // Changed to -1 for newest first
        .skip((pageNum - 1) * lim)
        .limit(lim)
        .populate([
          { path: "sender", select: "name supervisionMode" },
          { path: "receiver", select: "name companyEmail role" },
          { path: "client", select: "_id clientName" },
          { path: "attachments.uploadedBy", select: "name companyEmail" },
        ])
        .lean(),
      AssignmentMessage.countDocuments(), // Get total count for pagination
    ]);

    // Filter for direct supervision messages
    const directMsgs = allMsgs.filter(
      (m) => m.sender && m.sender.supervisionMode === "direct"
    );

    res.json({
      items: directMsgs,
      total: total, // ✅ Total count from database
      page: pageNum,
      pages: Math.ceil(total / lim), // ✅ Pagination metadata
      limit: lim,
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
    const { threadId } = req.params; // Changed from clientId to threadId
    const userId = req.employee._id.toString();

    if (!threadId) {
      return res.status(400).json({ error: "Valid thread ID is required" });
    }

    // Find all messages for this thread where user is involved
    const threadMessages = await AssignmentMessage.find({
      threadId: threadId, // Changed from client to threadId
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
          threadId: threadId, // Changed from clientId to threadId
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

exports.restoreThreadFromTrash = async function restoreThreadFromTrash(
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
        .json({ error: "No trashed thread found with this thread ID" });
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
          threadId: threadId, // Changed from clientId to threadId
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
    let { limit = 50, page = 1 } = req.query;

    if (!isObjId(clientId)) {
      return res.status(400).json({ error: "Valid client ID is required" });
    }

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);

    // Apply visibility rules
    const qFinal = await applyVisibility({ client: clientId }, req);

    // Aggregate threads and return both paginated data and total count using $facet
    const pipeline = [
      { $match: qFinal },
      // Group messages into threads, keeping the latest message
      {
        $group: {
          _id: "$threadId",
          latestMessage: { $first: "$$ROOT" },
          messageCount: { $sum: 1 },
          unreadCount: {
            $sum: { $cond: [{ $eq: ["$isRead", false] }, 1, 0] },
          },
          lastActivity: { $max: "$createdAt" },
        },
      },
      { $sort: { lastActivity: -1 } },
      {
        $facet: {
          data: [
            { $skip: (pageNum - 1) * lim },
            { $limit: lim },
          ],
          totalCount: [ { $count: "count" } ],
        },
      },
    ];

    const aggResult = await AssignmentMessage.aggregate(pipeline);
    const facet = aggResult && aggResult[0] ? aggResult[0] : { data: [], totalCount: [] };
    const itemsRaw = facet.data || [];
    const total = (facet.totalCount && facet.totalCount[0] && facet.totalCount[0].count) || 0;

    // Populate the latestMessage subdocuments
    const populatedThreads = await AssignmentMessage.populate(itemsRaw, [
      { path: "latestMessage.sender", select: "_id name companyEmail" },
      { path: "latestMessage.receiver", select: "_id name companyEmail" },
      { path: "latestMessage.client", select: "_id clientName" },
    ]);

    res.json({
      items: populatedThreads,
      total,
      page: pageNum,
      pages: Math.max(1, Math.ceil(total / lim)),
      limit: lim,
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
      trashCount,
    ] = await Promise.all([
      // Inbox: messages where user is receiver, not trashed, not spam, status sent
      AssignmentMessage.countDocuments({
        $or: [{ receiver: currentUser }, { receiver: { $in: [currentUser] } }],
        status: "sent",
        isTrashed: false,
        isSpam: false,
      }),

      // Starred: messages starred by current user
      AssignmentMessage.countDocuments({
        starredBy: currentUser,
        isTrashed: false,
      }),

      // Sent: messages where user is sender, status sent
      AssignmentMessage.countDocuments({
        sender: currentUser,
        status: "sent",
        isTrashed: false,
      }),

      // Drafts: draft messages by current user
      AssignmentMessage.countDocuments({
        sender: currentUser,
        status: "draft",
        isTrashed: false,
      }),

      // Scheduled: scheduled messages by current user
      AssignmentMessage.countDocuments({
        sender: currentUser,
        status: "scheduled",
        isTrashed: false,
      }),

      // Spam: spam messages where user is receiver
      AssignmentMessage.countDocuments({
        $or: [{ receiver: currentUser }, { receiver: { $in: [currentUser] } }],
        isSpam: true,
        isTrashed: false,
      }),

      // Trash: trashed messages where user is involved
      AssignmentMessage.countDocuments({
        $or: [
          { sender: currentUser },
          { receiver: currentUser },
          { receiver: { $in: [currentUser] } },
        ],
        isTrashed: true,
      }),
    ]);

    // Debug: Check if there are any starred messages at all
    const allStarredMessages = await AssignmentMessage.find({
      starredBy: { $exists: true, $ne: [] },
    })
      .select("starredBy")
      .limit(5)
      .lean();

    res.json({
      inbox: inboxCount,
      starred: starredCount,
      sent: sentCount,
      draft: draftCount,
      scheduled: scheduledCount,
      spam: spamCount,
      trash: trashCount,
      archive: 0,
    });
  } catch (e) {
    console.error("Error in getMessageCounts:", e);
    res.status(500).json({ error: "Failed to fetch message counts" });
  }
};
exports.editPendingMessage = async function editPendingMessage(req, res) {
  try {
    const { id } = req.params;

    // Handle both FormData and JSON requests
    let subject, note, receiverBody, receiversBody;
    let removedAttachments = [];
    let files = [];

    if (req.headers["content-type"]?.includes("multipart/form-data")) {
      // Handle FormData - use direct field access
      subject = req.body.subject;
      note = req.body.note;
      receiverBody = req.body.receiver;
      receiversBody = req.body.receivers;

      // Handle removed attachments
      if (req.body.removedAttachments) {
        if (Array.isArray(req.body.removedAttachments)) {
          removedAttachments = req.body.removedAttachments;
        } else {
          removedAttachments = [req.body.removedAttachments];
        }
      }

      // Handle new files
      if (req.files && Array.isArray(req.files)) {
        files = req.files;
      }
    } else {
      ({
        subject,
        note,
        receiver: receiverBody,
        receivers: receiversBody,
      } = req.body);
    }

    // Enhanced validation
    if (!id) {
      return res.status(400).json({ error: "Message ID is required" });
    }

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid message ID format" });
    }

    if (
      subject === undefined &&
      note === undefined &&
      !receiverBody &&
      !receiversBody &&
      files.length === 0 &&
      removedAttachments.length === 0
    ) {
      return res.status(400).json({
        error:
          "No changes provided. Please update subject, note, receivers, or attachments.",
      });
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

    // Check if message is in pending status
    if (msg.approvalStatus !== "pending") {
      return res.status(400).json({
        error: "Only pending messages can be edited",
        currentStatus: msg.approvalStatus,
      });
    }

    const currentUser = req.employee;
    const currentUserId = String(currentUser._id);
    const currentUserRole = normalizeRole(currentUser.role || "");
    const isTeamLead = currentUserRole === "team_lead";

    // Check permissions: either sender OR team lead can edit pending messages
    const isSender = String(msg.sender) === currentUserId;

    if (!isSender && !isTeamLead) {
      return res.status(403).json({
        error:
          "You don't have permission to edit this pending message. Only the sender or team leads can edit pending messages.",
        messageOwner: msg.sender,
        currentUser: currentUserId,
        userRole: currentUserRole,
      });
    }

    // Team lead validation: ensure team lead belongs to the same owner
    if (isTeamLead && !isSender) {
      const messageOwner = String(msg.owner);
      const teamLeadOwner = String(currentUser.owner);

      if (messageOwner !== teamLeadOwner) {
        return res.status(403).json({
          error: "You can only edit pending messages within your organization",
          messageOwner: messageOwner,
          yourOrganization: teamLeadOwner,
        });
      }
    }

    // Update message fields
    const updateFields = {};
    if (subject !== undefined) {
      updateFields.subject = subject.trim();
    }
    if (note !== undefined) {
      updateFields.note = note.trim();
    }

    // Handle receiver updates if provided
    if (receiverBody || receiversBody) {
      let receivers = [];
      if (receiverBody)
        receivers = receivers.concat(normalizeIds(receiverBody));
      if (receiversBody)
        receivers = receivers.concat(normalizeIds(receiversBody));

      receivers = Array.from(new Set(receivers.map((id) => String(id)))).filter(
        (id) => id !== String(msg.sender)
      );

      // Validate receivers
      if (receivers.length === 0) {
        return res.status(400).json({
          error: "At least one receiver is required",
        });
      }

      updateFields.receiver = receivers;
    }

    updateFields.updatedAt = new Date();
    updateFields.lastEditedBy = currentUser._id;
    updateFields.lastEditedAt = new Date();

    const updatedMsg = await AssignmentMessage.findByIdAndUpdate(
      id,
      { $set: updateFields },
      { new: true, runValidators: true }
    );

    if (!updatedMsg) {
      throw new Error("Failed to update message in database");
    }

    // Handle removed attachments
    if (removedAttachments.length > 0) {
      updatedMsg.attachments = updatedMsg.attachments.filter(
        (attachment) => !removedAttachments.includes(attachment._id.toString())
      );
    }

    // Handle new file uploads
    if (files.length > 0) {
      const newAttachments = files.map((f) => ({
        filename: path.basename(f.filename),
        originalName: f.originalname,
        mimetype: f.mimetype,
        size: f.size,
        url: buildPublicUrl(req, f.filename),
        uploadedAt: new Date(),
        uploadedBy: currentUser._id,
      }));

      updatedMsg.attachments.push(...newAttachments);
    }

    // Save the updated message with attachments
    await updatedMsg.save();

    // Populate the updated message
    const populated = await AssignmentMessage.findById(updatedMsg._id).populate(
      [
        { path: "owner", select: "_id name companyEmail" },
        { path: "sender", select: "_id name companyEmail role" },
        { path: "receiver", select: "_id name companyEmail role" },
        { path: "client", select: "_id clientName" },
        { path: "attachments.uploadedBy", select: "_id name companyEmail" },
        { path: "lastEditedBy", select: "_id name companyEmail role" },
      ]
    );

    if (!populated) {
      throw new Error("Failed to populate updated message data");
    }

    try {
      const io = getIO(req);
      if (io) {
        // 🔥 GET ONLY ACTUAL PARTICIPANTS WHO SHOULD SEE THIS MESSAGE
        const authorizedParticipants = new Set();

        // Add sender (always authorized)
        const senderId = String(populated.sender._id);
        authorizedParticipants.add(senderId);

        // 🔥 CRITICAL: Add ONLY the receivers from the ACTUAL message (not thread participants)
        if (populated.receiver && Array.isArray(populated.receiver)) {
          populated.receiver.forEach((receiver) => {
            const receiverId = String(receiver._id);
            authorizedParticipants.add(receiverId);
          });
        }

        authorizedParticipants.add(String(currentUser._id));

        const notificationData = {
          message: populated,
          action: "pending_message_edited",
          editedBy: {
            _id: currentUser._id,
            name: currentUser.name,
            companyEmail: currentUser.companyEmail,
            role: currentUser.role,
          },
          timestamp: new Date(),
          editedByTeamLead: isTeamLead && !isSender,
        };

        authorizedParticipants.forEach((participantId) => {
          io.to(`employee_${participantId}`).emit(
            "assignment_message_updated",
            notificationData
          );
        });

        if (isTeamLead && !isSender) {
          io.to(`employee_${senderId}`).emit("team_lead_edited_your_message", {
            message: populated,
            editedBy: notificationData.editedBy,
            timestamp: new Date(),
          });
        }
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
      message:
        isTeamLead && !isSender
          ? "Pending message updated by team lead"
          : "Pending message updated successfully",
      data: populated,
      editedByTeamLead: isTeamLead && !isSender,
      timestamp: new Date(),
    });
  } catch (e) {
    console.error("❌ Error in editPendingMessage:", e);
    console.error("❌ Error stack:", e.stack);

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
      error: "Failed to edit pending message",
      ...(process.env.NODE_ENV === "development" && { debug: e.message }),
    });
  }
};

exports.markAsRead = async function markAsRead(req, res) {
  try {
    const { id } = req.params;
    const userId = req.employee._id;

    const message = await AssignmentMessage.findById(id);

    if (!message) {
      return res.status(404).json({
        success: false,
        error: "Message not found",
      });
    }

    // Check if user is authorized to read this message
    const isAuthorized =
      message.sender.toString() === userId.toString() ||
      message.receiver.some(
        (receiver) => receiver.toString() === userId.toString()
      );

    if (!isAuthorized) {
      return res.status(403).json({
        success: false,
        error: "Not authorized to access this message",
      });
    }

    // Check if user has already read this message
    const alreadyRead = message.readBy.some(
      (read) => read.employee.toString() === userId.toString()
    );

    if (!alreadyRead) {
      message.readBy.push({
        employee: userId,
        readAt: new Date(),
      });
      await message.save();
    }

    res.json({
      success: true,
      message: "Marked as read",
      data: {
        messageId: message._id,
        readBy: message.readBy,
      },
    });
  } catch (error) {
    console.error("Error marking message as read:", error);
    res.status(500).json({
      success: false,
      error: "Server error while marking message as read",
    });
  }
};

// Mark all messages in thread as read
exports.markThreadAsRead = async function markThreadAsRead(req, res) {
  try {
    const { threadId } = req.params;
    const userId = req.employee._id;

    // Find all unread messages in this thread where user is receiver
    const unreadMessages = await AssignmentMessage.find({
      threadId: threadId,
      "readBy.employee": { $ne: userId },
      $or: [{ receiver: userId }, { receiver: { $in: [userId] } }],
      isTrashed: false,
    });

    // Add user to readBy for all unread messages
    const updatePromises = unreadMessages.map((msg) =>
      AssignmentMessage.findByIdAndUpdate(msg._id, {
        $push: {
          readBy: {
            employee: userId,
            readAt: new Date(),
          },
        },
      })
    );

    await Promise.all(updatePromises);

    res.json({
      success: true,
      message: `Marked ${unreadMessages.length} messages as read`,
      readCount: unreadMessages.length,
    });
  } catch (error) {
    console.error("Error marking thread as read:", error);
    res.status(500).json({
      success: false,
      error: "Failed to mark thread as read",
    });
  }
};

// Mark message as unread
exports.markAsUnread = async function markAsUnread(req, res) {
  try {
    const { id } = req.params;
    const userId = req.employee._id;

    const message = await AssignmentMessage.findById(id);

    if (!message) {
      return res.status(404).json({
        success: false,
        error: "Message not found",
      });
    }

    // Check if user is authorized
    const isAuthorized =
      message.sender.toString() === userId.toString() ||
      message.receiver.some(
        (receiver) => receiver.toString() === userId.toString()
      );

    if (!isAuthorized) {
      return res.status(403).json({
        success: false,
        error: "Not authorized to access this message",
      });
    }

    // Remove user from readBy array
    message.readBy = message.readBy.filter(
      (read) => read.employee.toString() !== userId.toString()
    );

    await message.save();

    res.json({
      success: true,
      message: "Marked as unread",
      data: {
        messageId: message._id,
        readBy: message.readBy,
      },
    });
  } catch (error) {
    console.error("Error marking message as unread:", error);
    res.status(500).json({
      success: false,
      error: "Server error while marking message as unread",
    });
  }
};

// Get unread count for user
exports.getUnreadCount = async function getUnreadCount(req, res) {
  try {
    const userId = req.employee._id;

    const unreadCount = await AssignmentMessage.countDocuments({
      receiver: userId, // Only count messages where user is receiver
      "readBy.employee": { $ne: userId },
      isTrashed: false,
      isSpam: false,
      status: "sent",
    });

    res.json({
      success: true,
      data: {
        unreadCount,
      },
    });
  } catch (error) {
    console.error("Error getting unread count:", error);
    res.status(500).json({
      success: false,
      error: "Server error while fetching unread count",
    });
  }
};

// Mark multiple messages as read
exports.markMultipleAsRead = async function markMultipleAsRead(req, res) {
  try {
    const { messageIds } = req.body;
    const userId = req.employee._id;

    if (!messageIds || !Array.isArray(messageIds)) {
      return res.status(400).json({
        success: false,
        error: "Message IDs array is required",
      });
    }

    // Update all messages that haven't been read by this user
    const result = await AssignmentMessage.updateMany(
      {
        _id: { $in: messageIds },
        "readBy.employee": { $ne: userId },
        $or: [{ sender: userId }, { receiver: userId }],
      },
      {
        $push: {
          readBy: {
            employee: userId,
            readAt: new Date(),
          },
        },
      }
    );

    res.json({
      success: true,
      message: `${result.modifiedCount} messages marked as read`,
      data: {
        modifiedCount: result.modifiedCount,
      },
    });
  } catch (error) {
    console.error("Error marking multiple messages as read:", error);
    res.status(500).json({
      success: false,
      error: "Server error while marking messages as read",
    });
  }
};
