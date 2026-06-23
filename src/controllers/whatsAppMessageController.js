const WhatsAppMessage = require("../models/WhatsAppMessage");
const WhatsAppGroup = require("../models/WhatsAppGroup");
const Employee = require("../models/Employees");
const path = require("path");
const mongoose = require("mongoose");
const { hasCrmAccess, getCrmUserIds } = require("../utils/crmAccess");

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
  if (r === "owner" || r === "admin") return "owner";
  if (r === "crm" || r.includes("crm") || r.includes("customer_relationship")) return "manager";
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

  // 🔑 ACCESS-BASED: "managers" are now the CRM-access holders + rootManager
  // (was previously role-based: role matching /manager|crm/). The role field is
  // kept for hierarchy/leave/payroll but no longer grants CRM/manager powers.
  const managers = await getCrmUserIds(ownerId);

  const employees = await Employee.find({
    owner: ownerId,
    $or: [{ role: "Employee" }, { role: "employee" }],
  })
    .select("_id")
    .lean();

  return {
    tls: tls.map((x) => String(x._id)),
    managers, // already an array of id strings
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
  if (!isObjId(ownerId) || !isObjId(employeeId)) {
    console.warn("⚠️ findSupervisorsFromHierarchy: Invalid IDs", { ownerId, employeeId });
    return [];
  }

  try {
    // Find all hierarchy links where the employee is the junior.
    // Sort by hierarchyLevel DESC so the deepest (immediate) parent comes first
    // in case multiple seniors exist for the same junior.
    const hierarchyLinks = await EmployeeHierarchy.find({
      owner: ownerId,
      junior: employeeId,
    })
      .select("senior hierarchyLevel path")
      .sort({ hierarchyLevel: -1 })
      .lean();

    const supervisorIds = hierarchyLinks.map((link) => String(link.senior));

    return supervisorIds;
  } catch (error) {
    console.error("❌ Error finding supervisors from hierarchy:", error);
    return [];
  }
}

/**
 * Find the next active supervisor(s) in the hierarchy chain for an employee.
 * This checks the management chain upward and returns the first senior(s)
 * who have supervision ENABLED for the specific client.
 * @param {string} ownerId - The owner ID (organization)
 * @param {string} employeeId - The employee whose supervisor we're looking for
 * @param {string[]} supervisedByList - Array of supervisor IDs who have supervision ON for this client
 * @returns {Promise<string[]>} - Array of active supervisor ID(s)
 */
async function findNextActiveSupervisors(ownerId, employeeId, supervisedByList) {
  if (!isObjId(ownerId) || !isObjId(employeeId)) return [];
  // If no one is supervising this client, return empty
  if (!Array.isArray(supervisedByList) || supervisedByList.length === 0) return [];

  const supervisedByStrs = supervisedByList.map((id) => String(id));
  let currentEmployeeId = employeeId;
  const visited = new Set();

  // Traverse up the hierarchy (limit to 10 levels to prevent infinite loops)
  for (let i = 0; i < 10; i++) {
    const currentIdStr = String(currentEmployeeId);
    if (visited.has(currentIdStr)) break;
    visited.add(currentIdStr);

    // Find immediate seniors
    const seniors = await findSupervisorsFromHierarchy(ownerId, currentEmployeeId);
    if (!seniors || seniors.length === 0) break;

    // Check if any of these seniors have supervision ON
    const activeSeniors = seniors.filter((sId) => supervisedByStrs.includes(sId));

    if (activeSeniors.length > 0) {
      // Found the next active level!
      return activeSeniors;
    }

    // None of these seniors are active - move up the chain from the first one
    // (In most cases, an employee has exactly one supervisor)
    currentEmployeeId = seniors[0];
  }

  return [];
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

    // Traverse up the hierarchy (limit to 10 levels to prevent infinite loops).
    for (let i = 0; i < 10; i++) {
      if (visited.has(currentEmployee)) break;
      visited.add(currentEmployee);

      // findOne returns one document — .sort() on findOne is a no-op so omit it.
      const hierarchyLink = await EmployeeHierarchy.findOne({
        owner: ownerId,
        junior: currentEmployee,
      })
        .select("senior hierarchyLevel")
        .lean();

      if (!hierarchyLink || !hierarchyLink.senior) break;

      const seniorId = String(hierarchyLink.senior);
      chain.push(seniorId);
      currentEmployee = seniorId;
    }

    return chain;
  } catch (error) {
    console.error("❌ Error getting management chain:", error);
    return [];
  }
}

/**
 * Compute the full ordered approval chain for a sender by traversing the hierarchy.
 * Prioritises supervisors who have supervision enabled (supervisedByList), but if none
 * are found it falls back to the full management chain so the display always shows
 * the actual route the message will travel.
 */
