const AssignmentMessage = require("../models/AssignmentMessage");
const Employee = require("../models/Employees");
const path = require("path");
const mongoose = require("mongoose");
const ClientInfo = require("../models/ClientInfo");
const EmployeeHierarchy = require("../models/EmployeeHierarchy");

/** ---------- HIERARCHY-BASED SUPERVISOR LOOKUP ---------- **/

/**
 * Find the supervisor(s) of an employee using the EmployeeHierarchy model.
 * This is used when supervision is enabled for a client to properly route
 * approval messages up the hierarchy chain.
 * @param {string} ownerId - The owner ID (organization)
 * @param {string} employeeId - The employee whose supervisor(s) we're looking for
 * @returns {Promise<string[]>} - Array of supervisor (senior) employee IDs
 */
async function findSupervisorsFromHierarchy(ownerId, employeeId) {
  if (!isObjId(ownerId) || !isObjId(employeeId)) return [];

  try {
    // Find all hierarchy links where the employee is the junior
    const hierarchyLinks = await EmployeeHierarchy.find({
      owner: ownerId,
      junior: employeeId,
    })
      .select("senior")
      .lean();

    const supervisorIds = hierarchyLinks.map((link) => String(link.senior));
    return supervisorIds;
  } catch (error) {
    console.error("Error finding supervisors from hierarchy:", error);
    return [];
  }
}

/**
 * Get the full management chain for an employee (all seniors up to root).
 * This traverses the hierarchy tree upward.
 * @param {string} ownerId - The owner ID (organization)
 * @param {string} employeeId - The starting employee
 * @returns {Promise<string[]>} - Array of all supervisor IDs in the chain
 */
async function getManagementChainFromHierarchy(ownerId, employeeId) {
  if (!isObjId(ownerId) || !isObjId(employeeId)) return [];

  try {
    const chain = [];
    let currentEmployee = employeeId;
    const visited = new Set();

    // Traverse up the hierarchy (limit to 10 levels to prevent infinite loops)
    for (let i = 0; i < 10; i++) {
      if (visited.has(currentEmployee)) break;
      visited.add(currentEmployee);

      const hierarchyLink = await EmployeeHierarchy.findOne({
        owner: ownerId,
        junior: currentEmployee,
      })
        .select("senior")
        .lean();

      if (!hierarchyLink || !hierarchyLink.senior) break;

      const seniorId = String(hierarchyLink.senior);
      chain.push(seniorId);
      currentEmployee = seniorId;
    }

    return chain;
  } catch (error) {
    console.error("Error getting management chain:", error);
    return [];
  }
}

const isObjId = (v) => mongoose.isValidObjectId(v);

/** ---------- SOCKET.IO UTILITIES ---------- **/
function getIO(req) {
  return req.app.get("io");
}
const oid = (v) =>
  mongoose.isValidObjectId(v) ? new mongoose.Types.ObjectId(v) : null;

