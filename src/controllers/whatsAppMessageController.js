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

  // 🧑‍🤝‍🧑 TEAM LEAD: can see messages where they are involved OR manager messages for supervision
  if (currentUserRole === "team_lead") {
    // Get all managers in the same organization
    const { managers } = await findTLsAndManagersByOwner(ownerId);

    return {
      ...q,
      $or: [
        { sender: me },
        { receiver: me },
        { receiver: { $in: [me] } },
        // 🔥 CRITICAL FIX: Allow team leads to see manager messages
        {
          sender: { $in: managers.map((id) => oid(id)) },
          owner: ownerId,
        },
      ],
    };
  }

  // 👷 NORMAL EMPLOYEE: can see messages where they are sender OR receiver
  const now = new Date();
  const visOr = [{ sender: me }, { receiver: me }, { receiver: { $in: [me] } }];

  if (q.isScheduled === true && q.status === "scheduled") {
    return { ...q, $and: [{ $or: visOr }] };
  }

  return {
    $or: [
      {
        ...q,
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
        ...q,
        isScheduled: true,
        status: "scheduled",
        scheduledFor: { $gt: now },
        sender: me,
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

    // 🔥 CRITICAL FIX: Remove the restrictive team lead query logic
    // Let applyVisibility handle team lead visibility properly
    const currentUserRole = normalizeRole(req.employee?.role || "");
    const isTeamLead = currentUserRole === "team_lead";
    const me = oid(String(req.employee._id));

    // Use normal user visibility rules for everyone - applyVisibility will handle role-based restrictions
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
      // FIX: Handle array receiver properly
      q.$or = [
        { sender: participant },
        { receiver: participant }, // single receiver
        { receiver: { $in: [participant] } }, // array receiver
      ];
    } else {
      if (isObjId(sender)) q.sender = sender;
      if (isObjId(receiver)) {
        // FIX: Handle both single receiver and array receiver
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

    // Apply visibility rules for ALL users including team leads
    const qFinal = await applyVisibility(q, req);

    // Rest of the function remains the same...
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
          { path: "repliedTo", select: "_id note message sender attachments" },
          {
            path: "replyContent.originalSender",
            select: "_id name companyEmail",
          },
        ])
        .lean(),
      WhatsAppMessage.countDocuments(qFinal),
    ]);

    // CRITICAL FIX: Ensure receiver is always treated as array for consistency
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
        { path: "repliedTo", select: "_id note message sender attachments" },
        {
          path: "replyContent.originalSender",
          select: "_id name companyEmail",
        },
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
      .select("_id role supervisor supervisionMode owner")
      .lean();
    const senderRole = normalizeRole(senderDoc?.role || "");

    let approvalStatus;
    const supervisionMode = String(
      senderDoc?.supervisionMode || ""
    ).toLowerCase();
    const needsApproval = supervisionMode === "needs_approval";
    const isDirect = supervisionMode === "direct";

    const Client = require("../models/ClientInfo");
    const clientDoc = await Client.findById(client)
      .populate("assignedTo", "_id role")
      .lean();

    const { tls, managers } = await findTLsAndManagersByOwner(owner);

    // 🔥 CRITICAL CHANGE: TEAM LEAD SENDS TO MANAGER INSTEAD OF ASSIGNED EMPLOYEE
    if (senderRole === "team_lead") {
      
      // Clear any existing receivers (don't use assigned employee)
      receivers = [];
      
      // Add managers as receivers
      if (managers.length > 0) {
        managers.forEach((managerId) => {
          if (!receivers.includes(managerId) && managerId !== String(sender)) {
            receivers.push(managerId);
          }
        });
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
    } 
    // 🔥 CRITICAL UPDATE: Add team leads AND assigned employee as receivers for manager messages
    else if (senderRole === "manager") {
      
      // Add team leads to receivers for supervision visibility
      tls.forEach((teamLeadId) => {
        if (!receivers.includes(teamLeadId) && teamLeadId !== String(sender)) {
          receivers.push(teamLeadId);
        }
      });

      // 🔥 NEW: Add assigned employee as receiver
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
    // 👷 EMPLOYEE LOGIC: Use assigned employee and supervision rules
    else if (senderRole === "employee") {
      // ✅ Include assignedTo employee if present (but only if not already included)
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

    // 🔑 CORRECTED Approval status logic - MATCHING ASSIGNMENT CONTROLLER
    if (senderRole === "manager") {
      approvalStatus = null;
      // Managers don't need approval, but team leads are now included as receivers
    } else if (senderRole === "team_lead") {
      approvalStatus = null;
      // Team leads don't need approval, and we send to managers + CRM
    } else if (needsApproval) {
      // Needs approval - add team leads for review
      approvalStatus = "pending";
      receivers = [...receivers, ...tls.map((id) => String(id))];
    } else if (isDirect) {
      // DIRECT SUPERVISION - NO TEAM LEADS INVOLVED (KEY DIFFERENCE)
      approvalStatus = "approved";
      // Don't add any team leads or managers - message goes directly to intended receivers
    }

    // 🔥 Fallback logic if no receivers are still found
    if (receivers.length === 0) {
      if (senderRole === "employee") {
        if (isDirect) {
          // For direct mode with no receivers, add managers for visibility
          receivers = [...managers];
          approvalStatus = "approved";
        } else {
          // For needs_approval mode with no receivers, add team leads
          receivers = [...tls];
          approvalStatus = "pending";
        }
      } else if (senderRole === "team_lead") {
        // Team lead with no receivers - add managers and CRM as fallback
        receivers = [...managers];

        // Try to add CRM again in fallback
        const crmEmployeeId = process.env.CRM_EMPLOYEE_ID;
        if (crmEmployeeId && !receivers.includes(crmEmployeeId)) {
          receivers.push(crmEmployeeId);
        }

        approvalStatus = null;
        
      } else if (senderRole === "manager") {
        // Manager with no receivers - add team leads
        receivers = [...tls];
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


    // FIXED: Emit real-time events ONLY to relevant users
    if (req.app.get("io")) {
      const io = req.app.get("io");

      // Notify ONLY the actual receivers
      receivers.forEach((receiverId) => {
        io.to(`employee_${receiverId}`).emit("new_message", {
          message: populated,
          type: "new_assignment",
        });
      });

      // Notify ONLY the sender
      io.to(`employee_${sender}`).emit("new_message", {
        message: populated,
        type: "message_created",
      });

      // Special notification for team leads when manager sends message
      if (senderRole === "manager") {
        tls.forEach((teamLeadId) => {
          if (receivers.includes(teamLeadId)) {
            io.to(`employee_${teamLeadId}`).emit("new_message", {
              message: populated,
              type: "manager_message_visibility",
              note: "You are included as a receiver for manager message visibility",
            });
          }
        });

        // Special notification for assigned employee when manager sends message
        if (clientDoc && clientDoc.assignedTo && clientDoc.assignedTo._id) {
          const assignedEmployeeId = String(clientDoc.assignedTo._id);
          if (receivers.includes(assignedEmployeeId)) {
            io.to(`employee_${assignedEmployeeId}`).emit("new_message", {
              message: populated,
              type: "manager_direct_message",
              note: "Manager has sent you a direct message",
            });
          }
        }
      }

      // Special notification for managers when team lead sends message
      if (senderRole === "team_lead") {
        managers.forEach((managerId) => {
          if (receivers.includes(managerId)) {
            io.to(`employee_${managerId}`).emit("new_message", {
              message: populated,
              type: "team_lead_message_to_manager",
              note: "Team Lead has sent you a message regarding client communication",
            });
          }
        });

        // Special notification for CRM when team lead sends message
        const crmEmployeeId = process.env.CRM_EMPLOYEE_ID;
        if (crmEmployeeId && receivers.includes(crmEmployeeId)) {
          io.to(`employee_${crmEmployeeId}`).emit("new_message", {
            message: populated,
            type: "team_lead_message_to_crm",
            note: "Team Lead has sent a message that requires CRM attention",
          });
        }
      }
    }

    res.status(201).json({
      ...populated.toObject(),
      teamLeadsIncluded: senderRole === "manager", // Indicate if team leads were added
      assignedEmployeeIncluded: senderRole === "manager" && clientDoc?.assignedTo ? true : false, // Indicate if assigned employee was added
      crmIncluded: senderRole === "team_lead", // Indicate if CRM was added
      managersIncluded: senderRole === "team_lead", // Indicate if managers were added (for team lead messages)
      totalReceivers: receivers.length,
      receiverSummary: {
        role: senderRole,
        sentToManagers: senderRole === "team_lead",
        sentToTeamLeads: senderRole === "manager", 
        sentToAssignedEmployee: senderRole === "manager" && clientDoc?.assignedTo ? true : false,
        sentToCRM: senderRole === "team_lead"
      }
    });
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

    // 🔥 CRITICAL FIX: Emit events to ALL relevant users
    if (req.app.get("io")) {
      const io = req.app.get("io");

      // Create the updated message object for real-time emission
      const updatedMessage = {
        ...populatedMsg.toObject(),
        approvalStatus: "approved",
      };


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
        };

        const forwardMsg = await WhatsAppMessage.create(forwardMsgData);

        const populatedForward = await forwardMsg.populate([
          { path: "owner", select: "_id name companyEmail" },
          { path: "sender", select: "_id name companyEmail role" },
          { path: "receiver", select: "_id name companyEmail role" },
          { path: "client", select: "_id clientName" },
          { path: "forwardedBy", select: "_id name companyEmail" },
          { path: "replyContent.originalSender", select: "_id name companyEmail" },
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
              // Include context about the reply chain
              replyContext: msg.isReply ? {
                hasOriginalThread: true,
                originalSender: msg.replyContent?.originalSender,
                repliedToMessage: msg.repliedTo?._id
              } : null
            });
          });
        }

        return res.json({
          ...populatedMsg.toObject(),
          forwardedToManagers: true,
          forwardedMessage: populatedForward,
          message: "Message approved and forwarded to managers",
          // Include reply context in response
          replyContext: msg.isReply ? {
            includedReplyContent: true,
            originalThreadPreserved: true
          } : null
        });
      }
    }

    return res.json({
      ...populatedMsg.toObject(),
      message: "Message approved successfully",
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

    // 🔥 CRITICAL FIX: Emit events to ALL relevant users
    if (req.app.get("io")) {
      const io = req.app.get("io");

      // Create the updated message object for real-time emission
      const updatedMessage = {
        ...populatedMsg.toObject(),
        approvalStatus: "disapproved",
      };


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
      ...populatedMsg.toObject(),
      message: "Message disapproved successfully",
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

    // 🔥 CRITICAL FIX 1: Use normalized role comparison
    const isTeamLead = currentUserRole === "team_lead";

    // 🔥 CRITICAL FIX 2: Proper sender ID comparison
    const isSender = msg.sender && String(msg.sender._id) === currentUserId;

    // 🔥 CRITICAL FIX 3: Enhanced permission check
    if (!isSender && !isTeamLead) {
      return res.status(403).json({
        error:
          "You can only edit your own messages or messages pending your approval",
      });
    }

    // Team leads can only edit messages pending their approval or disapproved messages
    if (isTeamLead && !isSender) {
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

    // 🔥 ENHANCED APPROVAL WORKFLOW LOGIC
    if (hasContentChanges) {
      if (isTeamLead && !isSender) {
        // Team Lead editing someone else's message - AUTO APPROVE
        msg.approvalStatus = "approved";
      } else if (isSender) {
        // Original sender editing their own message
        if (msg.approvalStatus === "disapproved") {          
          msg.approvalStatus = "pending";
        } else if (msg.approvalStatus === "approved") {
          // If already approved and sender edits, keep it approved
          msg.approvalStatus = "approved";
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
    };

    // 🔥 NEW: FORWARD TO MANAGERS WHEN TEAM LEAD EDITS AND APPROVES
    // 🔥 CRITICAL: PRESERVE REPLYTO AND THREAD INFO LIKE IN APPROVE FUNCTION
    let forwardedMessage = null;
    if (
      hasContentChanges &&
      isTeamLead &&
      !isSender &&
      msg.approvalStatus === "approved"
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
            };

            const forwardMsg = await WhatsAppMessage.create(forwardMsgData);

            forwardedMessage = await forwardMsg.populate([
              { path: "owner", select: "_id name companyEmail" },
              { path: "sender", select: "_id name companyEmail role" },
              { path: "receiver", select: "_id name companyEmail role" },
              { path: "client", select: "_id clientName" },
              { path: "forwardedBy", select: "_id name companyEmail" },
              { path: "replyContent.originalSender", select: "_id name companyEmail" },
              { path: "repliedTo", select: "_id note message sender attachments" },
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
              // Include reply context
              replyContext: msg.isReply ? {
                hasOriginalThread: true,
                originalSender: msg.replyContent?.originalSender,
                repliedToMessage: msg.repliedTo?._id
              } : null
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
          });
        });

        // If auto-approved by Team Lead, also notify managers (if not already forwarded)
        if (isTeamLead && !isSender && !forwardedMessage) {
          const { managers } = await findTLsAndManagersByOwner(msg.owner);
          managers.forEach((managerId) => {
            io.to(`employee_${managerId}`).emit("new_message", {
              message: responseData,
              type: "new_approved_message",
            });
          });
        }
      } else if (msg.approvalStatus === "pending") {

        // Notify ALL involved users about pending status
        involvedUsersArray.forEach((userId) => {
          io.to(`employee_${userId}`).emit("new_message", {
            message: responseData,
            type: "message_updated",
            action: "pending_approval",
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
    } else if (msg.approvalStatus === "pending") {
      responseMessage = "Message updated and sent for approval";
    } else if (msg.approvalStatus === "approved" && isSender) {
      responseMessage = "Message updated (already approved)";
    }

    // Build final response
    const finalResponse = {
      message: responseMessage,
      data: responseData,
      approvalStatus: msg.approvalStatus,
      editedBy: currentUserRole,
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
        hasReplyContent: !!msg.replyContent
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