async function computeFullApprovalChain(ownerId, senderId, supervisedByList) {
  const supervisedBySet = new Set((supervisedByList || []).map(id => String(id)));
  const chain = [];
  let currentId = String(senderId);
  const visited = new Set();

  for (let i = 0; i < 10; i++) {
    if (visited.has(currentId)) break;
    visited.add(currentId);

    const seniors = await findSupervisorsFromHierarchy(ownerId, currentId);
    if (!seniors || seniors.length === 0) break;

    // Use the first senior in the hierarchy (the actual routing path) —
    // include managers/TLs since every level in the chain must explicitly approve.
    const nextSenior = seniors[0];
    if (!chain.includes(nextSenior)) {
      chain.push(nextSenior);
    }

    currentId = nextSenior;
  }

  return chain;
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

  // 🔑 ACCESS-BASED: CRM-access holders (and the rootManager) get the
  // org-wide "manager" view. Admin/owner tokens keep their owner-level view.
  const isCrmUser = await hasCrmAccess(req.employee);

  // 🧑‍💼 CRM USER / OWNER: can see all approved/null messages plus their own pending ones
  if (
    (isCrmUser || currentUserRole === "owner") &&
    ownerId
  ) {
    return {
      $and: [
        { ...q, owner: ownerId },
        {
          $or: [
            // Normal (no approval needed) and approved messages → always visible
            { approvalStatus: null },
            { approvalStatus: "approved" },
            // Pending → only visible to the sender or designated approver
            { approvalStatus: "pending", sender: me },
            { approvalStatus: "pending", receiver: me },
            { approvalStatus: "pending", receiver: { $in: [me] } },
            // Disapproved → only sender sees it
            { approvalStatus: "disapproved", sender: me },
          ],
        },
      ],
    };
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
    // FIX: Pending messages only visible to sender and receiver
    const visibilityConditions = {
      $or: [
        { sender: me },
        { receiver: me },
        { receiver: { $in: [me] } },
        // Keep messages visible after the team lead has approved them
        { "approvalChain.approver": me },
        // Allow team leads to see manager messages (non-pending only)
        {
          sender: { $in: managers.map((id) => oid(id)) },
          owner: ownerId,
          approvalStatus: { $ne: "pending" },
        },
      ],
    };

    // CRITICAL FIX: Combine original query with visibility conditions using $and
    // This preserves the text search while applying visibility rules
    return {
      $and: [q, visibilityConditions],
    };
  }

  // HIERARCHY-BASED: Check if this employee is a supervisor in the hierarchy
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

  // 🔥 CLIENT ASSIGNMENT CHECK: If the query targets a specific client,
  // check if this employee is currently assigned to that client.
  // If so, they should see ALL messages for that client (including old ones
  // from previously assigned employees).
  let isAssignedToClient = false;
  const clientId = q.client;
  if (clientId && isObjId(clientId)) {
    const ClientInfo = require("../models/ClientInfo");
    // Check both assignedTo (deployed employees) AND supervisedBy (hierarchy seniors)
    const clientDoc = await ClientInfo.findOne({
      _id: clientId,
      $or: [{ assignedTo: me }, { supervisedBy: me }],
    }).select("_id").lean();
    isAssignedToClient = !!clientDoc;
  }

  if (juniorIdsSupervisor.length > 0) {
    // This employee has subordinates
    const now = new Date();
    const visOr = [
      { sender: me },
      { receiver: me },
      { receiver: { $in: [me] } },
      // Keep approved messages visible after the senior has approved them
      { "approvalChain.approver": me },
    ];

    // If assigned to client, also allow seeing all non-pending messages for that client
    if (isAssignedToClient && clientId) {
      visOr.push({
        client: oid(clientId),
        approvalStatus: { $in: [null, "approved"] },
      });
    }

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
  const visOr = [
    { sender: me },
    { receiver: me },
    { receiver: { $in: [me] } },
    // Keep approved messages visible after the user has approved them
    { "approvalChain.approver": me },
  ];

  // 🔥 If assigned to client, also allow seeing all non-pending messages for that client
  if (isAssignedToClient && clientId) {
    visOr.push({
      client: oid(clientId),
      approvalStatus: { $in: [null, "approved"] },
    });
  }

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
            { path: "sender", select: "_id name companyEmail role designation" },
            { path: "receiver", select: "_id name companyEmail role designation" },
            { path: "client", select: "_id clientName assignedTo" },
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
    if (isObjId(client)) {
      q.client = client;
      // 🔥 CRITICAL: Regular client message list should NOT include group messages
      q.isGroupMessage = { $ne: true };
    }

    // 🔥 ENHANCED: Handle conversation type separation
    if (conversationType) {
      if (conversationType === "client") {
        // Only show direct client messages (not client employee messages)
        // Use $ne: true to include older messages that don't have this field yet
        q.isClientEmployeeMessage = { $ne: true };
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

    // Exclude messages this user has deleted for themselves only
    qFinal.deletedForUsers = { $nin: [me] };

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
        { path: "sender", select: "_id name companyEmail role designation" },
        { path: "receiver", select: "_id name companyEmail role designation" },
        { path: "client", select: "_id clientName assignedTo" },
        { path: "attachments.uploadedBy", select: "_id name companyEmail" },
        { path: "scheduledBy", select: "_id name companyEmail" },
        { path: "repliedTo", select: "_id note message sender attachments" },
        {
          path: "replyContent.originalSender",
          select: "_id name companyEmail",
        },
        { path: "editedBy", select: "_id name companyEmail" },
        { path: "approvedBy", select: "_id name companyEmail role designation" },
        { path: "disapprovedBy", select: "_id name companyEmail role designation" },
        { path: "plannedApprovalChain", select: "_id name role designation" },
        {
          path: "approvalChain",
          populate: { path: "approver", select: "_id name role designation", model: "Employee" },
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

    // 🔥 HANDLE GROUP FILTERING - FIXED FOR OLDER MESSAGES
    const isGroupFilter = req.query.isGroupMessage === "true";
    const groupId = req.query.groupId;

    if (isGroupFilter && isObjId(groupId)) {
      q.isGroupMessage = true;
      q.groupId = groupId;
      // When searching a group, we typically ignore the client filter 
      // as the groupId is the primary identifier
      delete q.client;
    } else if (req.query.isGroupMessage === "false") {
      q.isGroupMessage = false;
      q.groupId = null;
    } else if (!isGroupFilter && !groupId) {
      // 🔥 FIX: DEFAULT - Include regular messages AND older messages without isGroupMessage field
      q.$or = [
        { isGroupMessage: false },
        { isGroupMessage: { $exists: false } }  // Include older messages that don't have this field
      ];
    }

    // FIXED: Handle status filter for drafts to exclude scheduled messages
    const status = req.query.status;
    const isClientEmployeeMessage = req.query.isClientEmployeeMessage;
    const clientEmployeeId = req.query.clientEmployeeId;

    if (isClientEmployeeMessage === "true" && clientEmployeeId) {
      q.isClientEmployeeMessage = true;
      q.clientEmployeeId = clientEmployeeId;
    } else if (isClientEmployeeMessage === "false") {
      q.isClientEmployeeMessage = { $ne: true };
    }

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
        { path: "sender", select: "_id name companyEmail role designation" },
        { path: "receiver", select: "_id name companyEmail role designation" },
        { path: "client", select: "_id clientName assignedTo" },
        { path: "attachments.uploadedBy", select: "_id name companyEmail" },
        { path: "repliedTo", select: "_id note message sender attachments" },
        {
          path: "replyContent.originalSender",
          select: "_id name companyEmail",
        },
        { path: "editedBy", select: "_id name companyEmail" },
        { path: "approvedBy", select: "_id name companyEmail role designation" },
        { path: "disapprovedBy", select: "_id name companyEmail role designation" },
        { path: "plannedApprovalChain", select: "_id name role designation" },
        {
          path: "approvalChain",
          populate: { path: "approver", select: "_id name role designation", model: "Employee" },
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
        nextCursor = messages[messages.length - 1]?._id || null;
        prevCursor = messages[0]?._id || null;
      } else {
        nextCursor = messages[0]?._id || null;
        prevCursor = messages[messages.length - 1]?._id || null;
      }
    }
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
            parentClientId: message.client?._id || message.client,
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
        { path: "client", select: "_id clientName assignedTo" },
        { path: "sender", select: "_id name companyEmail role designation" },
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
      { path: "sender", select: "_id name companyEmail role designation" },
      { path: "receiver", select: "_id name companyEmail role designation" },
      { path: "client", select: "_id clientName assignedTo" },
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
      { path: "sender", select: "_id name companyEmail role designation" },
      { path: "receiver", select: "_id name companyEmail role designation" },
      { path: "client", select: "_id clientName assignedTo" },
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
          { path: "sender", select: "_id name companyEmail role designation" },
          { path: "receiver", select: "_id name companyEmail role designation" },
          { path: "client", select: "_id clientName assignedTo" },
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
      { path: "sender", select: "_id name companyEmail role designation" },
      { path: "receiver", select: "_id name companyEmail role designation" },
      { path: "client", select: "_id clientName assignedTo" },
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

    const scheduledMessages = await WhatsAppMessage.find({
      isScheduled: true,
      status: "scheduled",
      scheduledFor: { $lte: now },
    });

    const results = { sent: 0, failed: 0, errors: [] };

    for (const message of scheduledMessages) {
      try {
        // Mark as sent
        message.isScheduled = false;
        message.status = "sent";
        message.sentAt = new Date();
        await message.save();

        // Fully populate for the socket payload (mirrors what createMessage sends)
        const populated = await WhatsAppMessage.findById(message._id).populate([
          { path: "owner",    select: "_id name companyEmail" },
          { path: "sender",   select: "_id name companyEmail role designation" },
          { path: "receiver", select: "_id name companyEmail role designation" },
          { path: "client",   select: "_id clientName assignedTo" },
          { path: "repliedTo",select: "_id note message sender attachments" },
        ]);
        if (!populated) { results.failed++; continue; }

        const msgObj = populated.toObject();

        // Update lastWhatsAppMessage cache on ClientInfo (parent client chats only)
        if (msgObj.client && !msgObj.isGroupMessage && !msgObj.isClientEmployeeMessage) {
          const ClientInfo = require("../models/ClientInfo");
          ClientInfo.findByIdAndUpdate(
            msgObj.client._id || msgObj.client,
            { $set: {
              "lastWhatsAppMessage.text": (msgObj.note || "").replace(/<[^>]*>/g, "").slice(0, 200),
              "lastWhatsAppMessage.at": msgObj.sentAt || now,
              "lastWhatsAppMessage.senderId": msgObj.sender?._id || msgObj.sender,
              "lastWhatsAppMessage.hasAttachments": Array.isArray(msgObj.attachments) && msgObj.attachments.length > 0,
              "lastWhatsAppMessage.deleted": false,
            }},
            { timestamps: false }
          ).catch(() => {});
        }

        if (io) {
          const socketPayload = {
            message: msgObj,
            type: "scheduled_message_delivered",
            action: "received",
            approvalStatus: msgObj.approvalStatus,
          };

          // Notify each receiver — they see it as a new incoming message
          const receiverIds = (msgObj.receiver || []).map((r) =>
            String(typeof r === "object" ? r._id : r)
          );
          receiverIds.forEach((rid) => {
            io.to(`employee_${rid}`).emit("new_message", socketPayload);
          });

          // Notify sender — their scheduled message was delivered
          const senderId = String(msgObj.sender?._id || msgObj.sender || "");
          if (senderId) {
            io.to(`employee_${senderId}`).emit("new_message", {
              ...socketPayload,
              type: "scheduled_message_sent",
              action: "sent",
            });
          }

          // If group message, also emit to the group room
          if (msgObj.isGroupMessage && msgObj.groupId) {
            io.to(`group_${msgObj.groupId}`).emit("new_message", socketPayload);
          }
        }

        results.sent++;
      } catch (error) {
        console.error(`Failed to send scheduled WhatsApp message ${message._id}:`, error);
        results.failed++;
        results.errors.push({ messageId: message._id, error: error.message });
      }
    }

    return results;
  } catch (e) {
    console.error("Error in sendScheduledMessages (whatsapp):", e);
    throw e;
  }
};
// PATCH /api/assignment-messages/:id/approve
exports.approveMessage = async function approveMessage(req, res) {
  try {
    const { id } = req.params;

    // Fetch only non-approved messages atomically to guard against concurrent approvals.
    // If two requests arrive simultaneously both see "pending", we want only one to win.
    const msg = await WhatsAppMessage.findOne({
      _id: id,
      approvalStatus: { $ne: "approved" },
    }).populate([
      { path: "sender", select: "_id name companyEmail role designation" },
      { path: "receiver", select: "_id name companyEmail role designation" },
      { path: "client", select: "_id clientName assignedTo" },
      { path: "replyContent.originalSender", select: "_id name companyEmail" },
      { path: "repliedTo", select: "_id note message sender attachments" },
    ]);

    if (!msg) {
      // Distinguish "not found" from "already approved"
      const exists = await WhatsAppMessage.exists({ _id: id });
      if (exists) return res.status(400).json({ error: "Message is already fully approved." });
      return res.status(404).json({ error: "Message not found" });
    }

    const Client = require("../models/ClientInfo");
    const client = await Client.findById(msg.client)
      .select("supervision supervisedBy")
      .lean();
    const clientSupervision = client?.supervision || "direct";

    if (clientSupervision !== "needs_approval") {
      return res.status(400).json({
        error: "This client uses direct supervision. Approval not required.",
        clientSupervision: clientSupervision,
      });
    }

    const currentUserId = String(req.employee?._id);
    const ownerId = msg.owner;

    // ✅ Verify current user is one of the designated receivers (approvers)
    const isReceiver = msg.receiver.some(
      (r) => String(r._id || r) === currentUserId
    );
    if (!isReceiver) {
      return res.status(403).json({
        error: "You are not a designated approver for this message.",
      });
    }

    // ─────────────────────────────────────────────────────────────────
    // 🔥 HIERARCHY-BASED 1-BY-1 APPROVAL using EmployeeHierarchy DB
    // Find the immediate senior of the CURRENT APPROVER in the hierarchy
    // ─────────────────────────────────────────────────────────────────

    // Fetch the approver's own hierarchy link to record the level
    const approverLink = await EmployeeHierarchy.findOne({
      owner: ownerId,
      junior: currentUserId,
    })
      .select("senior hierarchyLevel")
      .lean();
    const currentHierarchyLevel = approverLink?.hierarchyLevel ?? null;

    // Find the immediate seniors of the current approver (1 level up)
    console.log("════════════════════════════════════════════════");
    console.log("📨 [approveMessage] APPROVAL TRIGGERED");
    console.log("   approver (currentUserId):", currentUserId);
    console.log("   approver name:", req.employee?.name);
    console.log("   approver role:", req.employee?.role);
    console.log("   ownerId:", String(ownerId));
    console.log("   message._id:", String(msg._id));
    console.log("   message current status:", msg.approvalStatus);
    console.log("   message current receivers:", msg.receiver?.map(r => String(r._id || r)));

    // Show ALL hierarchy records where this approver is the junior (for debugging)
    const allLinksAsJunior = await EmployeeHierarchy.find({
      owner: ownerId,
      junior: currentUserId,
    }).lean();
    console.log("   [DB] hierarchy records where approver is JUNIOR:", JSON.stringify(allLinksAsJunior, null, 2));

    const immediateSeniors = await findSupervisorsFromHierarchy(
      ownerId,
      currentUserId
    );
    console.log("   [DB] immediate seniors of approver:", immediateSeniors);
    console.log("════════════════════════════════════════════════");

    // Record this approval step
    if (!msg.approvalChain) msg.approvalChain = [];
    msg.approvalChain.push({
      approver: req.employee._id,
      approvedAt: new Date(),
      hierarchyLevel: currentHierarchyLevel,
    });

    // The approver has reviewed this message — mark it as seen so it doesn't
    // show up as an unread message in their badge count after approval
    if (!msg.seenBy) msg.seenBy = [];
    const alreadySeen = msg.seenBy.some(
      (s) => String(s.employee) === String(req.employee._id)
    );
    if (!alreadySeen) {
      msg.seenBy.push({ employee: req.employee._id, seenAt: new Date() });
    }

    let approvalFinalized = false;
    let responseStatusMessage = "Message approved successfully";

    if (immediateSeniors.length > 0) {
      // Escalate to next immediate senior in hierarchy
      msg.approvalStatus = "pending";
      msg.receiver = [immediateSeniors[0]];
      responseStatusMessage = "Message approved and escalated to next-level supervisor";
      console.log("⬆️ [approveMessage] Escalating to next senior in hierarchy:", immediateSeniors[0]);
    } else {
      // Top of hierarchy reached — finalize as approved
      msg.approvalStatus = "approved";
      msg.approvedBy = req.employee._id;
      msg.approvedAt = new Date();
      msg.status = "sent";
      msg.sentAt = new Date();
      approvalFinalized = true;
      console.log("✅ [approveMessage] Top of hierarchy reached — finalizing as approved");
    }

    // 🔥 GROUP MESSAGE: When finalized, expand receiver to ALL intended group members
    // so the socket emission below notifies all group members (not just the approver)
    if (msg.isGroupMessage && approvalFinalized) {
      const intendedIds = (msg.intendedReceivers || []).map((r) =>
        typeof r === "object" ? r._id : r
      );
      if (intendedIds.length > 0) {
        msg.receiver = intendedIds;
      }
    }

    // 🔥 Expand receivers on finalization (non-group only)
    if (approvalFinalized && !msg.isGroupMessage && !msg.groupId && msg.chatType !== 'group') {
      const senderRole = normalizeRole(msg.sender?.role || "");
      const senderId = String(msg.sender?._id || msg.sender);
      const currentReceiverSet = new Set(msg.receiver.map(r => String(r._id || r)));

      const addReceiver = (id) => {
        const s = String(id);
        if (s && s !== senderId && !currentReceiverSet.has(s)) {
          msg.receiver.push(s);
          currentReceiverSet.add(s);
        }
      };

      if (senderRole === "manager") {
        // Manager-sent: expand to intendedReceivers stored at creation.
        // Fall back to client.assignedTo when intendedReceivers is missing (e.g. edited messages).
        const intendedIds = (msg.intendedReceivers || []).map(r => typeof r === "object" ? r._id : r);
        if (intendedIds.length > 0) {
          intendedIds.forEach(addReceiver);
        } else if (msg.client) {
          const ClientModel = require("../models/ClientInfo");
          const clientFallback = await ClientModel.findById(msg.client).select("assignedTo").lean();
          (clientFallback?.assignedTo || []).forEach(empId => {
            addReceiver(typeof empId === "object" ? empId._id : empId);
          });
        }
      } else {
        // Employee / team_lead / client employee: add assigned employees + managers
        if (msg.client) {
          const ClientModel = require("../models/ClientInfo");
          const clientForExp = await ClientModel.findById(msg.client)
            .select("assignedTo")
            .lean();
          if (clientForExp) {
            (clientForExp.assignedTo || []).forEach(empId => {
              addReceiver(typeof empId === "object" ? empId._id : empId);
            });
          }
        }
        // Always deliver the approved message to managers
        const { managers: orgManagers } = await findTLsAndManagersByOwner(ownerId);
        orgManagers.forEach(id => addReceiver(id));
      }
      console.log("✅ [approveMessage] Final receivers after expansion:", [...currentReceiverSet]);
    }

    await msg.save();

    const populatedMsg = await WhatsAppMessage.findById(id).populate([
      { path: "owner", select: "_id name companyEmail" },
      { path: "sender", select: "_id name companyEmail role designation" },
      { path: "receiver", select: "_id name companyEmail role designation" },
      { path: "client", select: "_id clientName assignedTo" },
      { path: "approvedBy", select: "_id name companyEmail role designation" },
      { path: "disapprovedBy", select: "_id name companyEmail role designation" },
      { path: "plannedApprovalChain", select: "_id name role designation" },
      {
        path: "approvalChain",
        populate: { path: "approver", select: "_id name role designation", model: "Employee" },
      },
      { path: "groupId", select: "_id name" },
      { path: "attachments.uploadedBy", select: "_id name companyEmail" },
      { path: "replyContent.originalSender", select: "_id name companyEmail" },
      { path: "repliedTo", select: "_id note message sender attachments" },
    ]);

    const updatedMessage = {
      ...populatedMsg.toObject(),
      clientSupervision: clientSupervision,
      requiresApproval: clientSupervision === "needs_approval",
      approvalFinalized,
      // Use actual message flags instead of hardcoding
      isGroupMessage: populatedMsg.isGroupMessage,
      groupId: populatedMsg.groupId,
      chatType: populatedMsg.chatType || (populatedMsg.groupId ? "group" : "normal"),
      isClientEmployeeMessage: populatedMsg.isClientEmployeeMessage || false,
    };

    const io = req.app.get("io");
    if (io) {
      const allInvolvedUsers = new Set();

      // Original message sender
      if (msg.sender?._id) allInvolvedUsers.add(String(msg.sender._id));

      // The current approver
      allInvolvedUsers.add(currentUserId);

      // New receivers (next-level supervisors or managers)
      if (Array.isArray(msg.receiver)) {
        msg.receiver.forEach((r) => {
          const rid = typeof r === "object" ? r._id : r;
          if (rid) allInvolvedUsers.add(String(rid));
        });
      }

      // When finalized: notify previous approvers (approval status update) but NOT all managers
      // Supervisors receive approval notifications only; client notifications go to assigned employees
      if (approvalFinalized) {
        (msg.approvalChain || []).forEach(step => {
          const aid = step.approver?._id || step.approver;
          if (aid) allInvolvedUsers.add(String(aid));
        });
        // msg.receiver already contains only assigned employees (expanded above)
        // — no need to add all managers here
      }

      // 🔥 If it's a group message:
      // - When finalized: broadcast to ALL group members + managers + TLs (message is approved)
      // - When escalating: only notify sender + current approver + next receiver in chain
      //   (CRM/manager should NOT see it until the message actually reaches them)
      if (msg.isGroupMessage && msg.groupId) {
        try {
          if (approvalFinalized) {
            // Fully approved — add managers/TLs to allInvolvedUsers for individual room emit.
            // Group members are notified via the group_${groupId} room emit below (no duplication).
            const { managers: orgManagers, tls } = await findTLsAndManagersByOwner(msg.owner);
            orgManagers.forEach(id => allInvolvedUsers.add(String(id)));
            tls.forEach(id => allInvolvedUsers.add(String(id)));
          }
          // When NOT finalized (escalation): only sender + current approver + next receiver
          // are notified. Managers/TLs should not see it until the message reaches them.
        } catch (err) {
          console.error("Error fetching group members for approval emission:", err);
        }
      }

      console.log("🔔 [approveMessage] Socket emission to allInvolvedUsers:", [...allInvolvedUsers]);
      console.log("🔔 [approveMessage] updatedMessage.receiver:", (updatedMessage.receiver || []).map(r => String(r._id || r)));
      console.log("🔔 [approveMessage] approvalFinalized:", approvalFinalized);
      allInvolvedUsers.forEach((userId) => {
        io.to(`employee_${userId}`).emit("new_message", {
          message: updatedMessage,
          type: approvalFinalized ? "message_approved" : "message_escalated",
          action: approvalFinalized ? "approved" : "escalated_to_senior",
          approvedBy: currentUserId,
          timestamp: new Date(),
          approvalFinalized,
          nextSupervisors: approvalFinalized ? [] : immediateSeniors,
        });
      });

      // Emit to the group room only when finalized so all group members see the approved message.
      // During escalation the message is still pending — only the next receiver should see it.
      if (msg.isGroupMessage && msg.groupId && approvalFinalized) {
        io.to(`group_${msg.groupId}`).emit("new_message", {
          message: updatedMessage,
          type: "message_approved",
          action: "approved",
          approvedBy: currentUserId,
          timestamp: new Date(),
          approvalFinalized: true
        });
      }

    }

    // Denormalize onto ClientInfo when approval is finalized so the sidebar refreshes
    // (parent client chats only — CE sub-chats are separate conversations).
    if (approvalFinalized && msg.client && !msg.isGroupMessage && !msg.isClientEmployeeMessage) {
      const ClientInfo = require("../models/ClientInfo");
      ClientInfo.findByIdAndUpdate(msg.client, {
        $set: {
          "lastWhatsAppMessage.text": (msg.note || "").replace(/<[^>]*>/g, "").slice(0, 200),
          "lastWhatsAppMessage.at": msg.approvedAt || new Date(),
          "lastWhatsAppMessage.senderId": msg.sender?._id || msg.sender,
          "lastWhatsAppMessage.hasAttachments": Array.isArray(msg.attachments) && msg.attachments.length > 0,
          "lastWhatsAppMessage.deleted": false,
        },
      }, { timestamps: false }).catch(() => {});
    }

    return res.json({
      ...updatedMessage,
      message: responseStatusMessage,
      clientSupervision: clientSupervision,
      approvalFinalized,
      nextSupervisors: approvalFinalized ? [] : immediateSeniors,
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
      { path: "sender", select: "_id name companyEmail role designation" },
      { path: "receiver", select: "_id name companyEmail role designation" },
      { path: "client", select: "_id clientName assignedTo" },
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

    const isManagerOrOwner = userRole === "manager" || userRole === "owner";
    if (!isManagerOrOwner && !isReceiver) {
      return res
        .status(403)
        .json({ error: "Only designated supervisors or managers can disapprove messages" });
    }


    msg.approvalStatus = "disapproved";
    msg.disapprovedBy = req.employee._id;
    msg.disapprovedAt = new Date();
    await msg.save();

    // Get fully populated message for real-time emission (includes approvalChain)
    const populatedMsg = await WhatsAppMessage.findById(id).populate([
      { path: "owner", select: "_id name companyEmail" },
      { path: "sender", select: "_id name companyEmail role designation" },
      { path: "receiver", select: "_id name companyEmail role designation" },
      { path: "client", select: "_id clientName assignedTo" },
      { path: "attachments.uploadedBy", select: "_id name companyEmail" },
      { path: "disapprovedBy", select: "_id name companyEmail role designation" },
      {
        path: "approvalChain",
        populate: { path: "approver", select: "_id name role designation", model: "Employee" },
      },
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

      // Add all previous approvers from the approval chain so every
      // senior who already approved sees the disapproval in real time.
      // NOTE: approvalChain is NOT populated on msg, so step.approver is a
      // raw Mongoose ObjectId — calling String() on it gives the hex ID directly.
      if (Array.isArray(msg.approvalChain)) {
        msg.approvalChain.forEach((step) => {
          const raw = step.approver;
          // Handle both populated ({_id,...}) and raw ObjectId forms
          const approverId = raw?._id ? String(raw._id) : raw ? String(raw) : null;
          if (approverId) allInvolvedUsers.add(approverId);
        });
      }

      // Add the senior who disapproved
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
      { path: "sender", select: "_id name companyEmail role designation" },
      { path: "receiver", select: "_id name companyEmail role designation" },
      { path: "client", select: "_id clientName assignedTo" },
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
      { path: "sender", select: "_id name companyEmail role designation" },
      { path: "receiver", select: "_id name companyEmail role designation" },
      { path: "client", select: "_id clientName assignedTo" },
      { path: "replyContent.originalSender", select: "_id name companyEmail" },
      { path: "repliedTo", select: "_id note message sender attachments" },
      // Populate approvalChain so step.approver._id is always reliable
      { path: "approvalChain.approver", select: "_id", model: "Employee" },
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

    // Check if the current user is the current receiver
    const isReceiver =
      Array.isArray(msg.receiver) &&
      msg.receiver.some((r) => String(r._id || r) === currentUserId);

    // --- Check 1: Was this user in the approval chain? (lean, no populate) ---
    const rawChainDoc = await WhatsAppMessage.findById(id)
      .select("approvalChain")
      .lean();
    const isInApprovalChain = (rawChainDoc?.approvalChain || []).some(
      (step) => step?.approver && String(step.approver) === currentUserId,
    );

    // --- Check 2: Is this user a supervisor for this client? ---
    // client.supervisedBy is the authoritative list of who can approve/edit
    // messages for this client. If the user is in this list they have
    // edit authority over disapproved messages.
    const clientFull = await Client.findById(msg.client?._id || msg.client)
      .select("supervisedBy supervision")
      .lean();
    const supervisedByList = (clientFull?.supervisedBy || []).map(id => String(id));
    const isClientSupervisor = supervisedByList.includes(currentUserId);

    // isPreviousApprover: user has authority over this message but is not the
    // original sender and not a formal team_lead/manager role label
    const isPreviousApprover =
      (isInApprovalChain || isClientSupervisor) &&
      !isSender && !isTeamLead && !isManager;

    const canEdit =
      isSender || isReceiver || isTeamLead || isManager || isPreviousApprover;

    // Permission gate
    if (!canEdit) {
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

    // Previous approvers / client supervisors may only edit disapproved messages.
    // EXCEPTION: the current designated receiver (isReceiver === true) is the
    // active approver for this pending message — they must be allowed to edit
    // it as part of the "Edit & Approve" flow.
    if (isPreviousApprover && !isReceiver) {
      if (!clientRequiresApproval) {
        return res.status(403).json({
          error: "This client uses direct supervision. Resubmission not required.",
          clientSupervision,
        });
      }
      if (msg.approvalStatus !== "disapproved") {
        return res.status(403).json({
          error: "Previous approvers can only edit disapproved messages for resubmission",
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
      // CASE 0 (NEW): Previous approver (any role) resubmitting a disapproved message.
      // Route from the EDITOR's position so the message goes to their own higher-order
      // senior — not back to themselves.
      if (isPreviousApprover && msg.approvalStatus === "disapproved" && clientRequiresApproval) {
        msg.approvalStatus = "pending";
        msg.approvalChain = []; // restart the chain so seniors re-approve in order
        msg.markModified("approvalChain"); // ensure Mongoose tracks the reset

        // reuse clientFull.supervisedBy already fetched above
        const supervisedByList = (clientFull?.supervisedBy || []).map(id => String(id));
        // Route from editor (Senior B) → finds Senior C
        const nextActiveSupervisors = await findNextActiveSupervisors(
          msg.owner,
          currentUserId,
          supervisedByList
        );
        if (nextActiveSupervisors && nextActiveSupervisors.length > 0) {
          msg.receiver = [nextActiveSupervisors[0]];
        } else {
          msg.approvalStatus = "approved";
          msg.status = "sent";
        }
      }
      // CASE 1 & 4 Consolidated: Team Lead or Manager editing someone else's message
      else if ((isTeamLead || isManager) && !isSender && clientRequiresApproval) {
        // Manager or TL editing an employee's message - handle status
        if (isOriginalSenderEmployee) {
          // If editing ≠ approving, we should decide if it goes to pending.
          if (!msg.approvalStatus || msg.approvalStatus === "disapproved") {
            msg.approvalStatus = "pending";
          }

          // When editor is in the approvalChain (e.g. the team lead who approved
          // earlier), route from the editor's position so the message reaches their
          // own higher-level senior instead of cycling back to themselves.
          const isSupervisorOfSender = !!(await EmployeeHierarchy.findOne({
            owner: msg.owner,
            junior: String(msg.sender?._id || msg.sender),
            senior: currentUserId,
          }).lean());
          const routeFromId = (isInApprovalChain || isSupervisorOfSender)
            ? currentUserId
            : String(msg.sender?._id || msg.sender);

          // If message is ALREADY pending with a receiver, validate they have supervision enabled
          if (msg.approvalStatus === "pending" && msg.receiver && msg.receiver.length > 0) {
            const clientData = await Client.findById(msg.client)
              .select("supervisedBy")
              .lean();
            const supervisedByList = (clientData?.supervisedBy || []).map(id => String(id));
            const currentReceiverIds = msg.receiver.map(r => String(r._id || r));
            const validReceivers = currentReceiverIds.filter(id =>
              supervisedByList.includes(id)
            );

            if (validReceivers.length === 0) {
              const nextActiveSupervisors = await findNextActiveSupervisors(
                msg.owner,
                routeFromId,
                supervisedByList
              );
              if (nextActiveSupervisors && nextActiveSupervisors.length > 0) {
                msg.receiver = [nextActiveSupervisors[0]];
              } else {
                msg.approvalStatus = "approved";
                msg.status = "sent";
              }
            }
          } else if (!msg.receiver || msg.receiver.length === 0) {
            const clientData = await Client.findById(msg.client)
              .select("supervisedBy")
              .lean();
            const supervisedByList = (clientData?.supervisedBy || []).map(id => String(id));
            const nextActiveSupervisors = await findNextActiveSupervisors(
              msg.owner,
              routeFromId,
              supervisedByList
            );
            if (nextActiveSupervisors && nextActiveSupervisors.length > 0) {
              msg.receiver = [nextActiveSupervisors[0]];
            } else {
              msg.approvalStatus = "approved";
              msg.status = "sent";
            }
          }
        } else {
          // Senior editing another senior's message - no approval needed
          msg.approvalStatus = null;
        }
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
          } else if (msg.approvalStatus === "approved" && clientRequiresApproval) {
            // 🔥 FIX: If an employee edits an already approved message,
            //   it must be re-approved if the client requires approval.
            msg.approvalStatus = "pending";
          } else if (msg.approvalStatus === "approved") {
            // Already approved - keep it approved (direct supervision)
            msg.approvalStatus = "approved";
          } else if (!msg.approvalStatus && clientRequiresApproval) {
            // No approval status yet and client requires approval
            msg.approvalStatus = "pending";
          }

          // 🔥 ENHANCED: Re-calculate receivers using STRICT ONE-BY-ONE CHAIN
          if (msg.approvalStatus === "pending") {
            if (msg.receiver && msg.receiver.length > 0) {
              // SIMPLIFIED: If already pending with receiver, keep them (receiver preservation)
              // Don't recalculate - let current approver finish their action first
            } else {
              // No receivers - calculate them
              const clientData = await Client.findById(msg.client)
                .select("supervisedBy")
                .lean();
              const supervisedByList = (clientData?.supervisedBy || []).map(id => String(id));

              const nextActiveSupervisors = await findNextActiveSupervisors(
                msg.owner,
                currentUserId,
                supervisedByList
              );

              if (nextActiveSupervisors && nextActiveSupervisors.length > 0) {
                msg.receiver = [nextActiveSupervisors[0]];
              } else {
                // No supervisor with supervision enabled - auto-approve
                msg.approvalStatus = "approved";
                msg.status = "sent";
              }
            }
          }

          // 🔥 FINAL SAFEGUARD for edits: If status is pending, ensure only active supervisors are in the receiver list
          if (msg.approvalStatus === "pending") {
            const clientData = await Client.findById(msg.client).select("supervisedBy").lean();
            const supervisedByList = (clientData?.supervisedBy || []).map(id => String(id));
            const { tls: orgTls, managers: orgManagers } = await findTLsAndManagersByOwner(msg.owner);

            const allAllowedApprovers = [...supervisedByList, ...orgTls, ...orgManagers].map(id => String(id));
            msg.receiver = msg.receiver.filter(id => allAllowedApprovers.includes(String(id._id || id)));
          }
        }
      }
      // CASE 3: Team Lead or Manager editing their own message (redundant but for clarity)
      else if ((isTeamLead || isManager) && isSender) {
        msg.approvalStatus = null;
      }

      // 🔥 ADDITIONAL GUARD: Ensure original Managers and Team Lead senders never get "pending" status
      if (msg.approvalStatus === "pending") {
        if (isOriginalSenderManager || isOriginalSenderTeamLead) {
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
      { path: "sender", select: "_id name companyEmail role designation" },
      { path: "receiver", select: "_id name companyEmail role designation" },
      { path: "client", select: "_id clientName assignedTo" },
      { path: "attachments.uploadedBy", select: "_id name companyEmail" },
      { path: "scheduledBy", select: "_id name companyEmail" },
      { path: "editedBy", select: "_id name companyEmail" },
      { path: "replyContent.originalSender", select: "_id name companyEmail" },
      { path: "repliedTo", select: "_id note message sender attachments" },
    ]);

    // Prepare response data with edit information
    const responseData = {
      ...populated.toObject(),
      note: msg.note, // Explicitly include note to avoid disappearing issues
      message: msg.note, // FE expects message as well
      subject: msg.subject,
      approvalStatus: msg.approvalStatus,
      isEdited: msg.isEdited,
      editedAt: msg.editedAt,
      editedBy: populated.editedBy,
      editHistory: msg.editHistory || [],
      clientSupervision: clientSupervision,
      requiresApproval: clientRequiresApproval,
    };

    // Declare at function scope so it's reachable outside the if(io) block
    let forwardedMessage = null;

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

      const involvedUsersArray = Array.from(allInvolvedUsers);

      // 🔥 NEW: FORWARD TO MANAGERS WHEN TEAM LEAD EDITS AND APPROVES
      // Only forward if client requires approval
      if (
        hasContentChanges &&
        isTeamLead &&
        !isSender &&
        msg.approvalStatus === "approved" &&
        clientRequiresApproval &&
        !msg.isGroupMessage &&
        !msg.groupId &&
        msg.chatType !== "group"
      ) {
        // ✅ Forward only if sender was an Employee under supervision
        if (isOriginalSenderEmployee) {
          const { managers } = await findTLsAndManagersByOwner(msg.owner);
          // Filter managers who aren't already involved in the chat
          const managersToForward = managers.filter(mId => !allInvolvedUsers.has(String(mId)));

          if (managersToForward.length > 0) {
            try {
              const forwardMsgData = {
                owner: msg.owner,
                client: msg.client,
                sender: msg.sender,
                receiver: managersToForward,
                subject: `Approved: ${msg.subject || "No Subject"}`,
                note: msg.note || "",
                attachments: msg.attachments,
                approvalStatus: "approved",
                isReply: msg.isReply,
                repliedTo: msg.repliedTo,
                replyContent: msg.replyContent,
                isForwarded: true,
                originalMessage: msg._id,
                forwardedBy: req.employee._id,
                isScheduled: msg.isScheduled,
                status: msg.status,
                scheduledFor: msg.scheduledFor,
                scheduledAt: msg.scheduledAt,
                scheduledBy: msg.scheduledBy,
                clientSupervision: clientSupervision,
              };

              const forwardMsg = await WhatsAppMessage.create(forwardMsgData);

              forwardedMessage = await forwardMsg.populate([
                { path: "owner", select: "_id name companyEmail" },
                { path: "sender", select: "_id name companyEmail role designation" },
                { path: "receiver", select: "_id name companyEmail role designation" },
                { path: "client", select: "_id clientName assignedTo" },
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
                  });
                }
              });
            } catch (forwardError) {
              console.error("❌ Failed to forward message to managers:", forwardError);
            }
          }
        }
      }

      // Determine the main action type for the original message
      let mainAction = "edited";
      if (msg.approvalStatus === "approved" && hasContentChanges) {
        mainAction = "auto_approved";
      } else if (msg.approvalStatus === "pending" && hasContentChanges) {
        mainAction = "pending_approval";
      }

      // Emit ONE event to ALL involved users for the original message update
      involvedUsersArray.forEach((userId) => {
        io.to(`employee_${userId}`).emit("new_message", {
          message: responseData,
          type: "message_updated",
          action: mainAction,
          editedBy: req.employee._id,
          timestamp: new Date(),
          clientSupervision: clientSupervision,
        });
      });

      // Special notification for OTHER team leads if it became pending
      if (mainAction === "pending_approval") {
        const { tls } = await findTLsAndManagersByOwner(msg.owner);
        tls.forEach((teamLeadId) => {
          if (teamLeadId !== String(req.employee._id) && !allInvolvedUsers.has(String(teamLeadId))) {
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
      // Root level fields for maximum compatibility
      note: msg.note,
      messageContent: msg.note,
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
    const msg = await WhatsAppMessage.findById(req.params.id).populate([
      { path: "client", select: "_id supervision" },
    ]);
    if (!msg) return res.status(404).json({ error: "Not found" });

    // 🔥 CRITICAL FIX: Prevent direct updates that bypass approval workflow
    const clientSupervision = msg.client?.supervision || "direct";
    const clientRequiresApproval = clientSupervision === "needs_approval";

    // If message requires approval and is currently pending/already approved, 
    // must go through editMessage endpoint instead
    if (clientRequiresApproval && msg.approvalStatus) {
      return res.status(403).json({
        error: "Messages requiring approval must be edited via /edit endpoint to maintain approval workflow",
        endpoint: `/api/whatsapp-messages/${msg._id}/edit`,
        currentApprovalStatus: msg.approvalStatus,
      });
    }

    if (typeof subject === "string") msg.subject = subject;
    if (typeof note === "string") msg.note = note;

    await msg.save();
    const populated = await msg.populate([
      { path: "owner", select: "_id name companyEmail" },
      { path: "sender", select: "_id name companyEmail role designation" },
      { path: "receiver", select: "_id name companyEmail role designation" },
      { path: "client", select: "_id clientName assignedTo" },
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

// DELETE /api/whatsapp-messages/:id
// Query param: ?deleteType=me | everyone (default: me)
exports.deleteMessage = async function deleteMessage(req, res) {
  try {
    const { id } = req.params;
    const deleteType = req.query.deleteType || "me"; // "me" or "everyone"
    const currentUserId = String(req.employee._id);

    const msg = await WhatsAppMessage.findById(id);
    if (!msg) return res.status(404).json({ error: "Not found" });

    // Approved messages cannot be deleted by anyone
    if (msg.approvalStatus === "approved") {
      return res.status(403).json({ error: "Approved messages cannot be deleted" });
    }

    // Only the sender can delete their own message
    if (String(msg.sender) !== currentUserId) {
      return res.status(403).json({ error: "Only the sender can delete this message" });
    }

    const io = req.app.get("io");

    if (deleteType === "everyone") {
      // Only the original sender can delete for everyone
      const senderId = String(msg.sender);
      if (senderId !== currentUserId) {
        return res
          .status(403)
          .json({ error: "Only the sender can delete for everyone" });
      }

      // Soft-delete: mark as deleted for everyone, clear content
      msg.deletedForEveryone = true;
      msg.deletedAt = new Date();
      msg.note = "";
      msg.subject = msg.subject || "";
      msg.attachments = [];
      await msg.save();

      const populated = await msg.populate([
        { path: "sender", select: "_id name companyEmail role designation" },
        { path: "receiver", select: "_id name companyEmail role designation" },
        { path: "client", select: "_id clientName assignedTo" },
      ]);

      // If this message is the chat's current sidebar preview, mark it deleted so
      // the chat list shows the "This message was deleted" placeholder (WhatsApp).
      // A client-employee sub-chat and its PARENT client chat are separate rows,
      // so a CE deletion must only affect the CE row — never the parent client.
      let previewDeleted = false;
      if (msg.client && !msg.isGroupMessage) {
        const clientId = msg.client?._id || msg.client;

        if (msg.isClientEmployeeMessage) {
          // CE sub-chat: its sidebar preview is the latest CE message for this
          // employee (computed live in getChatList), so just decide whether the
          // deleted message was that latest one.
          const latestCE = await WhatsAppMessage.findOne({
            client: clientId,
            isClientEmployeeMessage: true,
            clientEmployeeId: msg.clientEmployeeId,
            status: { $ne: "draft" },
            $or: [{ approvalStatus: null }, { approvalStatus: "approved" }],
          })
            .sort({ createdAt: -1 })
            .select("_id")
            .lean()
            .catch(() => null);
          previewDeleted = !!latestCE && String(latestCE._id) === String(msg._id);
        } else {
          // Parent client chat: compare against the denormalized preview timestamp.
          const ClientInfo = require("../models/ClientInfo");
          const clientDoc = await ClientInfo.findById(clientId)
            .select("lastWhatsAppMessage.at")
            .lean()
            .catch(() => null);
          const previewAt = clientDoc?.lastWhatsAppMessage?.at
            ? new Date(clientDoc.lastWhatsAppMessage.at).getTime()
            : 0;
          const msgAt = msg.createdAt ? new Date(msg.createdAt).getTime() : 0;
          if (previewAt && msgAt && Math.abs(previewAt - msgAt) < 1000) {
            previewDeleted = true;
            await ClientInfo.findByIdAndUpdate(
              clientId,
              { $set: { "lastWhatsAppMessage.text": "", "lastWhatsAppMessage.deleted": true, "lastWhatsAppMessage.hasAttachments": false } },
              { timestamps: false }
            ).catch(() => {});
          }
        }
      }

      // Notify ALL participants in real-time
      if (io) {
        const participants = new Set([senderId]);
        if (Array.isArray(msg.receiver)) {
          msg.receiver.forEach((r) => participants.add(String(r._id || r)));
        }
        participants.forEach((uid) => {
          io.to(`employee_${uid}`).emit("new_message", {
            message: populated,
            type: "message_deleted_for_everyone",
            // tells the client whether to update the sidebar last-message preview
            previewDeleted,
          });
        });
      }

      return res.json({ ok: true, deletedForEveryone: true, message: populated });
    } else {
      // Delete for me only — add currentUser to deletedForUsers array
      const alreadyDeleted = msg.deletedForUsers.some(
        (uid) => String(uid) === currentUserId
      );
      if (!alreadyDeleted) {
        msg.deletedForUsers.push(currentUserId);
        await msg.save();
      }

      // No socket emission needed — it's a personal hide-only action
      return res.json({ ok: true, deletedForMe: true });
    }
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to delete message" });
  }
};

// DELETE /api/whatsApp-messages/chats/:clientId?clientEmployeeId=...
// Deletes an entire chat (client chat or client-employee sub-chat) and
// notifies every employee who can see it so their chat list updates live.
exports.deleteChat = async function deleteChat(req, res) {
  try {
    const { clientId } = req.params;
    const clientEmployeeId = req.query.clientEmployeeId
      ? String(req.query.clientEmployeeId)
      : null;

    if (!isObjId(clientId)) {
      return res.status(400).json({ error: "Invalid client ID" });
    }

    const owner = req.employee?.owner || req.employee?._id;
    const currentUserId = String(req.employee._id);
    const ClientInfo = require("../models/ClientInfo");

    const clientDoc = await ClientInfo.findOne({ _id: clientId, owner })
      .select("_id assignedTo supervisedBy")
      .lean();
    if (!clientDoc) return res.status(404).json({ error: "Chat not found" });

    // Participants are notified via socket below; only CRM (manager) or
    // owner roles may delete a chat ("crm" normalizes to "manager")
    const participantIds = []
      .concat(clientDoc.assignedTo || [], clientDoc.supervisedBy || [])
      .map((id) => String(id._id || id));
    const role = normalizeRole(req.employee?.role || "");
    const canDelete = role === "manager" || role === "owner";
    if (!canDelete) {
      return res
        .status(403)
        .json({ error: "Only CRM (manager) can delete chats" });
    }

    const q = {
      owner,
      client: clientId,
      isGroupMessage: { $ne: true },
    };
    if (clientEmployeeId) {
      q.isClientEmployeeMessage = true;
      q.clientEmployeeId = clientEmployeeId;
    } else {
      q.isClientEmployeeMessage = { $ne: true };
    }

    const result = await WhatsAppMessage.deleteMany(q);

    // Clear the cached last-message preview when the main client chat is removed
    if (!clientEmployeeId) {
      await ClientInfo.findByIdAndUpdate(
        clientId,
        { $unset: { lastWhatsAppMessage: "" } },
        { timestamps: false }
      ).catch(() => {});
    }

    const io = req.app.get("io");
    if (io) {
      const payload = {
        clientId: String(clientId),
        clientEmployeeId,
        chatId: clientEmployeeId
          ? `client_employee_${clientId}_${clientEmployeeId}`
          : String(clientId),
        deletedBy: { _id: currentUserId, name: req.employee?.name || "" },
        deletedCount: result.deletedCount,
        at: new Date(),
      };

      const targets = new Set([currentUserId, ...participantIds]);
      targets.forEach((uid) => {
        io.to(`employee_${uid}`).emit("whatsapp_chat_deleted", payload);
      });
      // Anyone currently viewing this client's chat room
      io.to(`client_${clientId}`).emit("whatsapp_chat_deleted", payload);
    }

    return res.json({ ok: true, deletedCount: result.deletedCount });
  } catch (e) {
    console.error("❌ Error deleting chat:", e);
    res.status(500).json({ error: "Failed to delete chat" });
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
      { path: "owner", select: "_id name companyEmail" },
      { path: "sender", select: "_id name companyEmail role designation" },
      { path: "receiver", select: "_id name companyEmail role designation" },
      { path: "client", select: "_id clientName assignedTo" },
      { path: "attachments.uploadedBy", select: "_id name companyEmail" },
      { path: "scheduledBy", select: "_id name companyEmail" },
      { path: "repliedTo", select: "_id note message sender attachments" },
      { path: "replyContent.originalSender", select: "_id name companyEmail" },
    ]);

    // FIXED: Emit new_message event ONLY to relevant users
    if (req.app.get("io")) {
      const io = req.app.get("io");

      const senderId = populated.sender?._id || populated.sender;

      // Construct a response object similar to createMessage for consistency
      const responseEvent = {
        ...populated.toObject(),
        parentClientId: populated.client?._id || populated.client,
        requiresApproval: populated.approvalStatus === "pending",
        isClientEmployeeChat: populated.isClientEmployeeMessage,
      };

      // Notify ONLY the sender about attachment upload
      if (senderId) {
        io.to(`employee_${senderId}`).emit("new_message", {
          message: responseEvent,
          type: "attachments_uploaded",
        });
      }

      // Notify ONLY the actual receivers about new attachments
      if (Array.isArray(populated.receiver)) {
        populated.receiver.forEach((r) => {
          const receiverId = r?._id || r;
          if (receiverId) {
            io.to(`employee_${receiverId}`).emit("new_message", {
              message: responseEvent,
              type: "attachments_added",
            });
          }
        });
      }
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
          { path: "sender", select: "_id name companyEmail role designation" },
          { path: "receiver", select: "_id name companyEmail role designation" },
          { path: "client", select: "_id clientName assignedTo" },
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
      { path: "sender", select: "_id name companyEmail role designation" },
      { path: "receiver", select: "_id name companyEmail role designation" },
      { path: "client", select: "_id clientName assignedTo" },
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

// GET /:id/seen-by — list the employees who have READ this message (for the
// message-info dialog). Excludes the sender; sorted by when they read it.
exports.getSeenBy = async function getSeenBy(req, res) {
  try {
    const { id } = req.params;
    if (!isObjId(id)) return res.status(400).json({ error: "Invalid message id" });

    const ownerId = req.employee?.owner;
    const msg = await WhatsAppMessage.findOne({ _id: id, owner: ownerId })
      .select("seenBy sender")
      .populate({
        path: "seenBy.employee",
        select: "_id name companyEmail role designation photographUrl",
      })
      .lean();

    if (!msg) return res.status(404).json({ error: "Message not found" });

    const senderId = String(msg.sender || "");
    // De-duplicate: the same employee can appear multiple times in seenBy
    // (e.g. seen on multiple devices/sessions). Keep one entry per employee
    // with their EARLIEST read time.
    const byEmployee = new Map();
    for (const s of msg.seenBy || []) {
      if (!s.employee || !s.employee._id) continue;
      const id = String(s.employee._id);
      if (id === senderId) continue; // exclude the sender
      const seenAt = s.seenAt || null;
      const existing = byEmployee.get(id);
      if (!existing) {
        byEmployee.set(id, {
          _id: s.employee._id,
          name: s.employee.name,
          companyEmail: s.employee.companyEmail,
          role: s.employee.role,
          designation: s.employee.designation,
          photographUrl: s.employee.photographUrl || null,
          seenAt,
        });
      } else if (
        seenAt &&
        (!existing.seenAt || new Date(seenAt) < new Date(existing.seenAt))
      ) {
        existing.seenAt = seenAt; // keep the earliest timestamp
      }
    }

    const readers = Array.from(byEmployee.values()).sort(
      (a, b) =>
        new Date(a.seenAt || 0).getTime() - new Date(b.seenAt || 0).getTime(),
    );

    return res.json({ count: readers.length, readers });
  } catch (e) {
    console.error("Error fetching seen-by:", e);
    return res.status(500).json({ error: "Failed to fetch read receipts" });
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

      const { clientEmployeeId, isClientEmployeeMessage, isGroupMessage } = req.query;

      if (!isObjId(clientId)) {
        return res.status(400).json({ error: "Valid ID required" });
      }

      const q = {
        receiver: currentUserId,
        sender: { $ne: currentUserId },
      };

      if (isGroupMessage === "true") {
        q.isGroupMessage = true;
        q.groupId = clientId;
      } else {
        q.client = clientId;
        if (isClientEmployeeMessage === "true" && clientEmployeeId) {
          q.isClientEmployeeMessage = true;
          q.clientEmployeeId = clientEmployeeId;
        } else if (isClientEmployeeMessage === "false") {
          q.isClientEmployeeMessage = { $ne: true };
        }
      }

      if (isClientEmployeeMessage === "true" && clientEmployeeId) {
        q.isClientEmployeeMessage = true;
        q.clientEmployeeId = clientEmployeeId;
      } else if (isClientEmployeeMessage === "false") {
        q.isClientEmployeeMessage = { $ne: true };
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

      // 🔥 NEW: Calculate pending approval count
      const pendingQ = {
        ...q,
        approvalStatus: "pending",
      };

      const pendingApprovalCount = await WhatsAppMessage.countDocuments(pendingQ);

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
        pendingApprovalCount,
      });
    } catch (e) {
      console.error("Error fetching seen status:", e);
      res.status(500).json({ error: "Failed to fetch seen status" });
    }
  };

exports.markAllMessagesAsSeen = async function markAllMessagesAsSeen(req, res) {
  try {
    const { clientId } = req.params;
    const { clientEmployeeId, isClientEmployeeMessage, isGroupMessage } = req.body || {};
    const currentUserId = req.employee._id;

    if (!isObjId(clientId)) {
      return res.status(400).json({ error: "Valid ID required" });
    }

    const q = {
      receiver: currentUserId,
      sender: { $ne: currentUserId }, // Exclude own messages
      "seenBy.employee": { $ne: currentUserId }, // Not already seen
    };

    if (isGroupMessage === true) {
      q.isGroupMessage = true;
      q.groupId = clientId;
    } else {
      q.client = clientId;
      if (isClientEmployeeMessage === true && clientEmployeeId) {
        q.isClientEmployeeMessage = true;
        q.clientEmployeeId = clientEmployeeId;
      } else if (isClientEmployeeMessage === false) {
        q.isClientEmployeeMessage = { $ne: true };
      }
    }

    // Find all unread messages for this client/employee where current user is a
    // receiver. Only the fields needed for the real-time emit are selected — the
    // actual seen-write is done atomically below.
    const unreadMessages = await WhatsAppMessage.find(q).select("_id sender receiver");

    // Mark them as seen with a single atomic write. We deliberately use
    // updateMany($push) instead of loading each doc and calling .save():
    // .save() revalidates the ENTIRE document, so a single legacy/forwarded
    // message that violates schema validation (e.g. a stray/empty value in the
    // `required` receiver array) would throw, reject Promise.all, and abandon
    // the whole batch — leaving messages unread again after a refresh.
    // $push touches only seenBy and skips full-document validation.
    if (unreadMessages.length > 0) {
      await WhatsAppMessage.updateMany(q, {
        $push: { seenBy: { employee: currentUserId, seenAt: new Date() } },
      });
    }

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
        { path: "client", select: "_id clientName assignedTo" },
        { path: "sender", select: "_id name companyEmail role designation" },
        { path: "owner", select: "_id name companyEmail" },
        { path: "groupId", select: "_id name" },
      ])
      .select(
        "_id note message subject sender client createdAt receiver status approvalStatus isGroupMessage groupId chatType",
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
// GET /api/whatsApp-messages/mentionables?groupId=...|clientId=...
// Returns the people who can be @mentioned in a chat: every group member for a
// group, or (for a client / client-employee chat) the client's employees plus
// the internal employees assigned to / supervising that client.
exports.getMentionables = async function getMentionables(req, res) {
  try {
    const { groupId, clientId } = req.query;
    const owner = req.employee?.owner;
    if (!owner) return res.status(401).json({ error: "Unauthorized" });

    const out = [];
    const seen = new Set();
    const push = (refId, name, type, avatar) => {
      const id = refId ? String(refId) : "";
      const nm = (name || "").trim();
      if (!id || !nm) return;
      const key = `${type}:${id}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ refId: id, name: nm, type, avatar: avatar || null });
    };

    if (groupId && isObjId(groupId)) {
      const group = await WhatsAppGroup.findOne({ _id: groupId, owner }).lean();
      if (group) {
        const members = group.members || [];
        // Resolve employee members' name + photo from the Employee collection.
        const empMemberIds = members
          .filter((m) => m.memberType === "employee" && isObjId(m.memberId))
          .map((m) => m.memberId);
        let empMap = {};
        if (empMemberIds.length) {
          const emps = await Employee.find({ _id: { $in: empMemberIds } })
            .select("_id name photographUrl")
            .lean();
          empMap = Object.fromEntries(emps.map((e) => [String(e._id), e]));
        }
        // Resolve client members' name + photo from the ClientInfo collection.
        const clientMemberIds = members
          .filter((m) => m.memberType === "client" && isObjId(m.memberId))
          .map((m) => m.memberId);
        let clientMap = {};
        if (clientMemberIds.length) {
          const ClientInfo = require("../models/ClientInfo");
          const clients = await ClientInfo.find({ _id: { $in: clientMemberIds } })
            .select("_id clientName photographUrl")
            .lean();
          clientMap = Object.fromEntries(clients.map((c) => [String(c._id), c]));
        }
        for (const m of members) {
          if (m.memberType === "employee") {
            const e = empMap[String(m.memberId)];
            push(m.memberId, m.memberName || e?.name, "employee", e?.photographUrl);
          } else if (m.memberType === "client_employee") {
            push(m.memberId, m.memberName, "client_employee", m.memberAvatar);
          } else if (m.memberType === "client") {
            const c = clientMap[String(m.memberId)];
            push(m.memberId, m.memberName || c?.clientName, "client", c?.photographUrl);
          }
        }
      }
    } else if (clientId && isObjId(clientId)) {
      const { clientEmployeeId } = req.query;
      const ClientInfo = require("../models/ClientInfo");
      const client = await ClientInfo.findOne({ _id: clientId, owner })
        .populate("assignedTo", "_id name photographUrl")
        .populate("supervisedBy", "_id name photographUrl")
        .select("clientName photographUrl companyEmployees assignedTo supervisedBy")
        .lean();
      if (client) {
        if (clientEmployeeId) {
          // Client-employee sub-chat → the client side is the client's
          // employees (a "client employee" IS a companyEmployees entry). List
          // them all so the one being chatted with is always available, without
          // relying on a possibly-legacy clientEmployeeId matching the subdoc _id.
          (client.companyEmployees || []).forEach((ce) =>
            push(ce._id, ce.name, "client_employee", ce.photographUrl),
          );
        } else {
          // Parent client chat → the client side is the CLIENT itself, not its
          // individual employees (each of those has its own sub-chat).
          push(client._id, client.clientName, "client", client.photographUrl);
        }
        // Internal team on this client is mentionable in either case.
        (client.assignedTo || []).forEach((e) =>
          push(e._id, e.name, "employee", e.photographUrl),
        );
        (client.supervisedBy || []).forEach((e) =>
          push(e._id, e.name, "employee", e.photographUrl),
        );
      }
    }

    // Never include the requester themselves.
    const meId = String(req.employee._id);
    return res.json({
      mentionables: out.filter((m) => !(m.type === "employee" && m.refId === meId)),
    });
  } catch (e) {
    console.error("getMentionables error:", e);
    return res.status(500).json({ error: "Failed to load mentionables" });
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
      // 🔥 NEW: Add group fields
      isGroupMessage,
      groupId,
      chatType,
      // @mentions referenced in the message text
      mentions,
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

      // The client employee name/designation may arrive as top-level fields OR
      // nested inside a clientEmployeeData object (the frontend sends the latter).
      // Read both so the stored name isn't lost → otherwise the sidebar shows
      // the generic "Employee (Client)" fallback.
      const bodyCED = req.body.clientEmployeeData || {};
      const resolvedName =
        clientEmployeeName ||
        bodyCED.clientEmployeeName ||
        bodyCED.name ||
        null;
      const resolvedDesignation =
        clientEmployeeDesignation ||
        bodyCED.clientEmployeeDesignation ||
        bodyCED.designation ||
        "";

      // Store client employee info in message metadata
      clientEmployeeData = {
        clientEmployeeId,
        clientEmployeeName: resolvedName,
        clientEmployeeDesignation: resolvedDesignation,
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
      .select("supervision supervisedBy clientName assignedTo")
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

    // 🔥 MANAGER/CRM LOGIC
    // CRM is the top authority — no approval needed for their outgoing messages.
    // Supervisors receive approval notifications only; client messages go to assigned employees only.
    if (senderRole === "manager") {
      // Only add assigned employees as receivers — supervisors are not notified of client messages
      if (!isGroupMessage && !groupId && assignedEmployeeIds.length > 0) {
        assignedEmployeeIds.forEach(empId => {
          if (empId && empId !== String(sender) && !receivers.includes(empId)) {
            receivers.push(empId);
          }
        });
      }

      approvalStatus = null;
    }
    // 👷 EMPLOYEE / TEAM LEAD LOGIC
    // Team leads follow the same approval chain as employees — no auto-approval bypass.
    else if (senderRole === "employee" || senderRole === "team_lead") {
      if (!isGroupMessage && !groupId && assignedEmployeeIds.length > 0) {
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

    // Group messages are now strictly isolated to group members.
    // We no longer automatically push managers/supervisors into the receivers array for group messages.
    if (isGroupMessage || chatType === 'group' || groupId) {
      // Add CRM (Optional, keep if CRM strictly needs to monitor all groups)
      const crmEmployeeId = process.env.CRM_EMPLOYEE_ID;
      if (crmEmployeeId && !receivers.includes(crmEmployeeId) && crmEmployeeId !== String(sender)) {
        receivers.push(crmEmployeeId);
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

          // FIX: Filter original receivers by supervision status
          const supervisedByList = (clientDoc?.supervisedBy || []).map(id => String(id));
          originalReceivers.forEach((receiverId) => {
            if (
              receiverId !== String(sender) &&
              !receivers.includes(receiverId)
            ) {

              const isSupervisorWithEnabledSupervision = supervisedByList.includes(receiverId);
              const isSeniorInHierarchy = async () => {
                const hierarchyLink = await EmployeeHierarchy.findOne({
                  owner: owner,
                  junior: String(sender),
                  senior: receiverId
                }).lean();
                return !!hierarchyLink;
              };

              // For now, add all - but the supervision check below will clear receivers
              // and set only the active supervisors when needsApproval is true
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
              // Route to immediate senior in hierarchy (one level at a time),
              // regardless of role. The full chain (employee → ... → manager)
              // is followed.
              const immediateSups = await findSupervisorsFromHierarchy(owner, String(sender));

              if (immediateSups.length > 0) {
                receivers = [immediateSups[0]];
                approvalStatus = "pending";
              } else {
                // Sender is top of the hierarchy (no one's junior) — there is no
                // senior to approve, so the message is auto-APPROVED (green tick).
                // Mirrors the non-reply path's "top of hierarchy" handling below.
                approvalStatus = "approved";
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
            // Manager (top senior) reply → auto-approved on supervised clients.
            approvalStatus = needsApproval ? "approved" : null;
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
            ) &&
            // 🔥 FIX: Never add the original sender to receivers if the reply needs approval
            // (They shouldn't see it as a 'pending' task in their sidebar)
            approvalStatus !== "pending" &&
            !needsApproval
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
        // Manager sits at the top of the hierarchy — on a supervised
        // (needs_approval) client their message is automatically APPROVED (no
        // senior above to approve it); on a direct client it's a plain send.
        approvalStatus = needsApproval ? "approved" : null;
      } else if (needsApproval) {
        // Route to the immediate senior in the hierarchy — regardless of role.
        // The full hierarchy chain is followed: e.g. Abdur Rahman New → Ali →
        // Abdullah Ahmed Qureshi (manager). Every level approves explicitly.
        console.log("📨 [createMessage] Looking up hierarchy from DB for sender:", String(sender));
        const immediateSupervisors = await findSupervisorsFromHierarchy(owner, String(sender));
        console.log("📨 [createMessage] Immediate supervisors from DB:", immediateSupervisors);

        if (immediateSupervisors.length > 0) {
          approvalStatus = "pending";
          receivers = [immediateSupervisors[0]];
          console.log("✅ [createMessage] Routing to immediate hierarchy supervisor:", immediateSupervisors[0]);
        } else {
          // Sender is the highest-level person in the hierarchy (no one above
          // them). There is no senior to approve, so the message is
          // automatically APPROVED (shows the green tick).
          console.log("✅ [createMessage] Sender is top of hierarchy — auto-approving:", String(sender));
          approvalStatus = "approved";
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

    // 🔥 FINAL SAFEGUARD: For PENDING messages, strictly enforce that receivers are ONLY approvers
    // (This prevents coworkers or original senders from seeing a yellow badge for a task they can't action)
    // 🔥 CRITICAL: Preserve ALL intended receivers for when message is approved
    const intendedReceivers = [...receivers];

    if (approvalStatus === "pending") {
      // Build a complete allowlist: supervisedBy + TLs + managers + everyone
      // in the sender's hierarchy chain (so mid-level employees like Ali are allowed)
      const seniors = (clientDoc?.supervisedBy || []).map(id => String(id));
      const hierarchyChain = await getManagementChainFromHierarchy(owner, String(sender));
      const allSeniors = new Set([...seniors, ...tls, ...managers, ...hierarchyChain].map(id => String(id)));

      const beforeFilter = [...receivers];
      receivers = receivers.filter(id => allSeniors.has(String(id)));
      console.log("🔒 [createMessage] PENDING safeguard — beforeFilter:", beforeFilter, "→ afterFilter:", receivers);
    }

    console.log("📬 [createMessage] FINAL receivers (will be stored in msg.receiver):", receivers);
    console.log("📬 [createMessage] approvalStatus:", approvalStatus);

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
      // Group messaging fields
      isGroupMessage: isGroupMessage || false,
      groupId: groupId || null,
      chatType: chatType || (isGroupMessage ? 'group' : 'normal'),
      intendedReceivers: intendedReceivers, // 🔥 PRESERVE FOR APPROVAL
    };

    // Store the full ordered approval chain for display in message Info
    if (approvalStatus === "pending" && needsApproval) {
      const supervisedByList = (clientDoc?.supervisedBy || []).map(id => String(id));
      msgData.plannedApprovalChain = await computeFullApprovalChain(owner, String(sender), supervisedByList);
    }

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
      { path: "sender", select: "_id name companyEmail role designation" },
      { path: "receiver", select: "_id name companyEmail role designation" },
      { path: "client", select: "_id clientName assignedTo" },
      { path: "scheduledBy", select: "_id name companyEmail" },
      { path: "repliedTo", select: "_id note message sender attachments" },
      { path: "replyContent.originalSender", select: "_id name companyEmail" },
      // Populate the full planned approval chain so the message-info dialog can
      // immediately list every senior the message will route through.
      { path: "plannedApprovalChain", select: "_id name role designation" },
    ]);

    // 🔔 Notify @mentioned employees in real time (client-employee mentions
    // have no app account to notify).
    try {
      const ioM = req.app.get("io");
      if (ioM && !isScheduled && Array.isArray(msgData.mentions) && msgData.mentions.length) {
        const mentionSenderName = populated.sender?.name || "Someone";
        const mentionPreview = (note || "").replace(/<[^>]*>/g, "").slice(0, 120);
        msgData.mentions
          .filter(
            (m) =>
              m.type === "employee" &&
              isObjId(m.refId) &&
              String(m.refId) !== String(sender),
          )
          .forEach((m) => {
            ioM.to(`employee_${m.refId}`).emit("whatsapp_mention", {
              messageId: String(msg._id),
              clientId: String(actualClientId),
              isGroupMessage: !!isGroupMessage,
              groupId: groupId || null,
              isClientEmployeeMessage: isClientEmployeeChat,
              clientEmployeeId: isClientEmployeeChat ? clientEmployeeId : null,
              senderName: mentionSenderName,
              preview: mentionPreview,
            });
          });
      }
    } catch (e) {
      console.warn("mention notify failed:", e.message);
    }

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

      // Scheduled messages are delivered by the scheduler at the appointed time.
      // Do NOT notify receivers now — only notify when status transitions to "sent".
      if (!isScheduled) {
        // Get sender's hierarchy supervisors for checking notifications
        const senderSupervisors = await findSupervisorsFromHierarchy(
          owner,
          String(sender)
        );

        receivers.forEach((receiverId) => {
          const isReceiverTeamLead = tls.includes(receiverId);
          const isReceiverManager = managers.includes(receiverId);

          const isReceiverHierarchySupervisor =
            senderSupervisors.includes(receiverId) ||
            receivers.includes(String(receiverId));

          const shouldNotify =
            responseWithSupervision.approvalStatus === "approved" ||
            responseWithSupervision.approvalStatus === null ||
            (responseWithSupervision.approvalStatus === "pending" &&
              (isReceiverTeamLead || isReceiverManager || isReceiverHierarchySupervisor));

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
      }

      // Notify hierarchy seniors of the sender so they receive real-time updates
      if (!isScheduled && (responseWithSupervision.approvalStatus === null || responseWithSupervision.approvalStatus === "approved")) {
        const hierarchySeniors = await getManagementChainFromHierarchy(owner, String(sender));
        hierarchySeniors.forEach((seniorId) => {
          const sid = String(seniorId);
          if (sid && sid !== String(sender) && !receivers.includes(sid)) {
            io.to(`employee_${sid}`).emit("new_message", {
              message: responseWithSupervision,
              type: "new_assignment",
              action: "received",
              isClientEmployeeChat: isClientEmployeeChat,
            });
          }
        });
      }

      if (!isScheduled && responseWithSupervision.approvalStatus !== "pending") {
        if (isGroupMessage || (responseWithSupervision.isGroupMessage && responseWithSupervision.groupId)) {
          const targetGroupId = groupId || responseWithSupervision.groupId;
          if (targetGroupId) {
            io.to(`group_${targetGroupId}`).emit("new_message", {
              message: responseWithSupervision,
              type: "new_assignment",
              action: "created",
              isClientEmployeeChat: isClientEmployeeChat,
            });
          }
        }
      }

      // Team lead special notifications — skip for scheduled messages
      if (!isScheduled && senderRole === "team_lead" && assignedEmployeeIds.length > 0) {
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
        !isScheduled &&
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

    // Denormalize last message onto ClientInfo for fast sidebar loading.
    // SKIP pending messages — they are only visible to the designated approver,
    // so writing them to lastWhatsAppMessage would expose the preview text to
    // all employees who are assigned/supervising the client.
    // The sidebar should only show the last approved/direct message.
    if (
      responseWithSupervision.client &&
      !responseWithSupervision.isGroupMessage &&
      // A client-employee sub-chat is a SEPARATE conversation — its messages must
      // not overwrite the parent client row's preview in the sidebar.
      !responseWithSupervision.isClientEmployeeMessage &&
      responseWithSupervision.approvalStatus !== "pending" &&
      !isScheduled
    ) {
      const clientId = responseWithSupervision.client?._id || responseWithSupervision.client;
      if (clientId) {
        const ClientInfo = require("../models/ClientInfo");
        ClientInfo.findByIdAndUpdate(clientId, {
          $set: {
            "lastWhatsAppMessage.text": (responseWithSupervision.note || "").replace(/<[^>]*>/g, "").slice(0, 200),
            "lastWhatsAppMessage.at": responseWithSupervision.createdAt || new Date(),
            "lastWhatsAppMessage.senderId": responseWithSupervision.sender?._id || responseWithSupervision.sender,
            "lastWhatsAppMessage.hasAttachments": Array.isArray(responseWithSupervision.attachments) && responseWithSupervision.attachments.length > 0,
            "lastWhatsAppMessage.deleted": false,
          },
        }, { timestamps: false }).catch(() => {}); // fire-and-forget, non-blocking
      }
    }

    res.status(201).json(responseWithSupervision);
  } catch (e) {
    console.error("❌ Create message error:", e);
    res.status(500).json({ error: "Failed to create assignment message" });
  }
};

/**
 * Background repair of denormalized `lastWhatsAppMessage` on ClientInfo.
 * Runs the expensive last-message-per-client aggregation OUTSIDE the request
 * path (throttled per employee) so the chat-list response never waits for it.
 */
const _chatListRepairAt = new Map(); // employeeId -> last repair timestamp
const CHAT_LIST_REPAIR_INTERVAL_MS = 2 * 60 * 1000;

async function repairLastWhatsAppMessages(ownerObjId, clients) {
  const ClientInfo = require("../models/ClientInfo");
  const ids = clients.map((c) => c._id);
  if (ids.length === 0) return;

  const latest = await WhatsAppMessage.aggregate([
    {
      $match: {
        owner: ownerObjId,
        client: { $in: ids },
        isGroupMessage: { $ne: true },
        isClientEmployeeMessage: { $ne: true },
        status: { $ne: "draft" },
        $or: [{ approvalStatus: null }, { approvalStatus: "approved" }],
      },
    },
    // Slim each doc BEFORE sort/group — full messages carry embedded comments,
    // attachments, edit history etc. and make the sort stage very slow.
    {
      $project: {
        client: 1,
        createdAt: 1,
        sender: 1,
        note: { $substrCP: [{ $ifNull: ["$note", ""] }, 0, 300] },
        hasAtt: { $gt: [{ $size: { $ifNull: ["$attachments", []] } }, 0] },
        deleted: { $eq: ["$deletedForEveryone", true] },
      },
    },
    { $sort: { createdAt: -1 } },
    {
      $group: {
        _id: "$client",
        note: { $first: "$note" },
        at: { $first: "$createdAt" },
        senderId: { $first: "$sender" },
        hasAtt: { $first: "$hasAtt" },
        deleted: { $first: "$deleted" },
      },
    },
  ]);

  const byId = new Map(clients.map((c) => [String(c._id), c]));
  const ops = [];
  for (const row of latest) {
    const cached = byId.get(String(row._id));
    const cachedAt = cached?.lastWhatsAppMessage?.at ? new Date(cached.lastWhatsAppMessage.at).getTime() : 0;
    if (!cachedAt || cachedAt !== new Date(row.at).getTime()) {
      const text = row.deleted ? "" : (row.note || "").replace(/<[^>]*>/g, "").slice(0, 200);
      ops.push({
        updateOne: {
          filter: { _id: row._id },
          update: {
            $set: {
              "lastWhatsAppMessage.text": text,
              "lastWhatsAppMessage.at": row.at,
              "lastWhatsAppMessage.senderId": row.senderId,
              "lastWhatsAppMessage.hasAttachments": row.deleted ? false : row.hasAtt,
              "lastWhatsAppMessage.deleted": !!row.deleted,
            },
          },
        },
      });
    }
  }
  if (ops.length > 0) {
    await ClientInfo.bulkWrite(ops, { ordered: false });
    console.log(`🔧 [chat-list-repair] refreshed lastWhatsAppMessage for ${ops.length} client(s)`);
  }
}

/**
 * GET /whatsApp-messages/chat-list
 *
 * Fast sidebar chat list — O(clients + groups) instead of O(messages).
 *
 * Uses denormalized `lastWhatsAppMessage` on ClientInfo (updated on every send/approve)
 * so this becomes two simple find() queries + two small aggregations, all parallel.
 * The heavy per-client last-message recomputation runs in the background AFTER
 * the response is sent (throttled), never blocking the sidebar.
 */
exports.getChatList = async function getChatList(req, res) {
  try {
    const t0 = Date.now();
    const owner = req.employee?.owner || req.employee?._id;
    const meId = new mongoose.Types.ObjectId(String(req.employee._id));
    const ownerObjId = typeof owner === "string" ? new mongoose.Types.ObjectId(owner) : owner;
    const ClientInfo = require("../models/ClientInfo");
    const currentUserRole = normalizeRole(req.employee?.role || "");
    const isManager = currentUserRole.includes("manager");
    const groupQuery = {
      owner: ownerObjId,
      isActive: true,
    };
    if (!isManager) {
      groupQuery["members.memberId"] = String(meId);
    }

    // ── Kick off groups + unread queries immediately — they don't depend on
    // the client list, so they run in parallel with steps 1 and 2 below.
    const groupsPromise = WhatsAppGroup.find(groupQuery)
      .select("_id name avatar lastMessage lastMessageAt members")
      .sort({ lastMessageAt: -1 })
      .limit(60)
      .lean();

    // Unread per chat — scoped to receiver=me only (fast with index)
    // Client-employee messages use a composite key so their unread badges
    // are tracked independently from the parent client chat.
    const unreadPromise = WhatsAppMessage.aggregate([
      {
        $match: {
          owner: ownerObjId,
          receiver: meId,
          sender: { $ne: meId }, // never count my own messages as unread
          status: { $ne: "draft" },
          // Count pending too: `receiver: meId` already scopes to the message's
          // CURRENT approver, so a pending message contributes to the green
          // unread badge only while it awaits this user — i.e. at each step of
          // the approval hierarchy, matching the per-chat seen-status endpoint.
          $or: [
            { approvalStatus: null },
            { approvalStatus: "approved" },
            { approvalStatus: "pending" },
          ],
          "seenBy.employee": { $ne: meId },
        },
      },
      // Keep only the fields used to build the group key
      {
        $project: {
          isGroupMessage: 1,
          groupId: 1,
          isClientEmployeeMessage: 1,
          client: 1,
          clientEmployeeId: 1,
        },
      },
      {
        $group: {
          _id: {
            $cond: [
              "$isGroupMessage",
              { $toString: "$groupId" },
              {
                $cond: [
                  { $eq: ["$isClientEmployeeMessage", true] },
                  {
                    $concat: [
                      "client_employee_",
                      { $toString: "$client" },
                      "_",
                      { $toString: "$clientEmployeeId" },
                    ],
                  },
                  { $toString: "$client" },
                ],
              },
            ],
          },
          count: { $sum: 1 },
        },
      },
    ]);

    // ── Pending-approval counts per chat (same composite key as unread) ────
    const pendingPromise = WhatsAppMessage.aggregate([
      {
        $match: {
          owner: ownerObjId,
          receiver: meId,
          sender: { $ne: meId },
          approvalStatus: "pending",
        },
      },
      {
        $project: {
          isGroupMessage: 1,
          groupId: 1,
          isClientEmployeeMessage: 1,
          client: 1,
          clientEmployeeId: 1,
        },
      },
      {
        $group: {
          _id: {
            $cond: [
              "$isGroupMessage",
              { $toString: "$groupId" },
              {
                $cond: [
                  { $eq: ["$isClientEmployeeMessage", true] },
                  {
                    $concat: [
                      "client_employee_",
                      { $toString: "$client" },
                      "_",
                      { $toString: "$clientEmployeeId" },
                    ],
                  },
                  { $toString: "$client" },
                ],
              },
            ],
          },
          count: { $sum: 1 },
        },
      },
    ]);

    // ── Clients assigned/supervised to me ──────────────────────────────────
    // Select only the companyEmployees subfields needed for the photo lookup —
    // the full embedded array can be large and slows the query + transfer.
    const clientsPromise = ClientInfo.find({
      owner: ownerObjId,
      $or: [{ assignedTo: meId }, { supervisedBy: meId }],
    })
      .select(
        "_id clientName dba legalBusinessName lastWhatsAppMessage photographUrl companyEmployees._id companyEmployees.name companyEmployees.photographUrl"
      )
      .lean();

    // ── Last message per client-employee conversation ───────────────────────
    // Owner-scoped (no client $in) so it can run in parallel with the clients
    // query; results are filtered to my clients in JS below. This subset is
    // typically small compared to the full message collection.
    const empAggPromise = WhatsAppMessage.aggregate([
      {
        $match: {
          owner: ownerObjId,
          isClientEmployeeMessage: true,
          isGroupMessage: { $ne: true },
          status: { $ne: "draft" },
          $or: [{ approvalStatus: null }, { approvalStatus: "approved" }],
        },
      },
      {
        $project: {
          client: 1,
          createdAt: 1,
          sender: 1,
          clientEmployeeId: 1,
          clientEmployeeData: 1,
          note: { $substrCP: [{ $ifNull: ["$note", ""] }, 0, 300] },
          hasAtt: { $gt: [{ $size: { $ifNull: ["$attachments", []] } }, 0] },
          deleted: { $eq: ["$deletedForEveryone", true] },
        },
      },
      { $sort: { createdAt: -1 } },
      {
        $group: {
          _id: { client: "$client", clientEmployeeId: "$clientEmployeeId" },
          note: { $first: "$note" },
          at: { $first: "$createdAt" },
          senderId: { $first: "$sender" },
          hasAtt: { $first: "$hasAtt" },
          deleted: { $first: "$deleted" },
          clientEmployeeData: { $first: "$clientEmployeeData" },
          clientEmployeeId: { $first: "$clientEmployeeId" },
        },
      },
    ]);

    // ── Run EVERYTHING in parallel — total latency = slowest single query ──
    const [allMyClients, latestPerClientEmployee, groups, unreadRows, pendingRows] = await Promise.all([
      clientsPromise,
      empAggPromise,
      groupsPromise,
      unreadPromise,
      pendingPromise,
    ]);

    const clientById = new Map(allMyClients.map((c) => [String(c._id), c]));
    const pendingMap = new Map(pendingRows.map((r) => [String(r._id), r.count]));

    const unreadMap = new Map(unreadRows.map((r) => [String(r._id), r.count]));

    // ── Build sidebar list — ONLY clients with messages ────────────────────
    const chats = [];

    for (const c of allMyClients) {
      const cid = String(c._id);
      // Read the denormalized last message directly — it is maintained on every
      // send/approve and self-heals via the throttled background repair below.
      const lastMsg = c.lastWhatsAppMessage?.at ? c.lastWhatsAppMessage : null;

      // Skip clients with NO messages at all
      if (!lastMsg?.at) continue;

      const rawText = lastMsg.text || "";
      const cleanText = rawText.replace(/<[^>]*>/g, "").trim();
      const lastDeleted = !!lastMsg.deleted;

      chats.push({
        chatId: cid,
        clientId: cid,
        clientName: c.clientName,
        dba: c.dba,
        legalBusinessName: c.legalBusinessName || null,
        photographUrl: c.photographUrl || null,
        lastMessage: lastDeleted ? "" : (cleanText || (lastMsg.hasAttachments ? "📎 Attachment" : "")),
        lastMessageDeleted: lastDeleted,
        lastMessageAt: lastMsg.at,
        senderId: lastMsg.senderId || null,
        hasAttachments: lastMsg.hasAttachments || false,
        unreadCount: unreadMap.get(cid) || 0,
        hasUnreadMessages: !!(unreadMap.get(cid)),
        pendingApprovalCount: pendingMap.get(cid) || 0,
        isGroupMessage: false,
        isClientEmployeeMessage: false,
      });
    }

    // ── Client-employee conversations — one entry per employee ────────────────
    for (const row of latestPerClientEmployee) {
      const clientId = String(row._id.client);
      const empId = row.clientEmployeeId ? String(row.clientEmployeeId) : String(row._id.clientEmployeeId);
      if (!clientId || !empId || empId === "null" || empId === "undefined") continue;

      const chatId = `client_employee_${clientId}_${empId}`;
      const clientInfo = clientById.get(clientId);
      // Aggregation is owner-scoped — keep only conversations for MY clients
      if (!clientInfo) continue;

      // Resolve the actual employee from the client's companyEmployees so the
      // name + photo come from a single reliable source. Match by _id first, then
      // by the name carried on the message's clientEmployeeData.
      const matchedEmp = (() => {
        const emps = clientInfo?.companyEmployees || [];
        let found = emps.find((e) => String(e._id) === empId);
        if (!found) {
          const nm = (
            row.clientEmployeeData?.clientEmployeeName ||
            row.clientEmployeeData?.name ||
            ""
          )
            .trim()
            .toLowerCase();
          if (nm) {
            found = emps.find(
              (e) => e.name && e.name.trim().toLowerCase() === nm
            );
          }
        }
        return found || null;
      })();

      // Prefer the message's stored name, then the real companyEmployees name,
      // and only fall back to a generic label if neither is available.
      const empName =
        row.clientEmployeeData?.clientEmployeeName ||
        row.clientEmployeeData?.name ||
        matchedEmp?.name ||
        `Employee (${clientInfo?.clientName || "Client"})`;

      const ceDeleted = !!row.deleted;
      const text = (row.note || "").replace(/<[^>]*>/g, "").slice(0, 200);

      const empPhotoUrl = matchedEmp?.photographUrl || null;

      chats.push({
        chatId,
        clientId,
        clientName: clientInfo?.clientName || "",
        legalBusinessName: clientInfo?.legalBusinessName || null,
        dba: clientInfo?.dba || null,
        clientPhotographUrl: clientInfo?.photographUrl || null,
        clientEmployeeId: empId,
        // Send the RESOLVED employee name (from the message or companyEmployees)
        // both as a top-level field and inside clientEmployeeData, so the frontend
        // never has to fall back to a generic "Employee (Client)" label.
        clientEmployeeName: empName,
        clientEmployeeData: {
          ...(row.clientEmployeeData || {}),
          clientEmployeeId: empId,
          clientEmployeeName: empName,
          parentClientId: clientId,
          parentClientName: clientInfo?.clientName || "",
        },
        employeePhotographUrl: empPhotoUrl,
        lastMessage: ceDeleted ? "" : (text || (row.hasAtt ? "📎 Attachment" : "")),
        lastMessageDeleted: ceDeleted,
        lastMessageAt: row.at,
        senderId: row.senderId || null,
        hasAttachments: row.hasAtt || false,
        unreadCount: unreadMap.get(chatId) || 0,
        hasUnreadMessages: !!(unreadMap.get(chatId)),
        pendingApprovalCount: pendingMap.get(chatId) || 0,
        isGroupMessage: false,
        isClientEmployeeMessage: true,
      });
    }

    // Groups — only show if there's a last message
    for (const g of groups) {
      if (!g.lastMessageAt && !g.lastMessage) continue;
      const gid = String(g._id);
      chats.push({
        chatId: `group_${gid}`,
        groupId: gid,
        groupName: g.name,
        groupAvatar: g.avatar,
        groupMembers: g.members,
        lastMessage: g.lastMessage || "",
        lastMessageAt: g.lastMessageAt || null,
        unreadCount: unreadMap.get(gid) || 0,
        hasUnreadMessages: !!(unreadMap.get(gid)),
        pendingApprovalCount: pendingMap.get(gid) || 0,
        isGroupMessage: true,
        isClientEmployeeMessage: false,
      });
    }

    // Sort newest first
    chats.sort((a, b) => {
      const ta = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0;
      const tb = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0;
      return tb - ta;
    });

    res.json({ chats, total: chats.length });
    console.log(`📋 [chat-list] ${chats.length} chats served in ${Date.now() - t0}ms`);

    // ── AFTER responding: refresh stale lastWhatsAppMessage in the background
    // (heavy aggregation, throttled to once per employee per interval)
    const repairKey = String(meId);
    const lastRepair = _chatListRepairAt.get(repairKey) || 0;
    if (Date.now() - lastRepair > CHAT_LIST_REPAIR_INTERVAL_MS) {
      _chatListRepairAt.set(repairKey, Date.now());
      setImmediate(() => {
        repairLastWhatsAppMessages(ownerObjId, allMyClients).catch((e) =>
          console.error("❌ [chat-list-repair] error:", e.message),
        );
      });
    }
  } catch (err) {
    console.error("❌ getChatList error:", err);
    res.status(500).json({ error: "Failed to load chat list" });
  }
};

// POST /:messageId/reactions  — toggle a reaction on a message
exports.toggleMessageReaction = async (req, res) => {
  try {
    const { messageId } = req.params;
    const { emoji } = req.body;

    if (!emoji) return res.status(400).json({ error: "emoji is required" });
    if (!mongoose.isValidObjectId(messageId))
      return res.status(400).json({ error: "Invalid message id" });

    const message = await WhatsAppMessage.findById(messageId);
    if (!message) return res.status(404).json({ error: "Message not found" });

    const employee = await Employee.findById(req.employee._id).select("_id name emojiUsage");
    if (!employee) return res.status(404).json({ error: "Employee not found" });

    const updatedReactions = await message.toggleReaction(emoji, employee);

    // Track emoji usage frequency — only increment when adding (not removing)
    const wasAdded = updatedReactions.some(
      (r) => r.userId.toString() === employee._id.toString() && r.emoji === emoji,
    );
    if (wasAdded) {
      const usageEntry = employee.emojiUsage.find((e) => e.emoji === emoji);
      if (usageEntry) {
        usageEntry.count += 1;
      } else {
        employee.emojiUsage.push({ emoji, count: 1 });
      }
      await employee.save();
    }

    // Emit real-time update to all participants via socket.
    // ⚠️ Send plain strings, not Mongoose ObjectIds: socket.io serializes
    // ObjectIds (which wrap a Buffer) as binary, so the client receives a
    // non-string messageId and the `messageId === localMessage._id` check in
    // ChatMessage.tsx fails — the sender never sees the reaction in realtime.
    const io = req.app.get("io");
    if (io) {
      const plainReactions = (updatedReactions || []).map((r) => {
        const obj = r && typeof r.toObject === "function" ? r.toObject() : r;
        return { ...obj, userId: String(obj.userId) };
      });
      io.emit("message:reaction", {
        messageId: String(message._id),
        reactions: plainReactions,
      });
    }

    res.json({ reactions: updatedReactions });
  } catch (err) {
    console.error("❌ toggleMessageReaction error:", err);
    res.status(500).json({ error: "Failed to toggle reaction" });
  }
};

// GET /frequent-emojis  — return current employee's top 6 most-used emojis
exports.getFrequentEmojis = async (req, res) => {
  try {
    const employee = await Employee.findById(req.employee._id).select("emojiUsage");
    if (!employee) return res.status(404).json({ error: "Employee not found" });

    const defaults = ["👍", "❤️", "😂", "😮", "😢", "👏"];

    if (!employee.emojiUsage || employee.emojiUsage.length === 0) {
      return res.json({ emojis: defaults });
    }

    const sorted = [...employee.emojiUsage]
      .sort((a, b) => b.count - a.count)
      .slice(0, 6)
      .map((e) => e.emoji);

    // Fill remaining slots with defaults if fewer than 6
    const combined = [...new Set([...sorted, ...defaults])].slice(0, 6);
    res.json({ emojis: combined });
  } catch (err) {
    console.error("❌ getFrequentEmojis error:", err);
    res.status(500).json({ error: "Failed to fetch frequent emojis" });
  }
};