async function applyVisibility(q, req) {
  if (!req.employee?._id) return { _id: null };

  const me = oid(String(req.employee._id));
  if (!me) return { _id: null };

  const currentUserRole = normalizeRole(req.employee?.role || "");
  const ownerId = req.employee?.owner ? oid(req.employee.owner) : null;

  // 🛡️ CORE PRIVACY RULE: Pending messages are ONLY visible to participants (Sender & Receiver)
  const isParticipant = {
    $or: [{ sender: me }, { receiver: me }, { receiver: { $in: [me] } }],
  };

  // Get clients I'm assigned to for shared visibility
  const assignedClients = await ClientInfo.find({
    owner: ownerId,
    assignedTo: me
  }).select("_id").lean();
  const assignedClientIds = assignedClients.map(c => oid(c._id));

  // Hierarchy lookup for junior-based visibility
  const juniorLinks = await EmployeeHierarchy.find({
    owner: ownerId,
    senior: me,
  })
    .select("junior")
    .lean();
  const juniorIds = juniorLinks.map((link) => oid(link.junior));

  // 👁️ ROLE/HIERARCHY VISIBILITY
  const isManagerOwner = ["manager", "owner"].includes(currentUserRole);

  const hierarchySegments = [];
  if (currentUserRole === "team_lead") {
    hierarchySegments.push({ owner: ownerId });
  }
  if (juniorIds.length > 0) {
    hierarchySegments.push({ sender: { $in: juniorIds } });
    hierarchySegments.push({ receiver: { $in: juniorIds } });
  }

  const roleSegments = [];
  if (isManagerOwner) {
    roleSegments.push({ owner: ownerId });
  }

  if (hierarchySegments.length > 0) {
    roleSegments.push({
      approvalStatus: { $ne: "pending" },
      $or: hierarchySegments
    });
  }

  // If no role/hierarchy access applies, use a filter that matches nothing
  const roleHierarchyFilter = roleSegments.length > 0 ? { $or: roleSegments } : { _id: null };

  // Base visibility rules:
  // 1. You are a participant (sender/receiver)
  // 2. You have role-based visibility (Manager/Lead/Senior)
  // 3. You are assigned to the client (Team visibility)
  // 4. Organization-wide: Anyone in the organization can see "Sent" or "Scheduled" messages (once they aren't pending)
  const organizationSentVisibility = {
    owner: ownerId,
    status: { $in: ["sent", "scheduled"] },
    approvalStatus: { $ne: "pending" }
  };

  const inboxVisibility = {
    $or: [
      isParticipant,
      roleHierarchyFilter,
      organizationSentVisibility,
      ...(assignedClientIds.length > 0 ? [{ client: { $in: assignedClientIds } }] : [])
    ]
  };

  // 🕒 SCHEDULED MESSAGE VISIBILITY
  const now = new Date();
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
          inboxVisibility,
        ],
      },
      // Always see your own future scheduled messages (Drafts/Future)
      {
        isScheduled: true,
        status: "scheduled",
        scheduledFor: { $gt: now },
        sender: me,
      },
    ],
  };

  // Handle specific scheduled fetch
  if (q.isScheduled === true && q.status === "scheduled") {
    return { $and: [q, inboxVisibility] };
  }

  return { $and: [q, scheduledVisibility] };
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
    const me = oid(userId);
    const ownerId = req.employee?.owner ? oid(req.employee.owner) : null;
    const currentUserRole = normalizeRole(req.employee?.role || "");
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

    // Check basic participant access
    let hasAccess = userId === senderId || receiverIds.includes(userId);

    // Check Manager/Owner/Team Lead access
    if (!hasAccess && ["manager", "owner", "team_lead"].includes(currentUserRole)) {
      if (String(msg.owner?._id || msg.owner) === String(ownerId)) {
        hasAccess = true;
      }
    }

    // Check client assignment access (team visibility)
    if (!hasAccess && msg.client) {
      const clientId = msg.client?._id || msg.client;
      const client = await ClientInfo.findOne({
        _id: clientId,
        assignedTo: me
      }).select("_id").lean();
      if (client) hasAccess = true;
    }

    // Check hierarchy access (senior viewing junior)
    if (!hasAccess && senderId) {
      const seniorsOfSender = await getManagementChainFromHierarchy(ownerId, senderId);
      if (seniorsOfSender.includes(userId)) hasAccess = true;
    }

    // Check organization-wide sent visibility (all users can see non-pending sent/scheduled emails in the company)
    if (!hasAccess && (msg.status === "sent" || msg.status === "scheduled") && msg.approvalStatus !== "pending") {
      if (String(msg.owner?._id || msg.owner) === String(ownerId)) {
        hasAccess = true;
      }
    }

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
    
    // Defensive check for employee authentication
    if (!req.employee?._id) {
      return res.status(401).json({ error: "Unauthorized - employee not authenticated" });
    }
    
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

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 1000);

    const isSentView = req.query.status === "sent";
    const isTrashedVal = isTrashed === "true" || isTrashed === true;
    const isSpamVal = isSpam === "true" || isSpam === true;
    const isParticipantView = !!req.query.participant;
    
    // Unified inbox view (incoming only) applies ONLY if we aren't in Sent, Trash, Spam, or asking for ALL mail (participant view)
    const isInboxView = !isSentView && !isTrashedVal && !isSpamVal && !isParticipantView;
    
    // Force incoming-only for unified inbox unless explicitly in Sent, Trash, or asking for ALL mail
    if (isInboxView) {
      q.$or = [
        { isFromClient: true },
        { receiver: me },
        { receiver: { $in: [me] } }
      ];
    }

    const qFinal = await applyVisibility(q, req);

    const isThreaded = req.query.threadMode === "true" || req.query.threadMode === true;

    if (isThreaded) {
      const distinctThreads = await AssignmentMessage.aggregate([
        { $match: qFinal },
        { $sort: { createdAt: -1 } },
        {
          $group: {
            _id: "$threadId",
            latestId: { $first: "$_id" },
            latestMessageAt: { $max: "$createdAt" },
            receivedSomething: {
              $max: {
                $cond: [
                  {
                    $or: [
                      { $eq: ["$isFromClient", true] },
                      { $in: [{ $toString: me }, { $map: { input: { $ifNull: ["$receiver", []] }, as: "r", in: { $toString: "$$r" } } }] },
                      { $and: [{ $ne: [{ $toString: "$sender" }, { $toString: me }] }, { $ne: ["$sender", null] }] }
                    ]
                  },
                  true,
                  false
                ]
              }
            },
            threadMessageCount: { $sum: 1 },
            threadUnreadCount: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      { $not: { $in: [me, { $ifNull: ["$readBy.employee", []] }] } },
                      { $in: [{ $toString: me }, { $map: { input: { $ifNull: ["$receiver", []] }, as: "r", in: { $toString: "$$r" } } }] }
                    ]
                  },
                  1,
                  0
                ]
              }
            }
          }
        },
        { $match: { receivedSomething: true } },
        { $sort: { latestMessageAt: -1 } },
        { $skip: (pageNum - 1) * lim },
        { $limit: lim }
      ]);

      const latestMessageIds = distinctThreads.map(t => t.latestId);
      if (latestMessageIds.length === 0) {
        return res.json({ items: [], total: 0, page: pageNum, pages: 0, limit: lim });
      }

      const [messages, totalThreadsResult] = await Promise.all([
        AssignmentMessage.find({ _id: { $in: latestMessageIds } })
          .populate([
            { path: "owner", select: "_id name companyEmail" },
            { path: "sender", select: "_id name companyEmail role supervisionMode" },
            { path: "receiver", select: "_id name companyEmail role" },
            { path: "client", select: "_id clientName" },
          ])
          .lean(),
        AssignmentMessage.aggregate([
          { $match: qFinal },
          {
            $group: {
              _id: "$threadId",
              receivedSomething: {
                $max: {
                  $cond: [
                    {
                      $or: [
                        { $eq: ["$isFromClient", true] },
                        { $in: [{ $toString: me }, { $map: { input: { $ifNull: ["$receiver", []] }, as: "r", in: { $toString: "$$r" } } }] },
                        { $and: [{ $ne: [{ $toString: "$sender" }, { $toString: me }] }, { $ne: ["$sender", null] }] }
                      ]
                    },
                    true,
                    false
                  ]
                }
              }
            }
          },
          { $match: { receivedSomething: true } },
          { $count: "total" }
        ])
      ]);

      const totalCount = totalThreadsResult.length > 0 ? totalThreadsResult[0].total : 0;
      const finalItems = messages.map(m => {
        const stats = distinctThreads.find(t => String(t.latestId) === String(m._id));
        return {
          ...m,
          receiver: Array.isArray(m.receiver) ? m.receiver : [m.receiver].filter(Boolean),
          isDirectMessage: !m.client,
          threadMessageCount: stats ? stats.threadMessageCount : 1,
          threadUnreadCount: stats ? stats.threadUnreadCount : 0
        };
      }).sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt));

      return res.json({
        items: finalItems,
        total: totalCount,
        page: pageNum,
        pages: Math.ceil(totalCount / lim),
        limit: lim,
        userRole: currentUserRole,
        isTeamLead: isTeamLead,
      });
    }

    // Default: Regular non-grouped fetch
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

