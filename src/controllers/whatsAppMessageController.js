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
/** ---------- HIERARCHY-BASED SUPERVISOR LOOKUP ---------- **/
const EmployeeHierarchy = require("../models/EmployeeHierarchy");

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

    // 🔥 HIERARCHY-BASED: Get all juniors where this team lead is the senior
    const juniorLinks = await EmployeeHierarchy.find({
      owner: ownerId,
      senior: me,
    })
      .select("junior")
      .lean();
    const juniorIds = juniorLinks.map((link) => oid(link.junior));

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
        // 🔥 HIERARCHY-BASED: Allow supervisors to see pending messages from their juniors
        ...(juniorIds.length > 0
          ? [
            {
              sender: { $in: juniorIds },
              approvalStatus: "pending",
              owner: ownerId,
            },
          ]
          : []),
        // 🔥 Allow team leads to see messages from clients requiring approval
        {
          approvalStatus: "pending",
          owner: ownerId,
        },
      ],
    };

    // CRITICAL FIX: Combine original query with visibility conditions using $and
    // This preserves the text search while applying visibility rules
    return {
      $and: [q, visibilityConditions],
    };
  }

  // 🔥 HIERARCHY-BASED: Check if this employee is a supervisor in the hierarchy
  // Supervisors should see pending messages from their juniors even if they're not Team Leads
  const juniorLinksSupervisor = await EmployeeHierarchy.find({
    owner: ownerId,
    senior: me,
  })
    .select("junior")
    .lean();
  const juniorIdsSupervisor = juniorLinksSupervisor.map((link) =>
    oid(link.junior)
  );

  if (juniorIdsSupervisor.length > 0) {
    // This employee has subordinates - they can see their juniors' pending messages
    const now = new Date();
    const visOr = [
      { sender: me },
      { receiver: me },
      { receiver: { $in: [me] } },
      // 🔥 HIERARCHY-BASED: Supervisor can see pending messages from juniors
      {
        sender: { $in: juniorIdsSupervisor },
        approvalStatus: "pending",
        owner: ownerId,
      },
    ];

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

    return {
      $and: [q, scheduledVisibility],
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
      limit = 5,
      page = 1,
      cursor,
      direction = "after",
      between: betweenRaw,
      filter,
      approvalStatus,
      // 🔥 NEW: Add client employee filter
      clientEmployeeId,
      isClientEmployeeMessage,
      // 🔥 NEW: Add conversation type parameter
      conversationType, // "client" or "client_employee"
    } = req.query;

    const q = {};

    // Owner / client scope
    if (isObjId(owner)) q.owner = owner;
    else if (req.employee?.owner) q.owner = req.employee.owner;
    if (isObjId(client)) q.client = client;

    // 🔥 ENHANCED: Handle conversation type separation
    if (conversationType) {
      if (conversationType === "client") {
        // Only show direct client messages (not client employee messages)
        q.isClientEmployeeMessage = false;
      } else if (conversationType === "client_employee") {
        // Only show client employee messages
        q.isClientEmployeeMessage = true;
      }
    } else {
      // 🔥 NEW: Default behavior - separate messages if clientEmployeeId is provided
      if (clientEmployeeId) {
        // If specific client employee is requested, show only their messages
        q.clientEmployeeId = clientEmployeeId;
        q.isClientEmployeeMessage = true;
      } else if (isClientEmployeeMessage !== undefined) {
        // If isClientEmployeeMessage filter is explicitly set
        q.isClientEmployeeMessage = isClientEmployeeMessage === "true";
      } else {
        // Default: show both types but we'll separate them in response
        // We'll handle separation in the query based on context
      }
    }

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

    // 🔥 ENHANCED: Handle participant filtering based on conversation type
    if (between.length === 2) {
      const [a, b] = between;
      // Check if this is a client employee conversation
      const Client = require("../models/ClientInfo");
      // Check if either participant is a client employee
      const clientDoc = await Client.findOne({
        _id: client,
        "companyEmployees._id": { $in: [a, b] },
      }).lean();

      if (clientDoc) {
        // Find which employee ID matches
        const employee = clientDoc.companyEmployees.find(
          (emp) => emp._id.toString() === a || emp._id.toString() === b,
        );
        if (employee) {
          q.isClientEmployeeMessage = true;
          q.clientEmployeeId = employee._id;
        }
      }

      q.$or = [
        { sender: a, receiver: { $in: [b] } },
        { sender: b, receiver: { $in: [a] } },
        { sender: a, receiver: b },
        { sender: b, receiver: a },
      ];
    } else if (isObjId(participant)) {
      // Check if participant is a client employee
      const Client = require("../models/ClientInfo");
      const clientDoc = await Client.findOne({
        _id: client,
        "companyEmployees._id": participant,
      }).lean();

      if (clientDoc) {
        const employee = clientDoc.companyEmployees.find(
          (emp) => emp._id.toString() === participant,
        );
        if (employee) {
          q.isClientEmployeeMessage = true;
          q.clientEmployeeId = employee._id;
        }
      }

      q.$or = [
        { sender: participant },
        { receiver: participant },
        { receiver: { $in: [participant] } },
      ];
    } else {
      if (isObjId(sender)) {
        // Check if sender is client employee
        const Client = require("../models/ClientInfo");
        const clientDoc = await Client.findOne({
          _id: client,
          "companyEmployees._id": sender,
        }).lean();

        if (clientDoc) {
          const employee = clientDoc.companyEmployees.find(
            (emp) => emp._id.toString() === sender,
          );
          if (employee) {
            q.isClientEmployeeMessage = true;
            q.clientEmployeeId = employee._id;
          }
        }

        q.sender = sender;
      }

      if (isObjId(receiver)) {
        // Check if receiver is client employee
        const Client = require("../models/ClientInfo");
        const clientDoc = await Client.findOne({
          _id: client,
          "companyEmployees._id": receiver,
        }).lean();

        if (clientDoc) {
          const employee = clientDoc.companyEmployees.find(
            (emp) => emp._id.toString() === receiver,
          );
          if (employee) {
            q.isClientEmployeeMessage = true;
            q.clientEmployeeId = employee._id;
          }
        }

        q.$or = [{ receiver: receiver }, { receiver: { $in: [receiver] } }];
      }
    }

    // Apply visibility rules
    const qFinal = await applyVisibility(q, req);

    // 🎯 Cursor-based pagination logic
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

    // Fetch with limit + 1 for pagination check
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

    // 🎯 Pagination metadata
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

    // 🔥 ENHANCED: Get client supervision info and employee data
    const Client = require("../models/ClientInfo");

    // 🔥 HIERARCHY-BASED: Get current user's ID for approval checking
    const currentUserId = String(req.employee._id);

    const normalizedItems = await Promise.all(
      items.map(async (item) => {
        // Get client supervision info
        let clientSupervision = "direct";
        let clientName = "Unknown";
        let displayName = clientName;
        let employeeData = null;
        let conversationType = "client";

        if (item.client) {
          const clientDoc = await Client.findById(item.client)
            .select("supervision clientName companyEmployees")
            .lean();
          clientSupervision = clientDoc?.supervision || "direct";
          clientName = clientDoc?.clientName || "Unknown";
          displayName = clientName;

          // 🔥 CRITICAL FIX: Check if this is a client employee message
          if (item.isClientEmployeeMessage && item.clientEmployeeId) {
            // Find the employee in the companyEmployees array
            if (
              clientDoc.companyEmployees &&
              clientDoc.companyEmployees.length > 0
            ) {
              const employee = clientDoc.companyEmployees.find(
                (emp) =>
                  emp._id.toString() === item.clientEmployeeId.toString(),
              );

              if (employee) {
                // 🔥 SET EMPLOYEE NAME AS DISPLAY NAME
                displayName = employee.name;
                employeeData = {
                  name: employee.name,
                  designation: employee.designation,
                  email: employee.email,
                  phone: employee.phone,
                  department: employee.department,
                  isPrimaryContact: employee.isPrimaryContact,
                };
                conversationType = "client_employee";
              }
            }
          }

          // Also check sender/receiver for employee IDs
          if (!employeeData && item.isClientEmployeeMessage) {
            const senderId = item.sender?._id?.toString();
            const receiverId = item.receiver?._id?.toString();

            if (
              clientDoc.companyEmployees &&
              clientDoc.companyEmployees.length > 0
            ) {
              const employee = clientDoc.companyEmployees.find(
                (emp) =>
                  emp._id.toString() === senderId ||
                  emp._id.toString() === receiverId,
              );

              if (employee) {
                displayName = employee.name;
                employeeData = {
                  name: employee.name,
                  designation: employee.designation,
                  email: employee.email,
                  phone: employee.phone,
                  department: employee.department,
                  isPrimaryContact: employee.isPrimaryContact,
                };
                conversationType = "client_employee";
              }
            }
          }
        }

        return {
          ...item,
          receiver: Array.isArray(item.receiver)
            ? item.receiver
            : [item.receiver].filter(Boolean),
          // 🔥 ADD CONVERSATION TYPE INFO
          clientSupervision: clientSupervision,
          requiresApproval: clientSupervision === "needs_approval",
          clientName: clientName,
          // 🔥 CRITICAL: Use employee name for display if it's an employee conversation
          displayName: displayName, // This will be employee name for employee chats
          // 🔥 ENHANCED: Add conversation type identification
          parentClientId: item.client?._id || item.client, // Ensure parentClientId is present
          conversationType: conversationType,
          isClientEmployeeMessage: conversationType === "client_employee",
          clientEmployeeData: employeeData,
        };
      }),
    );

    const total = await WhatsAppMessage.countDocuments(qFinal);
    const pageNum = Math.max(parseInt(page, 10) || 1, 1);

    res.json({
      items: normalizedItems, // 🔥 ALWAYS return flat array for compatibility
      separatedItems: {
        clientMessages: normalizedItems.filter(i => i.conversationType === "client"),
        clientEmployeeMessages: normalizedItems.filter(i => i.conversationType === "client_employee")
      },
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
      // 🔥 NEW: Add conversation context
      conversationContext: {
        clientId: client,
        clientEmployeeId: clientEmployeeId,
        conversationType:
          conversationType || (clientEmployeeId ? "client_employee" : "client"),
      },
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to fetch assignment messages" });
  }
};
exports.listMessagesForManager = async function listMessagesForManager(
  req,
  res,
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
            parentClientId: message.client?._id || message.client, // Ensure parentClientId is present
            clientSupervision: clientDoc?.supervision || "direct",
            clientName: clientDoc?.clientName || "Unknown",
            requiresApproval: clientDoc?.supervision === "needs_approval",
          };
        }
        return message;
      }),
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
        "_id note message subject sender client createdAt receiver status isClientEmployeeMessage clientEmployeeData",
      )
      .lean();

    // 🔥 Format response with client employee info
    const items = messages.map((m) => {
      // Extract client employee name if available
      let displayClientName = m.client?.clientName || "Unknown";
      let isClientEmployee = m.isClientEmployeeMessage || false;
      let clientEmployeeName = null;

      if (isClientEmployee && m.clientEmployeeData) {
        clientEmployeeName = m.clientEmployeeData.clientEmployeeName;
        // Show client employee name in search results
        displayClientName = `${clientEmployeeName} (${displayClientName} employee)`;
      }

      return {
        _id: m._id,
        note: m.note || m.message || "",
        subject: m.subject || "",
        sender: m.sender
          ? {
            _id: m.sender._id,
            name: m.sender.name || "Unknown",
          }
          : { _id: null, name: "Unknown" },
        clientId: m.client?._id || m.client || null,
        parentClientId: m.client?._id || m.client || null,
        clientEmployeeId: m.clientEmployeeId || (m.clientEmployeeData ? m.clientEmployeeData.clientEmployeeId : null),
        clientName: displayClientName,
        // 🔥 ADD ORIGINAL CLIENT INFO
        originalClientName: m.client?.clientName || "Unknown",
        isClientEmployeeMessage: isClientEmployee,
        clientEmployeeName: clientEmployeeName,
        clientEmployeeData: m.clientEmployeeData,
        time: m.createdAt
          ? new Date(m.createdAt).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          })
          : "",
        timestamp: m.createdAt || new Date(),
        status: m.status || "sent",
      };
    });

    return res.json({
      items,
      count: items.length,
      query: searchQuery,
    });
  } catch (e) {
    console.error("❌ Search failed:", e);
    res.status(500).json({
      error: "Search failed",
      items: [],
    });
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
      message: `Message ${action === "send" ? "sent immediately" : "converted to draft"
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
  io = null,
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
            typeof receiver === "string" ? receiver : receiver._id,
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
          error,
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

    const Client = require("../models/ClientInfo");
    const client = await Client.findById(msg.client)
      .select("supervision")
      .lean();
    const clientSupervision = client?.supervision || "direct";

    if (clientSupervision !== "needs_approval") {
      return res.status(400).json({
        error: "This client uses direct supervision. Approval not required.",
        clientSupervision: clientSupervision,
      });
    }

    const userRole = normalizeRole(req.employee?.role || "");
    const currentUserId = String(req.employee?._id);
    const ownerId = msg.owner;
    const isReceiver = msg.receiver.some((r) => String(r._id || r) === currentUserId);

    if (userRole !== "team_lead" && !isReceiver) {
      return res
        .status(403)
        .json({ error: "Only Team Leads or designated supervisors can approve messages" });
    }

    // 🔥 HIERARCHY-BASED: Check if current approver has a senior in hierarchy
    const nextSupervisors = await findSupervisorsFromHierarchy(ownerId, currentUserId);
    const hasNextLevel = nextSupervisors.length > 0;

    let approvalFinalized = false;
    let responseStatusMessage = "Message approved successfully";

    if (hasNextLevel) {
      // Move up to next level - keep status pending, update receivers
      msg.approvalStatus = "pending";
      msg.receiver = nextSupervisors;
      responseStatusMessage = "Message approved and moved to next level supervisor";
    } else {
      // At top of hierarchy or no hierarchy - finalize approval
      msg.approvalStatus = "approved";
      approvalFinalized = true;
    }

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
      approvalStatus: msg.approvalStatus,
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

      // Add the person who just approved
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
          hasNextLevel: hasNextLevel,
          nextSupervisors: nextSupervisors,
        });
      });
    }

    // ✅ Forward to Managers ONLY if approval is completely finalized
    if (approvalFinalized) {
      const senderRole = normalizeRole(msg.sender?.role || "");
      if (senderRole === "employee") {
        const { managers } = await findTLsAndManagersByOwner(msg.owner);
        if (managers.length > 0) {
          // 🔥 Forward to Managers
          const forwardMsgData = {
            owner: msg.owner,
            client: msg.client,
            sender: msg.sender,
            receiver: managers,
            subject: `Approved: ${msg.subject || "No Subject"}`,
            note: msg.note || "",
            attachments: msg.attachments,
            approvalStatus: "approved",
            isReply: msg.isReply,
            repliedTo: msg.repliedTo,
            replyContent: msg.replyContent,
            isClientEmployeeMessage: msg.isClientEmployeeMessage,
            clientEmployeeId: msg.clientEmployeeId,
            clientEmployeeData: msg.clientEmployeeData,
            isForwarded: true,
            originalMessage: msg._id,
            forwardedBy: req.employee._id,
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

          const populatedForwardWithEmployeeInfo = {
            ...populatedForward.toObject(),
            isClientEmployeeMessage: msg.isClientEmployeeMessage,
            clientEmployeeId: msg.clientEmployeeId,
            clientEmployeeData: msg.clientEmployeeData,
          };

          if (req.app.get("io")) {
            const io = req.app.get("io");
            managers.forEach((managerId) => {
              io.to(`employee_${managerId}`).emit("new_message", {
                message: populatedForwardWithEmployeeInfo,
                type: "new_message",
                action: "forwarded_approved",
                forwardedBy: req.employee._id,
                originalMessageId: msg._id,
                clientSupervision: clientSupervision,
              });
            });
          }

          return res.json({
            ...updatedMessage,
            forwardedToManagers: true,
            forwardedMessage: populatedForwardWithEmployeeInfo,
            message: "Message approved and forwarded to managers",
            clientSupervision: clientSupervision,
          });
        }
      }
    }

    return res.json({
      ...updatedMessage,
      message: responseStatusMessage,
      clientSupervision: clientSupervision,
      hasNextLevel: hasNextLevel,
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
    const currentUserId = String(req.employee?._id);
    const isReceiver = msg.receiver.some((r) => String(r._id || r) === currentUserId);

    if (userRole !== "team_lead" && !isReceiver) {
      return res
        .status(403)
        .json({ error: "Only Team Leads or designated supervisors can disapprove messages" });
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

      // 🔒 REMOVED PUBLIC BROADCAST TO PREVENT PRIVACY LEAKS
      /*
      if (msg.client && msg.client._id) {
        io.to(`client_${msg.client._id}`).emit("new_message", {
          message: updatedMessage,
          type: "message_updated",
          action: "disapproved",
        });
      }
      */
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
    const isManager = currentUserRole === "manager";
    const isEmployee = currentUserRole === "employee";

    // 🔥 CRITICAL FIX 2: Proper sender ID comparison
    const isSender = msg.sender && String(msg.sender._id) === currentUserId;

    // 🔥 CRITICAL FIX 3: Get original sender's role
    const originalSenderRole = msg.sender
      ? normalizeRole(msg.sender.role || "")
      : "";
    const isOriginalSenderManager = originalSenderRole === "manager";
    const isOriginalSenderTeamLead = originalSenderRole === "team_lead";
    const isOriginalSenderEmployee = originalSenderRole === "employee";

    // 🔥 CRITICAL FIX 4: Enhanced permission check with client supervision
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

    // 🔥 CRITICAL FIX: ENHANCED APPROVAL WORKFLOW LOGIC WITH CLIENT SUPERVISION
    // THIS IS THE SINGLE PLACE WHERE APPROVAL STATUS SHOULD BE SET
    if (hasContentChanges) {
      // CASE 1: Team Lead editing someone else's message
      if (isTeamLead && !isSender && clientRequiresApproval) {
        // Team Lead editing someone else's message for client that requires approval - AUTO APPROVE
        msg.approvalStatus = "approved";
      }
      // CASE 2: Original sender editing their own message
      else if (isSender) {
        // 🔥 CRITICAL: Managers and Team Leads should NEVER need approval when editing their own messages
        if (isOriginalSenderManager || isOriginalSenderTeamLead) {
          msg.approvalStatus = null; // No approval needed
        }
        // Employee editing their own message
        else if (isOriginalSenderEmployee) {
          if (msg.approvalStatus === "disapproved") {
            // Employee's message was disapproved - needs re-approval
            msg.approvalStatus = clientRequiresApproval
              ? "pending"
              : "approved";
          } else if (msg.approvalStatus === "approved") {
            // Already approved - keep it approved
            msg.approvalStatus = "approved";
          } else if (!msg.approvalStatus && clientRequiresApproval) {
            // No approval status yet and client requires approval
            msg.approvalStatus = "pending";
          }
          // If pending, remains pending
        }
      }
      // CASE 3: Team Lead editing their own message
      else if (isTeamLead && isSender) {
        // Team Lead editing their own message - no approval needed
        msg.approvalStatus = null;
      }
      // CASE 4: Manager editing (not original sender)
      else if (isManager && !isSender && clientRequiresApproval) {
        // Manager editing someone else's message
        if (isOriginalSenderEmployee) {
          // Manager editing an employee's message - needs approval if client requires it
          msg.approvalStatus = "pending";
        } else {
          // Manager editing another manager or team lead's message - no approval needed
          msg.approvalStatus = null;
        }
      }

      // 🔥 ADDITIONAL FIX: Ensure Managers and Team Leads never get "pending" status
      if (msg.approvalStatus === "pending") {
        const isSenderManagerOrLead =
          isOriginalSenderManager || isOriginalSenderTeamLead;
        const isEditorManagerOrLead = isManager || isTeamLead;

        if (isSenderManagerOrLead || isEditorManagerOrLead) {
          msg.approvalStatus = null;
        }
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
      // ✅ Forward only if sender was an Employee under supervision
      if (isOriginalSenderEmployee) {
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
              forwardError,
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

      // 🔒 REMOVED PUBLIC BROADCAST TO PREVENT PRIVACY LEAKS
      /*
      if (msg.client && msg.client._id) {
        io.to(`client_${msg.client._id}`).emit("new_message", {
          message: responseData,
          type: "message_updated",
          action: "edited",
        });
      }
      */

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
    } else if (msg.approvalStatus === null && (isManager || isTeamLead)) {
      responseMessage =
        "Message updated (no approval needed for manager/team lead)";
    }

    // Build final response
    const finalResponse = {
      message: responseMessage,
      data: responseData,
      approvalStatus: msg.approvalStatus,
      editedBy: currentUserRole,
      clientSupervision: clientSupervision,
      requiresApproval: clientRequiresApproval,
      // 🔥 ADD DEBUG INFO
      debug: {
        currentUserRole,
        originalSenderRole,
        isSender,
        hasContentChanges,
        clientRequiresApproval,
      },
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
      200,
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
      (receiverId) => String(receiverId) === String(currentUserId),
    );

    if (!isReceiver) {
      return res
        .status(403)
        .json({ error: "You are not a receiver of this message" });
    }

    // Check if already seen
    const alreadySeen = msg.seenBy.some(
      (seen) => String(seen.employee) === String(currentUserId),
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
        (seen) => String(seen.employee) === String(currentUserId),
      );
      if (!isSeen) {
        totalUnread++;
      }
    });

    res.json({
      totalUnreadCount: totalUnread,
      message: `You have ${totalUnread} unread message${totalUnread !== 1 ? "s" : ""
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

      const { clientEmployeeId, isClientEmployeeMessage } = req.query;

      if (!isObjId(clientId)) {
        return res.status(400).json({ error: "Valid client ID required" });
      }

      const q = {
        client: clientId,
        receiver: currentUserId,
        // Exclude messages sent by current user
        sender: { $ne: currentUserId },
      };

      if (isClientEmployeeMessage === "true" && clientEmployeeId) {
        q.isClientEmployeeMessage = true;
        q.clientEmployeeId = clientEmployeeId;
      } else if (isClientEmployeeMessage === "false") {
        q.isClientEmployeeMessage = false;
      }

      // Get all messages for this client/employee where current user is a receiver
      const messages = await WhatsAppMessage.find(q).select("_id seenBy");

      // Check if any message is unread
      const hasUnreadMessages = messages.some(
        (message) =>
          !message.seenBy.some(
            (seen) => String(seen.employee) === String(currentUserId),
          ),
      );

      res.json({
        clientId,
        hasUnreadMessages,
        totalMessages: messages.length,
        unreadCount: messages.filter(
          (message) =>
            !message.seenBy.some(
              (seen) => String(seen.employee) === String(currentUserId),
            ),
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
    const { clientEmployeeId, isClientEmployeeMessage } = req.body || {};
    const currentUserId = req.employee._id;

    if (!isObjId(clientId)) {
      return res.status(400).json({ error: "Valid client ID required" });
    }

    const q = {
      client: clientId,
      receiver: currentUserId,
      sender: { $ne: currentUserId }, // Exclude own messages
      "seenBy.employee": { $ne: currentUserId }, // Not already seen
    };

    if (isClientEmployeeMessage === true && clientEmployeeId) {
      q.isClientEmployeeMessage = true;
      q.clientEmployeeId = clientEmployeeId;
    } else if (isClientEmployeeMessage === false) {
      q.isClientEmployeeMessage = false;
    }

    // Find all unread messages for this client/employee where current user is a receiver
    const unreadMessages = await WhatsAppMessage.find(q);

    // Mark each message as seen
    const updatePromises = unreadMessages.map(async (message) => {
      // Check if user already seen this message (double check)
      const alreadySeen = message.seenBy.some(
        (seen) => String(seen.employee) === String(currentUserId),
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
        "_id note message subject sender client createdAt receiver status",
      )
      .lean();

    // Debug: Log first few messages
    if (messages.length > 0) {
      messages.slice(0, 3).forEach((msg, i) => { });
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
      // 🔥 NEW: Add client employee fields
      isClientEmployeeMessage,
      clientEmployeeId,
      parentClientId,
      clientEmployeeName,
      clientEmployeeDesignation,
    } = req.body;

    const owner = ownerBody || req.employee?.owner;
    const sender = senderBody || req.employee?._id;

    if (!isObjId(owner) || !isObjId(sender)) {
      return res.status(400).json({
        error: "owner and sender are required (ObjectId strings)",
      });
    }

    // 🔥 CRITICAL: Determine if this is a client employee message
    let actualClientId = client;
    let isClientEmployeeChat = false;
    let clientEmployeeData = null;

    // Check if this is a client employee chat
    if (isClientEmployeeMessage && clientEmployeeId && parentClientId) {
      isClientEmployeeChat = true;
      actualClientId = parentClientId; // Use parent client ID for storage

      // Store client employee info in message metadata
      clientEmployeeData = {
        clientEmployeeId,
        clientEmployeeName,
        clientEmployeeDesignation,
        parentClientId,
        parentClientName: null, // Will be populated below
      };
    }

    // Validate client ID based on message type
    if (!isObjId(actualClientId)) {
      return res.status(400).json({
        error: isClientEmployeeChat
          ? "parentClientId is required for client employee messages"
          : "client is required (ObjectId string)",
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

    // 🔥 CLIENT-BASED SUPERVISION: Get supervision mode from CLIENT
    const Client = require("../models/ClientInfo");
    const clientDoc = await Client.findById(actualClientId)
      .populate("assignedTo", "_id role name companyEmail")
      .lean();

    if (!clientDoc) {
      return res.status(404).json({
        error: isClientEmployeeChat
          ? "Parent client not found"
          : "Client not found",
      });
    }

    // Use client's supervision setting, fallback to "direct" if not set
    const clientSupervision = clientDoc?.supervision || "direct";
    const needsApproval = clientSupervision === "needs_approval";
    const isDirect = clientSupervision === "direct";

    // 🔥 UPDATE: Populate parent client name for client employee messages
    if (isClientEmployeeChat) {
      clientEmployeeData.parentClientName = clientDoc.clientName;
    }

    const { tls, managers } = await findTLsAndManagersByOwner(owner);

    // 🔥 GET ASSIGNED EMPLOYEES FROM CLIENT
    let assignedEmployeeIds = [];
    if (clientDoc?.assignedTo && Array.isArray(clientDoc.assignedTo)) {
      assignedEmployeeIds = clientDoc.assignedTo
        .filter((emp) => emp && emp._id)
        .map((emp) => String(emp._id));
    } else if (clientDoc?.assignedTo && clientDoc.assignedTo._id) {
      assignedEmployeeIds = [String(clientDoc.assignedTo._id)];
    }

    // 🔥 TEAM LEAD LOGIC - SEND TO MANAGERS AND ASSIGNED EMPLOYEES
    if (senderRole === "team_lead") {
      receivers = [];

      // Add managers as receivers
      if (managers.length > 0) {
        managers.forEach((managerId) => {
          if (!receivers.includes(managerId) && managerId !== String(sender)) {
            receivers.push(managerId);
          }
        });
      }

      // Add assigned employees as receivers
      if (assignedEmployeeIds.length > 0) {
        assignedEmployeeIds.forEach((employeeId) => {
          if (
            employeeId &&
            employeeId !== String(sender) &&
            !receivers.includes(employeeId)
          ) {
            receivers.push(employeeId);
          }
        });
      }

      // Get CRM employee ID
      const crmEmployeeId = process.env.CRM_EMPLOYEE_ID;
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

      approvalStatus = null;
    }
    // 🔥 MANAGER LOGIC - SEND TO TEAM LEADS AND ASSIGNED EMPLOYEES
    else if (senderRole === "manager") {
      // Add team leads to receivers
      tls.forEach((teamLeadId) => {
        if (!receivers.includes(teamLeadId) && teamLeadId !== String(sender)) {
          receivers.push(teamLeadId);
        }
      });

      // Add assigned employees
      if (assignedEmployeeIds.length > 0) {
        assignedEmployeeIds.forEach((employeeId) => {
          if (
            employeeId &&
            employeeId !== String(sender) &&
            !receivers.includes(employeeId)
          ) {
            receivers.push(employeeId);
          }
        });
      }

      approvalStatus = null;
    }
    // 👷 EMPLOYEE LOGIC: Use assigned employees
    else if (senderRole === "employee") {
      if (assignedEmployeeIds.length > 0) {
        assignedEmployeeIds.forEach((employeeId) => {
          if (
            employeeId &&
            employeeId !== String(sender) &&
            !receivers.includes(employeeId)
          ) {
            receivers.push(employeeId);
          }
        });
      }
    }

    // 🔥 FIXED: Handle reply scenario
    if (isReply && repliedTo) {
      try {
        const originalMessage = await WhatsAppMessage.findById(repliedTo)
          .populate("sender receiver", "_id role name companyEmail")
          .lean();

        if (originalMessage) {
          const originalReceivers = originalMessage.receiver.map((r) =>
            typeof r === "object" ? String(r._id) : String(r),
          );

          originalReceivers.forEach((receiverId) => {
            if (
              receiverId !== String(sender) &&
              !receivers.includes(receiverId)
            ) {
              receivers.push(receiverId);
            }
          });

          const originalSenderId = originalMessage.sender
            ? typeof originalMessage.sender === "object"
              ? String(originalMessage.sender._id)
              : String(originalMessage.sender)
            : null;

          let originalSenderRole = "";
          if (originalSenderId) {
            const originalSenderDoc = await Employee.findById(originalSenderId)
              .select("role")
              .lean();
            originalSenderRole = normalizeRole(originalSenderDoc?.role || "");
          }

          // Employee replying to Manager
          if (senderRole === "employee" && originalSenderRole === "manager") {
            receivers = receivers.filter(
              (id) => id !== String(originalSenderId),
            );

            if (needsApproval) {
              // 🔥 HIERARCHY-BASED: Find supervisor from hierarchy first
              const hierarchySupervisors = await findSupervisorsFromHierarchy(
                owner,
                String(sender)
              );

              if (hierarchySupervisors.length > 0) {
                // Use hierarchy-based supervisors
                receivers = [];
                receivers = [...hierarchySupervisors];
                approvalStatus = "pending";
              } else if (tls.length > 0) {
                // Fallback to all team leads if no hierarchy is set
                receivers = [];
                receivers = [...tls];
                approvalStatus = "pending";
              }
            } else if (isDirect) {
              if (originalSenderId && !receivers.includes(originalSenderId)) {
                receivers.push(originalSenderId);
              }
              approvalStatus = "approved";
            }
          }
          // Team Lead replying to Manager
          else if (
            senderRole === "team_lead" &&
            originalSenderRole === "manager"
          ) {
            approvalStatus = null;
            if (assignedEmployeeIds.length > 0) {
              assignedEmployeeIds.forEach((employeeId) => {
                if (employeeId && !receivers.includes(employeeId)) {
                  receivers.push(employeeId);
                }
              });
            }
          }
          // Manager replying to Employee
          else if (
            senderRole === "manager" &&
            originalSenderRole === "employee"
          ) {
            approvalStatus = null;
            if (assignedEmployeeIds.length > 0) {
              assignedEmployeeIds.forEach((employeeId) => {
                if (employeeId && !receivers.includes(employeeId)) {
                  receivers.push(employeeId);
                }
              });
            }
          }
          // Employee replying to Employee
          else if (
            senderRole === "employee" &&
            originalSenderRole === "employee"
          ) {
            // No special handling needed
          }
          // Team Lead replying (add assigned employees)
          else if (
            senderRole === "team_lead" &&
            assignedEmployeeIds.length > 0
          ) {
            assignedEmployeeIds.forEach((employeeId) => {
              if (employeeId && !receivers.includes(employeeId)) {
                receivers.push(employeeId);
              }
            });
          }

          if (
            originalSenderId &&
            originalSenderId !== String(sender) &&
            !receivers.includes(originalSenderId) &&
            !(
              senderRole === "employee" &&
              originalSenderRole === "manager" &&
              needsApproval
            )
          ) {
            receivers.push(originalSenderId);
          }
        }
      } catch (replyError) {
        console.warn("Failed to process reply context:", replyError);
      }
    }

    // 🔥 CORRECTED Approval status logic
    if (approvalStatus === undefined) {
      if (senderRole === "manager") {
        approvalStatus = null;
      } else if (senderRole === "team_lead") {
        approvalStatus = null;
      } else if (needsApproval) {
        approvalStatus = "pending";
        // 🔥 HIERARCHY-BASED: Find supervisor from hierarchy first
        const senderHierarchySupervisors = await findSupervisorsFromHierarchy(
          owner,
          String(sender)
        );

        if (senderHierarchySupervisors.length > 0) {
          // Use hierarchy-based supervisors
          receivers = [...receivers, ...senderHierarchySupervisors];
        } else if (tls.length > 0) {
          // Fallback to all team leads if no hierarchy is set
          receivers = [...receivers, ...tls.map((id) => String(id))];
        }
      } else if (isDirect) {
        approvalStatus = "approved";
      }
    }

    // 🔥 Filter out invalid receiver IDs
    receivers = Array.from(new Set(receivers.map((id) => String(id)))).filter(
      (id) =>
        id &&
        id !== "undefined" &&
        id !== "null" &&
        id !== String(sender) &&
        isObjId(id),
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

    // 🔥 CRITICAL: Create message data with client employee metadata
    const msgData = {
      owner,
      client: actualClientId, // Store parent client ID
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
      // 🔥 NEW: Store client employee metadata if applicable
      clientEmployeeData: isClientEmployeeChat ? clientEmployeeData : null,
      isClientEmployeeMessage: isClientEmployeeChat,
      clientEmployeeId: isClientEmployeeChat ? clientEmployeeId : null,
      // Store metadata for Employee → Manager replies
      originalManagerReceiver: null,
      isEmployeeReplyToManager:
        senderRole === "employee" && isReply && needsApproval,
    };

    // 🔥 SPECIAL CASE: For Employee → Manager reply with needs_approval
    if (senderRole === "employee" && isReply && needsApproval && repliedTo) {
      try {
        const originalMessage = await WhatsAppMessage.findById(repliedTo)
          .populate("sender", "_id role")
          .lean();

        if (originalMessage && originalMessage.sender) {
          const originalSenderRole = normalizeRole(
            originalMessage.sender.role || "",
          );
          if (originalSenderRole === "manager") {
            msgData.originalManagerReceiver = String(
              originalMessage.sender._id,
            );
            msgData.isEmployeeReplyToManager = true;
          }
        }
      } catch (error) {
        console.warn("Failed to store manager ID for forwarding:", error);
      }
    }

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

    // Get assigned employees info
    const assignedEmployeesInfo =
      assignedEmployeeIds.length > 0
        ? clientDoc?.assignedTo?.map((emp) => ({
          id: emp._id,
          name: emp.name,
          email: emp.companyEmail,
          role: emp.role,
        })) || []
        : [];

    // 🔥 ENHANCED RESPONSE: Include client employee info in response
    const responseWithSupervision = {
      ...populated.toObject(),
      parentClientId: populated.client?._id || populated.client, // Ensure parentClientId is present
      clientSupervision: clientSupervision,
      requiresApproval: needsApproval,
      teamLeadsIncluded: senderRole === "manager",
      assignedEmployeesIncluded: assignedEmployeeIds.length > 0,
      assignedEmployeesCount: assignedEmployeeIds.length,
      crmIncluded: senderRole === "team_lead",
      managersIncluded: senderRole === "team_lead",
      totalReceivers: receivers.length,
      assignedEmployees: assignedEmployeesInfo,
      // 🔥 ADD CLIENT EMPLOYEE INFO TO RESPONSE
      isClientEmployeeMessage: isClientEmployeeChat,
      clientEmployeeData: clientEmployeeData,
      receiverSummary: {
        role: senderRole,
        sentToManagers: senderRole === "team_lead",
        sentToTeamLeads: senderRole === "manager",
        sentToAssignedEmployees: assignedEmployeeIds.length > 0,
        assignedEmployeesCount: assignedEmployeeIds.length,
        sentToCRM: senderRole === "team_lead",
        isReply: isReply || false,
        replyToMessageId: isReply ? repliedTo : null,
        isEmployeeReplyToManager:
          senderRole === "employee" && isReply && needsApproval,
        needsTeamLeadApproval: approvalStatus === "pending",
        originalManagerStoredForForwarding: !!msgData.originalManagerReceiver,
        // 🔥 ADD CLIENT EMPLOYEE FLAG
        isClientEmployeeChat: isClientEmployeeChat,
        actualClientId: actualClientId,
      },
    };

    // 🔥 CRITICAL FIX: Emit real-time events for client employees - FIXED VERSION
    if (req.app.get("io")) {
      const io = req.app.get("io");

      // Always emit to sender first
      io.to(`employee_${sender}`).emit("new_message", {
        message: responseWithSupervision,
        type: "message_created",
        action: "sent",
        isClientEmployeeChat: isClientEmployeeChat,
        approvalStatus: responseWithSupervision.approvalStatus,
      });

      // 🎯 CRITICAL FIX: Only notify receivers if message is approved OR if they are supervisors for pending approval
      // Get sender's hierarchy supervisors for checking notifications
      const senderSupervisors = await findSupervisorsFromHierarchy(
        owner,
        String(sender)
      );

      receivers.forEach((receiverId) => {
        const isReceiverTeamLead = tls.includes(receiverId);
        const isReceiverHierarchySupervisor = senderSupervisors.includes(receiverId);
        const shouldNotify =
          responseWithSupervision.approvalStatus === "approved" ||
          responseWithSupervision.approvalStatus === null ||
          (responseWithSupervision.approvalStatus === "pending" &&
            (isReceiverTeamLead || isReceiverHierarchySupervisor));

        if (shouldNotify) {
          io.to(`employee_${receiverId}`).emit("new_message", {
            message: responseWithSupervision,
            type:
              responseWithSupervision.approvalStatus === "pending"
                ? "reply_needs_approval"
                : "new_assignment",
            action: "received",
            isClientEmployeeChat: isClientEmployeeChat,
            clientEmployeeName: clientEmployeeData?.clientEmployeeName,
            requiresApproval:
              responseWithSupervision.approvalStatus === "pending",
            isHierarchySupervisor: isReceiverHierarchySupervisor,
          });
        }
      });

      // 🔥 SPECIAL NOTIFICATION: When team lead sends/replies to client employee chat
      if (senderRole === "team_lead" && assignedEmployeeIds.length > 0) {
        assignedEmployeeIds.forEach((employeeId) => {
          if (receivers.includes(employeeId)) {
            io.to(`employee_${employeeId}`).emit("new_message", {
              message: responseWithSupervision,
              type: "team_lead_direct_message",
              note: isClientEmployeeChat
                ? `Team Lead has sent a message to client employee ${clientEmployeeData?.clientEmployeeName}`
                : "Team Lead has sent you a direct message regarding this client",
              clientName: clientDoc?.clientName || "Unknown Client",
              clientEmployeeName: clientEmployeeData?.clientEmployeeName,
            });
          }
        });
      }

      if (
        senderRole === "team_lead" &&
        responseWithSupervision.approvalStatus !== "pending"
      ) {
        managers.forEach((managerId) => {
          if (receivers.includes(managerId)) {
            io.to(`employee_${managerId}`).emit("new_message", {
              message: responseWithSupervision,
              type: "team_lead_message_to_manager",
              note: isClientEmployeeChat
                ? `Team Lead has sent a message to client employee ${clientEmployeeData?.clientEmployeeName}`
                : "Team Lead has sent you a message regarding client communication",
              clientEmployeeName: clientEmployeeData?.clientEmployeeName,
            });
          }
        });
      }
    }

    res.status(201).json(responseWithSupervision);
  } catch (e) {
    console.error("❌ Create message error:", e);
    res.status(500).json({ error: "Failed to create assignment message" });
  }
};