exports.getExternalCommunications = async function getExternalCommunications(
  req,
  res
) {
  try {
    const {
      client,
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
      threadId,
      search,
      threadMode = "true", // Add thread mode parameter
    } = req.query;

    const currentUser = req.employee?._id;
    if (!isObjId(currentUser)) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const me = oid(String(currentUser));
    const q = {
      client: { $exists: true, $ne: null },

      // ❌ no drafts
      status: { $ne: "draft" },
    };

    if (isObjId(client)) q.client = client;

    if (isObjId(owner)) q.owner = owner;
    else if (req.employee?.owner) q.owner = req.employee.owner;

    if (["sent", "scheduled", "cancelled"].includes(status)) {
      q.status = status;
      if (status === "scheduled") q.isScheduled = true;
    } else {
      q.status = { $in: ["sent", "scheduled"] };
    }

    if (isTrashed === "true") q.isTrashed = true;
    else if (isSpam === "true") q.isSpam = true;
    else {
      q.isTrashed = { $ne: true };
      q.isSpam = { $ne: true };
    }

    if (filter === "review" || approvalStatus === "pending") {
      q.approvalStatus = "pending";
    }

    if (filter === "scheduled" || isScheduled === "true") {
      q.isScheduled = true;
      q.status = "scheduled";
    }

    const timeFilters = {};
    if (scheduledBefore) timeFilters.$lte = new Date(scheduledBefore);
    if (scheduledAfter) timeFilters.$gte = new Date(scheduledAfter);
    if (Object.keys(timeFilters).length) q.scheduledFor = timeFilters;

    if (threadId) q.threadId = threadId;

    const between = normalizeIds(betweenRaw);
    if (between.length === 2) {
      const [a, b] = between;
      q.$or = [
        { sender: a, receiver: b },
        { sender: b, receiver: a },
      ];
    }

    if (search && search.trim()) {
      q.$and = [
        {
          $or: [
            { subject: { $regex: search, $options: "i" } },
            { note: { $regex: search, $options: "i" } },
            { "client.clientName": { $regex: search, $options: "i" } },
          ],
        },
      ];
    }

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 1000);

    const isSentView = status === "sent";
    const isInboxView = !isSentView && isTrashed !== "true" && isSpam !== "true";

    // 🔥 CRM/Manager Fix: External Inbox ONLY shows incoming client mail or mail to self.
    // Solo sent messages to clients are handled in the 'Sent' tab.
    if (isInboxView) {
      q.$or = [
        { isFromClient: true },
        { receiver: me },
        { receiver: { $in: [me] } }
      ];
    }

    const qFinal = await applyVisibility(q, req);

    // Robust threadMode check
    const isThreaded = threadMode === "true" || threadMode === true;

    if (isThreaded) {
      const distinctThreads = await AssignmentMessage.aggregate([
        { $match: qFinal },
        { $sort: { createdAt: -1 } },
        {
          $group: {
            _id: "$threadId",
            latestId: { $first: "$_id" },
            latestMessageAt: { $max: "$createdAt" },
            // CRM (manager) and all users: External Inbox strictly shows threads with CLIENT replies.
            // Solitary sent messages remain in "Sent".
            hasClientInteraction: {
              $max: {
                $cond: [{ $eq: ["$isFromClient", true] }, true, false]
              }
            },
            hasClient: { $first: { $cond: [{ $ifNull: ["$client", false] }, true, false] } },
            threadMessageCount: { $sum: 1 },
            threadUnreadCount: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      { $not: { $in: [me, { $ifNull: ["$readBy.employee", []] }] } },
                      { $in: [{ $toString: me }, { $map: { input: { $ifNull: ["$receiver", []] }, as: "r", in: { $toString: "$$r" } } }] }
                    ]
                  },
                  1,
                  0
                ]
              }
            }
          }
        },
        // Filter: Must have client ID AND must have an incoming message from a client
        { $match: { hasClient: true, hasClientInteraction: true } },
        { $sort: { latestMessageAt: -1 } },
        { $skip: (pageNum - 1) * lim },
        { $limit: lim }
      ]);

      const latestMessageIds = distinctThreads.map(t => t.latestId);
      if (latestMessageIds.length === 0) {
        return res.json({ communicationType: "external", items: [], total: 0, page: pageNum, pages: 0, limit: lim });
      }

      const [messages, totalThreadsResult] = await Promise.all([
        AssignmentMessage.find({ _id: { $in: latestMessageIds } })
          .populate([
            { path: "owner", select: "_id name companyEmail" },
            { path: "sender", select: "_id name companyEmail role supervisionMode" },
            { path: "receiver", select: "_id name companyEmail role" },
            { path: "client", select: "_id clientName" },
          ])
          .lean(),
        AssignmentMessage.aggregate([
          { $match: qFinal },
          {
            $group: {
              _id: "$threadId",
              hasClientInteraction: {
                $max: {
                  $cond: [{ $eq: ["$isFromClient", true] }, true, false]
                }
              },
              hasClient: { $first: { $cond: [{ $ifNull: ["$client", false] }, true, false] } }
            }
          },
          { $match: { hasClient: true, hasClientInteraction: true } },
          { $count: "total" }
        ])
      ]);

      const totalCount = totalThreadsResult.length > 0 ? totalThreadsResult[0].total : 0;
      const finalItems = messages.map(m => {
        const stats = distinctThreads.find(t => String(t.latestId) === String(m._id));
        return {
          ...m,
          receiver: Array.isArray(m.receiver) ? m.receiver : [m.receiver].filter(Boolean),
          isDirectMessage: !m.client,
          threadMessageCount: stats ? stats.threadMessageCount : 1,
          threadUnreadCount: stats ? stats.threadUnreadCount : 0
        };
      }).sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt));

      return res.json({
        communicationType: "external",
        items: finalItems,
        total: totalCount,
        page: pageNum,
        pages: Math.ceil(totalCount / lim),
        limit: lim,
      });
    }

    // Original non-thread mode (for backward compatibility)
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
          },
          { path: "receiver", select: "_id name companyEmail role" },
          { path: "client", select: "_id clientName" },
        ])
        .lean(),
      AssignmentMessage.countDocuments(qFinal),
    ]);

    res.json({
      communicationType: "external",
      items,
      total,
      page: pageNum,
      pages: Math.ceil(total / lim),
      limit: lim,
      threadMode: false
    });
  } catch (e) {
    console.error("❌ Error in getExternalCommunications:", e);
    res.status(500).json({ error: "Failed to fetch external communications" });
  }
};

exports.getInternalCommunications = async function getInternalCommunications(
  req,
  res
) {
  try {
    const {
      owner,
      sender,
      receiver,
      participant,
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
      threadId,
      search,
    } = req.query;

    const currentUser = req.employee?._id;
    if (!isObjId(currentUser)) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    /* --------------------------------------------------
     * BASE QUERY (INTERNAL - BOTH SENT AND RECEIVED)
     * -------------------------------------------------- */
    const currentUserRole = normalizeRole(req.employee?.role || "");
    const me = oid(String(req.employee._id));

    const q = {
      $or: [
        { client: { $exists: false } },
        { client: null }
      ],

      // ❌ no drafts
      status: { $ne: "draft" },
    };

    /* -------------------------------------------------- */
    if (isObjId(owner)) q.owner = owner;
    else if (req.employee?.owner) q.owner = req.employee.owner;

    if (["sent", "scheduled", "cancelled"].includes(status)) {
      q.status = status;
      if (status === "scheduled") q.isScheduled = true;
    } else {
      q.status = { $in: ["sent", "scheduled"] };
    }

    if (isTrashed === "true") q.isTrashed = true;
    else if (isSpam === "true") q.isSpam = true;
    else {
      q.isTrashed = { $ne: true };
      q.isSpam = { $ne: true };
    }

    if (approvalStatus) q.approvalStatus = approvalStatus;

    if (filter === "scheduled" || isScheduled === "true") {
      q.isScheduled = true;
      q.status = "scheduled";
    }

    const timeFilters = {};
    if (scheduledBefore) timeFilters.$lte = new Date(scheduledBefore);
    if (scheduledAfter) timeFilters.$gte = new Date(scheduledAfter);
    if (Object.keys(timeFilters).length) q.scheduledFor = timeFilters;

    if (threadId) q.threadId = threadId;

    const between = normalizeIds(betweenRaw);
    if (between.length === 2) {
      const [a, b] = between;
      q.$or = [
        { sender: a, receiver: b },
        { sender: b, receiver: a },
      ];
    } else if (isObjId(participant)) {
      q.$or = [{ receiver: participant }, { receiver: { $in: [participant] } }];
    }

    if (search && search.trim()) {
      q.$and = [
        {
          $or: [
            { subject: { $regex: search, $options: "i" } },
            { note: { $regex: search, $options: "i" } },
          ],
        },
      ];
    }

    const qFinal = await applyVisibility(q, req);

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 1000);

    const isSentView = status === "sent";
    const isInboxView = !isSentView && isTrashed !== "true" && isSpam !== "true";

    if (isInboxView) {
      q.$or = [
        { receiver: me },
        { receiver: { $in: [me] } }
      ];
    }
    
    // Robust threadMode check
    const isThreaded = req.query.threadMode === "true" || req.query.threadMode === true;

    if (isThreaded) {
      const distinctThreads = await AssignmentMessage.aggregate([
        { $match: qFinal },
        { $sort: { createdAt: -1 } },
        {
          $group: {
            _id: "$threadId",
            latestId: { $first: "$_id" },
            latestMessageAt: { $max: "$createdAt" },
            // Internal Inbox logic: show if received from someone else
            receivedFromOthers: {
              $max: {
                $cond: [
                  {
                    $or: [
                      { $in: [{ $toString: me }, { $map: { input: { $ifNull: ["$receiver", []] }, as: "r", in: { $toString: "$$r" } } }] },
                      { $and: [{ $ne: [{ $toString: "$sender" }, { $toString: me }] }, { $ne: ["$sender", null] }] }
                    ]
                  },
                  true,
                  false
                ]
              }
            },
            hasClient: { $first: { $cond: [{ $ifNull: ["$client", false] }, true, false] } },
            threadMessageCount: { $sum: 1 },
            threadUnreadCount: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      { $not: { $in: [me, { $ifNull: ["$readBy.employee", []] }] } },
                      { $in: [{ $toString: me }, { $map: { input: { $ifNull: ["$receiver", []] }, as: "r", in: { $toString: "$$r" } } }] }
                    ]
                  },
                  1,
                  0
                ]
              }
            }
          }
        },
        // Filter to only include threads without clients AND that have incoming interaction
        { $match: { hasClient: false, receivedFromOthers: true } },
        { $sort: { latestMessageAt: -1 } },
        { $skip: (pageNum - 1) * lim },
        { $limit: lim }
      ]);

      const latestMessageIds = distinctThreads.map(t => t.latestId);
      if (latestMessageIds.length === 0) {
        return res.json({ communicationType: "internal", items: [], total: 0, page: pageNum, pages: 0, limit: lim });
      }

      const [messages, totalThreadsResult] = await Promise.all([
        AssignmentMessage.find({ _id: { $in: latestMessageIds } })
          .populate([
            { path: "owner", select: "_id name companyEmail" },
            { path: "sender", select: "_id name companyEmail role supervisionMode" },
            { path: "receiver", select: "_id name companyEmail role" },
          ])
          .lean(),
        AssignmentMessage.aggregate([
          { $match: qFinal },
          {
            $group: {
              _id: "$threadId",
              receivedFromOthers: {
                $max: {
                  $cond: [
                    {
                      $or: [
                        { $in: [{ $toString: me }, { $map: { input: { $ifNull: ["$receiver", []] }, as: "r", in: { $toString: "$$r" } } }] },
                        { $and: [{ $ne: [{ $toString: "$sender" }, { $toString: me }] }, { $ne: ["$sender", null] }] }
                      ]
                    },
                    true,
                    false
                  ]
                }
              },
              hasClient: { $first: { $cond: [{ $ifNull: ["$client", false] }, true, false] } }
            }
          },
          { $match: { hasClient: false, receivedFromOthers: true } }, // Internal only
          { $count: "total" }
        ])
      ]);

      const totalCount = totalThreadsResult.length > 0 ? totalThreadsResult[0].total : 0;
      const finalItems = messages.map(m => {
        const stats = distinctThreads.find(t => String(t.latestId) === String(m._id));
        return {
          ...m,
          receiver: Array.isArray(m.receiver) ? m.receiver : [m.receiver].filter(Boolean),
          isDirectMessage: !m.client,
          threadMessageCount: stats ? stats.threadMessageCount : 1,
          threadUnreadCount: stats ? stats.threadUnreadCount : 0
        };
      }).sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt));

      return res.json({
        communicationType: "internal",
        items: finalItems,
        total: totalCount,
        page: pageNum,
        pages: Math.ceil(totalCount / lim),
        limit: lim,
      });
    }

    // Default: flat list
    const [items, total] = await Promise.all([
      AssignmentMessage.find(qFinal)
        .sort({ createdAt: -1 })
        .skip((pageNum - 1) * lim)
        .limit(lim)
        .populate([
          { path: "owner", select: "_id name companyEmail" },
          { path: "sender", select: "_id name companyEmail role" },
          { path: "receiver", select: "_id name companyEmail role" },
        ])
        .lean(),
      AssignmentMessage.countDocuments(qFinal),
    ]);

    res.json({
      communicationType: "internal",
      items,
      total,
      page: pageNum,
      pages: Math.ceil(total / lim),
      limit: lim,
    });
  } catch (e) {
    console.error("❌ Error in getInternalCommunications:", e);
    res.status(500).json({ error: "Failed to fetch internal communications" });
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
    const currentUserRole = normalizeRole(req.employee?.role || "");
    const ownerId = req.employee?.owner;

    const canView = await AssignmentMessage.findOne({
      _id: id,
      $or: [
        { sender: currentUser },
        { receiver: currentUser },
        { receiver: { $in: [currentUser] } },
        ...(currentUserRole === "manager" || currentUserRole === "owner" ? [{ owner: ownerId }] : [])
      ],
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
      approvalStatus: { $ne: "pending" }, // 🔥 FIX: Don't count pending messages as unread emails
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
// GET /api/assignment-messages/client/:clientId/threads
exports.getClientThreads = async function getClientThreads(req, res) {
  try {
    const { clientId } = req.params;
    let { limit = 50, page = 1 } = req.query;

    if (!isObjId(clientId)) {
      return res.status(400).json({ error: "Valid client ID is required" });
    }

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 1000);

    // Apply visibility rules
    const qFinal = await applyVisibility({ client: clientId }, req);

    // Aggregate threads and return both paginated data and total count using $facet
    const pipeline = [
      { $match: qFinal },
      { $sort: { createdAt: -1 } }, // Sort before grouping to ensure $first gets latest
      // Group messages into threads, keeping the latest message
      {
        $group: {
          _id: "$threadId",
          latestMessage: { $first: "$$ROOT" },
          messageCount: { $sum: 1 },
          unreadCount: {
            $sum: { 
              $cond: [
                { $and: [
                  { $not: { $in: [me, { $ifNull: ["$readBy.employee", []] }] } },
                  { $in: [{ $toString: me }, { $map: { input: { $ifNull: ["$receiver", []] }, as: "r", in: { $toString: "$$r" } } }] }
                ]}, 
                1, 
                0
              ] 
            },
          },
          lastActivity: { $max: "$createdAt" },
        },
      },
      { $sort: { lastActivity: -1 } },
      {
        $facet: {
          data: [{ $skip: (pageNum - 1) * lim }, { $limit: lim }],
          totalCount: [{ $count: "count" }],
        },
      },
    ];

    const aggResult = await AssignmentMessage.aggregate(pipeline);
    const facet =
      aggResult && aggResult[0] ? aggResult[0] : { data: [], totalCount: [] };
    const itemsRaw = facet.data || [];
    const total =
      (facet.totalCount && facet.totalCount[0] && facet.totalCount[0].count) ||
      0;

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
          { path: "sender", select: "_id name companyEmail role photographUrl imageUrl" },
          { path: "receiver", select: "_id name companyEmail role photographUrl imageUrl" },
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
    const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 1000);
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
    const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 1000);

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
    const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 1000);

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
    const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 1000);

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
exports.getTeamLeadPendingApprovals =
  async function getTeamLeadPendingApprovals(req, res) {
    try {
      const {
        client,
        sender,
        receiver,
        limit = 50,
        page = 1,
        search,
        dateFrom,
        dateTo,
        includeDirect = "true",
        includeExternal = "true",
        threadId,
        showThread = "true",
      } = req.query;

      // Verify team lead
      const currentUserRole = normalizeRole(req.employee?.role || "");
      if (currentUserRole !== "team_lead") {
        return res.status(403).json({
          error: "Access denied. Only team leads can view pending approvals.",
        });
      }

      const currentUserId = req.employee?._id;
      const ownerId = req.employee?.owner;

      if (!isObjId(currentUserId) || !isObjId(ownerId)) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      // 🔥 HIERARCHY-BASED: Get juniors for this supervisor
      const juniorLinks = await EmployeeHierarchy.find({
        owner: ownerId,
        senior: currentUserId,
      }).select("junior").lean();

      const supervisedEmployeeIds = juniorLinks.map(link => link.junior);

      // Base query: Get pending messages where this user is receiver OR sender is a junior
      const query = {
        owner: ownerId,
        approvalStatus: "pending",
        $or: [
          { receiver: currentUserId },
          { receiver: { $in: [currentUserId] } },
          { sender: { $in: supervisedEmployeeIds } }
        ],
        isTrashed: false,
        isSpam: false,
      };

      // Apply client filter
      if (isObjId(client)) {
        query.client = client;
      }

      // Apply sender filter
      if (isObjId(sender)) {
        query.sender = sender;
      }

      // Apply receiver filter
      if (isObjId(receiver)) {
        query.$or = [{ receiver: receiver }, { receiver: { $in: [receiver] } }];
      }

      // Apply thread filter
      if (threadId) {
        query.threadId = threadId;
      }

      // Apply search filter
      if (search?.trim()) {
        const regex = new RegExp(search.trim(), "i");
        query.$or = query.$or || [];
        query.$and = query.$and || [];
        query.$and.push({
          $or: [{ subject: regex }, { note: regex }, { "sender.name": regex }],
        });
      }

      // Apply date filter
      if (dateFrom || dateTo) {
        const dateFilter = {};
        if (dateFrom) dateFilter.$gte = new Date(dateFrom);
        if (dateTo) dateFilter.$lte = new Date(dateTo);
        query.createdAt = dateFilter;
      }

      // Get total count first
      const totalCount = await AssignmentMessage.countDocuments(query);
      // Pagination
      const pageNum = Math.max(parseInt(page, 10) || 1, 1);
      const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 100);

      // Fetch ALL messages (not paginated) to group by thread
      const allMessages = await AssignmentMessage.find(query)
        .sort({ createdAt: -1 })
        .populate([
          { path: "owner", select: "_id name companyEmail" },
          {
            path: "sender",
            select: "_id name companyEmail role supervisionMode",
          },
          { path: "receiver", select: "_id name companyEmail role" },
          { path: "client", select: "_id clientName" },
          { path: "readBy.employee", select: "_id name companyEmail" },
          { path: "starredBy", select: "_id name companyEmail" },
        ])
        .lean();
      // Group messages by threadId
      const threadMap = new Map();

      allMessages.forEach((message) => {
        const threadId = message.threadId || `single_${message._id}`;

        if (!threadMap.has(threadId)) {
          // First message in this thread
          threadMap.set(threadId, {
            threadId: threadId,
            clientId: message.client?._id || null,
            clientName:
              message.client?.clientName ||
              (message.client ? "Client" : "Direct Message"),
            latestMessage: message, // Latest is the first one (sorted by createdAt: -1)
            messages: [message],
            unreadCount: message.readBy?.some(
              (read) =>
                read.employee &&
                read.employee._id &&
                read.employee._id.toString() === currentUserId.toString()
            )
              ? 0
              : 1,
            totalMessages: 1,
            pendingMessages: message.approvalStatus === "pending" ? 1 : 0,
            lastActivity: message.createdAt,
            isStarred:
              message.starredBy?.some(
                (star) =>
                  star._id && star._id.toString() === currentUserId.toString()
              ) || false,
            subject: message.subject || "No Subject",
            sender: message.sender,
            isDirectMessage: !message.client,
            createdAt: message.createdAt,
            updatedAt: message.updatedAt,
          });
        } else {
          // Additional message in existing thread
          const thread = threadMap.get(threadId);
          thread.messages.push(message);
          thread.totalMessages++;

          // Update pending message count
          if (message.approvalStatus === "pending") {
            thread.pendingMessages++;
          }

          // Update to latest message if this one is newer
          if (
            new Date(message.createdAt) >
            new Date(thread.latestMessage.createdAt)
          ) {
            thread.latestMessage = message;
            thread.updatedAt = message.updatedAt;
          }

          // Update unread count
          const isRead = message.readBy?.some(
            (read) =>
              read.employee &&
              read.employee._id &&
              read.employee._id.toString() === currentUserId.toString()
          );
          if (!isRead) {
            thread.unreadCount++;
          }

          // Update starred status
          const isStarred = message.starredBy?.some(
            (star) =>
              star._id && star._id.toString() === currentUserId.toString()
          );
          if (isStarred) {
            thread.isStarred = true;
          }
        }
      });

      // Convert map to array and sort by lastActivity (newest first)
      let threads = Array.from(threadMap.values());
      threads.sort(
        (a, b) => new Date(b.lastActivity) - new Date(a.lastActivity)
      );

      // Apply pagination to threads (not messages)
      const startIndex = (pageNum - 1) * lim;
      const endIndex = startIndex + lim;
      const paginatedThreads = threads.slice(startIndex, endIndex);

      // Debug: Log first few threads
      paginatedThreads.slice(0, 3).forEach((thread, index) => { });

      // Return results
      res.json({
        success: true,
        items: paginatedThreads, // Return threads, not individual messages
        threads: paginatedThreads, // For consistency
        messages: allMessages, // Still return all messages for reference
        total: threads.length, // Total number of threads
        totalCount: totalCount, // Total number of messages
        page: pageNum,
        pages: Math.ceil(threads.length / lim), // Pages based on threads
        limit: lim,
        statistics: {
          totalThreads: threads.length,
          totalMessages: totalCount,
          pendingMessages: totalCount, // All messages are pending in this view
          directMessages: threads.filter((t) => t.isDirectMessage).length,
          clientMessages: threads.filter((t) => !t.isDirectMessage).length,
          uniqueSenders: new Set(
            threads.map((t) => t.sender?._id).filter(Boolean)
          ).size,
        },
        debug: {
          supervisedEmployeesCount: supervisedEmployeeIds.length,
          query: query,
          threadsCount: threads.length,
          paginatedThreadsCount: paginatedThreads.length,
        },
      });
    } catch (e) {
      console.error("❌ Error in getTeamLeadPendingApprovals:", e);
      res.status(500).json({
        error: "Failed to fetch pending approvals",
        details: process.env.NODE_ENV === "development" ? e.message : undefined,
      });
    }
  };
