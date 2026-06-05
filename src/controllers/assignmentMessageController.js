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
      const currentIdStr = String(currentEmployee);
      if (visited.has(currentIdStr)) break;
      visited.add(currentIdStr);

      const hierarchyLink = await EmployeeHierarchy.findOne({
        owner: ownerId,
        junior: currentIdStr,
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

/**
 * Get all juniors recursively under a senior employee.
 * This traverses the hierarchy tree downward.
 * @param {string} ownerId - The owner ID (organization)
 * @param {string} seniorId - The senior employee ID
 * @returns {Promise<string[]>} - Array of all junior employee IDs (including nested juniors)
 */
async function getAllJuniorsRecursively(ownerId, seniorId) {
  if (!isObjId(ownerId) || !isObjId(seniorId)) return [];

  try {
    const allJuniors = [];
    const visited = new Set();

    async function collectJuniors(currentSeniorId) {
      const currentIdStr = String(currentSeniorId);
      if (visited.has(currentIdStr)) return;
      visited.add(currentIdStr);

      // Find direct juniors
      const hierarchyLinks = await EmployeeHierarchy.find({
        owner: ownerId,
        senior: currentSeniorId,
      })
        .select("junior")
        .lean();

      for (const link of hierarchyLinks) {
        const juniorId = String(link.junior);
        if (!visited.has(juniorId)) {
          allJuniors.push(juniorId);
          // Recursively get juniors of this junior
          await collectJuniors(juniorId);
        }
      }
    }

    await collectJuniors(seniorId);
    return allJuniors;
  } catch (error) {
    console.error("Error getting all juniors recursively:", error);
    return [];
  }
}

/**
 * Find the next supervisor(s) in the hierarchy who have 'supervisedBy' enabled for this client.
 * If no one in the chain is found, returns an empty array (meaning it should go to managers).
 * @param {string} ownerId 
 * @param {string} employeeId 
 * @param {string} clientId 
 */
async function findNextActiveSupervisor(ownerId, employeeId, clientId) {
  if (!isObjId(ownerId) || !isObjId(employeeId) || !isObjId(clientId)) return [];

  try {
    const client = await ClientInfo.findById(clientId).select("supervisedBy").lean();
    const supervisedBy = (client?.supervisedBy || []).map((id) => String(id));

    // Get full management chain [immediate_senior, next_senior, ..., root]
    const chain = await getManagementChainFromHierarchy(ownerId, employeeId);

    // Find the first senior in the hierarchy who is actually supervising this client
    for (const supervisorId of chain) {
      if (supervisedBy.includes(supervisorId)) {
        return [supervisorId];
      }
    }

    return [];
  } catch (error) {
    console.error("Error finding next active supervisor:", error);
    return [];
  }
}

/** ---------- CLIENT SUPERVISION HELPER FUNCTIONS ---------- **/
async function getClientSupervision(clientId) {
  if (!isObjId(clientId)) return "direct";

  const client = await ClientInfo.findById(clientId).select("supervision supervisedBy").lean();

  // If ANY senior is supervising, treat it as needs_approval for the chain
  if (client?.supervisedBy && client.supervisedBy.length > 0) {
    return "needs_approval";
  }

  return client?.supervision || "direct";
}

async function clientRequiresApproval(clientId) {
  const supervision = await getClientSupervision(clientId);
  return supervision === "needs_approval";
}

/** ---------- utils ---------- **/
async function findEmployeesByEmails(ownerId, emails) {
  if (!emails || emails.length === 0) return [];

  try {
    const normalizedEmails = emails.map((email) => email.trim().toLowerCase());
    const employees = await Employee.find({
      owner: ownerId,
      $or: [
        { email: { $in: normalizedEmails } },
        { companyEmail: { $in: normalizedEmails } },
      ],
      status: { $ne: "offboarded" }, // Exclude offboarded employees
    })
      .select("_id email companyEmail name")
      .lean();

    return employees;
  } catch (error) {
    console.error("Error finding employees by emails:", error);
    return [];
  }
}

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

/** ---------- CC HELPER FUNCTIONS ---------- **/
function parseCCEmails(ccBody) {
  let ccEmails = [];
  if (ccBody) {
    if (Array.isArray(ccBody)) {
      ccEmails = ccBody
        .filter((item) => {
          if (typeof item === "string" && item.includes("@")) return true;
          if (item && item.email && item.email.includes("@")) return true;
          if (item && typeof item === "object" && item.email) return true;
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
  return ccEmails;
}

async function syncCCWithReceivers(receivers, ccEmails, ownerId, senderId, approvalStatus) {
  if (!ccEmails || ccEmails.length === 0 || approvalStatus === "pending") return receivers;

  const ccEmailAddresses = ccEmails.map((cc) => cc.email);
  const matchingEmployees = await findEmployeesByEmails(ownerId, ccEmailAddresses);

  const updatedReceivers = [...receivers];
  if (matchingEmployees.length > 0) {
    matchingEmployees.forEach((employee) => {
      const employeeId = String(employee._id);
      if (
        !updatedReceivers.includes(employeeId) &&
        employeeId !== String(senderId)
      ) {
        updatedReceivers.push(employeeId);
      }
    });
  }
  return updatedReceivers;
}
// 🔥 FIXED: Thread ID generation based on subject only
function generateThreadId(clientId, subject) {
  // Only require clientId if subject is completely missing
  if (!clientId && (!subject || subject.trim() === "")) {
    throw new Error("clientId or subject is required to generate threadId");
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
  if (!req.employee?._id) return { _id: null };

  const me = oid(String(req.employee._id));
  if (!me) return { _id: null };

  const currentUserRole = normalizeRole(req.employee?.role || "");
  const ownerId = req.employee?.owner ? oid(req.employee.owner) : null;

  // 🛡️ CORE PRIVACY RULE: Pending messages are ONLY visible to participants (Sender & Receiver)
  const isParticipant = {
    $or: [{ sender: me }, { receiver: me }, { receiver: { $in: [me] } }],
  };

  // Get clients I'm assigned to OR supervising for shared visibility
  const assignedClients = await ClientInfo.find({
    owner: ownerId,
    $or: [{ assignedTo: me }, { supervisedBy: me }],
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
  // Team Leads, Managers, Owners, and Seniors see messages based on role/hierarchy
  const roleHierarchyFilter = {
    $or: [
      // Managers/Owners/Team Leads see all messages for their organization
      ...(currentUserRole === "manager" || currentUserRole === "owner" || currentUserRole === "team_lead" ? [{ owner: ownerId }] : []),
      // Seniors see messages from their juniors
      ...(juniorIds.length > 0 ? [{ sender: { $in: juniorIds } }, { receiver: { $in: juniorIds } }] : []),
    ]
  };

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
      {
        $and: [
          { approvalStatus: { $ne: "pending" } },
          {
            $or: [
              roleHierarchyFilter,
              organizationSentVisibility,
              ...(assignedClientIds.length > 0 ? [{ client: { $in: assignedClientIds } }] : [])
            ]
          }
        ]
      }
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

  // Handle specific scheduled fetch (e.g., from a scheduled list view)
  if (q.isScheduled === true && q.status === "scheduled") {
    return { $and: [q, inboxVisibility] };
  }

  return { $and: [q, scheduledVisibility] };
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

    // 🔥 NEW: Add anyone assigned to the client so it shows in their external inbox
    // ONLY if the message is fully approved
    if (populatedMessage.client && populatedMessage.approvalStatus === "approved") {
      const clientId = populatedMessage.client._id || populatedMessage.client;
      const clientDoc = await ClientInfo.findById(clientId)
        .select("assignedTo")
        .lean();
      if (clientDoc && clientDoc.assignedTo) {
        clientDoc.assignedTo.forEach((userId) => {
          if (userId) actualRecipients.add(String(userId));
        });
      }

      // Also emit to the client-specific room if anyone is joined
      io.to(`assignment_client_${clientId}`).emit(eventName, populatedMessage);
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

    // 🔥 NEW: Add users assigned to this client
    // ONLY if the message is fully approved
    if (populatedMessage.client && populatedMessage.approvalStatus === "approved") {
      const clientId = populatedMessage.client._id || populatedMessage.client;
      const clientDoc = await ClientInfo.findById(clientId)
        .select("assignedTo")
        .lean();
      if (clientDoc && clientDoc.assignedTo) {
        clientDoc.assignedTo.forEach((userId) => {
          if (userId) actualParticipants.add(String(userId));
        });
      }
      // Also emit to the client room
      io.to(`assignment_client_${clientId}`).emit("assignment_message_updated", {
        message: populatedMessage,
        action: action,
        timestamp: new Date(),
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

/** ---------- HIERARCHY-BASED RECEIVER CALCULATION ---------- **/
async function calculateHierarchyReceiver(owner, sender, clientDoc) {
  // Always route to the IMMEDIATE senior in the EmployeeHierarchy chain.
  // Do not skip levels based on ClientInfo.supervisedBy — every level must
  // approve explicitly (e.g. Abdur Rahman New → Ali → Abdullah Ahmed Qureshi).
  const managementChain = await getManagementChainFromHierarchy(owner, sender);

  let targetSupervisor = managementChain.length > 0 ? managementChain[0] : null;

  if (targetSupervisor) {
    return {
      receivers: [String(targetSupervisor)],
      approvalStatus: "pending",
      targetSupervisor
    };
  } else {
    // No hierarchy senior configured — route to managers/CRM but keep pending
    const { managers, crm } = await findTLsAndManagersByOwner(owner);
    const crmIds = Array.isArray(crm) ? crm : [];
    const fallbackReceivers = Array.from(new Set([...managers, ...crmIds]));
    return {
      receivers: fallbackReceivers,
      approvalStatus: "pending",
      targetSupervisor: null
    };
  }
}

/** ---------- helpers: find TLs and Managers for an owner (no supervisor chain) ---------- **/
async function findTLsAndManagersByOwner(ownerId) {
  if (!isObjId(ownerId)) return { tls: [], managers: [], employees: [], crm: [] };

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

  // Find CRM employees by role or email pattern
  const crm = await Employee.find({
    owner: ownerId,
    $or: [
      { role: /crm/i },
      { role: /customer relationship/i },
      { companyEmail: /crm/i },
      { name: /CRM/i }
    ],
  })
    .select("_id")
    .lean();

  return {
    tls: tls.map((x) => String(x._id)),
    managers: managers.map((x) => String(x._id)),
    employees: employees.map((x) => String(x._id)),
    crm: crm.map((x) => String(x._id)),
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
            { path: "sender", select: "_id name companyEmail role designation" },
            { path: "receiver", select: "_id name companyEmail role designation" },
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
        { path: "sender", select: "_id name companyEmail role designation" },
        { path: "receiver", select: "_id name companyEmail role designation" },
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

    let targetSupervisor = null; // 🔥 HIERARCHY-BASED: Capture for notification at the end

    const owner = ownerBody || req.employee?.owner;
    const sender = senderBody || req.employee?._id;

    if (!isObjId(owner) || !isObjId(sender)) {
      return res.status(400).json({
        error: "owner and sender are required (ObjectId strings)",
      });
    }

    const senderDoc = await Employee.findById(sender)
      .select("_id role supervisor supervisionMode owner")
      .lean();
    const senderRole = normalizeRole(senderDoc?.role || "");

    let threadId = providedThreadId;
    let originalMessage = null;
    let threadMessages = [];
    let isNewThread = true;
    let threadHasTeamLead = false;
    let threadOriginalSenderRole = null;
    let threadHasEmployeeWithSupervision = false;

    if (providedThreadId || replyTo) {
      try {
        if (providedThreadId) {
          threadMessages = await AssignmentMessage.find({
            threadId: providedThreadId,
          })
            .sort({ createdAt: -1 })
            .limit(50)
            .lean();
          isNewThread = threadMessages.length === 0;

          // Check if thread already has team lead as receiver
          // Note: tls is fetched later; we do a quick DB check here instead
          threadHasTeamLead = threadMessages.some(msg => {
            if (Array.isArray(msg.receiver)) {
              return msg.receiver.some(receiverId => {
                // We'll re-evaluate this once tls is available below
                return false;
              });
            }
            return false;
          });

          // Check original sender role and if thread has employee messages
          if (threadMessages.length > 0) {
            const firstMessage = threadMessages[threadMessages.length - 1]; // Oldest message
            threadOriginalSenderRole = normalizeRole(firstMessage.role || '');

            // Check if any message in thread is from an employee
            threadHasEmployeeWithSupervision = threadMessages.some(msg => {
              const msgRole = normalizeRole(msg.role || '');
              return msgRole === 'employee';
            });
          }
        }

        if (replyTo) {
          originalMessage = await AssignmentMessage.findById(replyTo).lean();
          if (originalMessage && !providedThreadId) {
            threadId = originalMessage.threadId;
            threadMessages = await AssignmentMessage.find({
              threadId: originalMessage.threadId,
            })
              .sort({ createdAt: -1 })
              .limit(50)
              .lean();
            isNewThread = false;

            // Check if thread already has team lead as receiver
            // Note: tls is fetched later; this will be re-checked below once tls is available
            threadHasTeamLead = threadMessages.some(msg => {
              if (Array.isArray(msg.receiver)) {
                return msg.receiver.some(receiverId => {
                  return false; // re-evaluated after tls is fetched below
                });
              }
              return false;
            });

            // Get original sender role
            if (threadMessages.length > 0) {
              const firstMessage = threadMessages[threadMessages.length - 1];
              threadOriginalSenderRole = normalizeRole(firstMessage.role || '');

              // Check if any message in thread is from an employee
              threadHasEmployeeWithSupervision = threadMessages.some(msg => {
                const msgRole = normalizeRole(msg.role || '');
                return msgRole === 'employee';
              });
            }
          }
        }
      } catch (err) {
        console.error("Error fetching thread messages:", err);
      }
    }

    let inheritedIsFromClient = false;
    let inheritedIsFromCompanyEmployee = false;
    let inheritedClientEmployeeName = null;
    let inheritedClientEmployeeEmail = null;
    let inheritedClientName = null;

    if (senderRole === "manager") {
      if (isFromClient || isFromCompanyEmployee) {
        inheritedIsFromClient = isFromClient || false;
        inheritedIsFromCompanyEmployee = isFromCompanyEmployee || false;
        inheritedClientEmployeeName = clientEmployeeName || null;
        inheritedClientEmployeeEmail = clientEmployeeEmail || null;
        inheritedClientName = clientName || null;
      }
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

    let receivers = [];
    if (receiverBody) receivers = receivers.concat(normalizeIds(receiverBody));
    if (receiversBody)
      receivers = receivers.concat(normalizeIds(receiversBody));

    receivers = receivers.filter((id) => id !== String(sender));

    let approvalStatus = "approved";
    let clientSupervisionMode = "direct";
    let clientDoc = null;
    let isSenderAssigned = false;
    let assignedToIds = [];

    if (client && isObjId(client)) {
      clientDoc = await ClientInfo.findById(client)
        .populate("assignedTo", "_id role")
        .select("supervision assignedTo supervisedBy")
        .lean();

      if (clientDoc) {
        clientSupervisionMode = clientDoc.supervision || "direct";
        // Support both array and single-object assignedTo
        assignedToIds = (Array.isArray(clientDoc.assignedTo) ? clientDoc.assignedTo : [clientDoc.assignedTo])
          .filter(Boolean)
          .map(emp => String(emp._id || emp));

        isSenderAssigned = assignedToIds.includes(String(sender));

        // Automatically add all assigned team members as receivers if they aren't the sender
        assignedToIds.forEach(id => {
          if (!receivers.includes(id) && id !== String(sender)) {
            receivers.push(id);
          }
        });
      }

      if (inheritedIsFromClient || inheritedIsFromCompanyEmployee) {
        approvalStatus = "approved";
      } else if (clientSupervisionMode === "needs_approval" &&
                 (isSenderAssigned || senderRole === "employee")) {
        approvalStatus = "pending";
      } else {
        approvalStatus = "approved";
      }
    } else {
      approvalStatus = null;
    }

    let clientEmployees = [];
    if (clientEmployeesBody) {
      clientEmployees = normalizeIds(clientEmployeesBody);
    } else if (companyEmployeesBody) {
      clientEmployees = normalizeIds(companyEmployeesBody);
    }

    if (senderRole === "manager") {
      clientEmployees.forEach((clientEmployeeId) => {
        if (!receivers.includes(clientEmployeeId)) {
          receivers.push(clientEmployeeId);
        }
      });
    } else {
    }

    // Simplified assignedTo handling - already handled above in the consolidated clientDoc fetch
    let assignedTeamMemberId = assignedToIds[0] || null;

    const { tls, managers } = await findTLsAndManagersByOwner(owner);

    // Re-evaluate threadHasTeamLead now that tls is available
    if (threadMessages.length > 0) {
      threadHasTeamLead = threadMessages.some(msg => {
        if (Array.isArray(msg.receiver)) {
          return msg.receiver.some(receiverId => tls.includes(String(receiverId)));
        }
        return false;
      });
    }

    const originalIntendedReceivers = [...receivers]; // 💾 Capture final intended list before supervision replaces it

    // 🔥 HIERARCHY-BASED: Find the first active supervisor in the hierarchy for the sender
    if (client && isObjId(client) && approvalStatus === "pending") {
      if (senderRole === "employee" || senderRole === "team_lead" || senderRole === "manager") {
        const hierarchyResult = await calculateHierarchyReceiver(owner, sender, clientDoc);
        receivers = hierarchyResult.receivers;
        approvalStatus = hierarchyResult.approvalStatus;
        targetSupervisor = hierarchyResult.targetSupervisor;

        // Update thread history
        if (targetSupervisor && threadMessages.length > 0 && !threadHasTeamLead) {
          try {
            const threadMessageIds = threadMessages.map(msg => msg._id);
            await AssignmentMessage.updateMany(
              { _id: { $in: threadMessageIds }, receiver: { $ne: targetSupervisor } },
              { $addToSet: { receiver: targetSupervisor } }
            );
          } catch (e) {
            console.error("Error updating thread history", e);
          }
        }
      }
    }

    if (senderRole === "manager") {
      if (approvalStatus !== "pending") approvalStatus = null;

      if (isNewThread) {
        // For new threads from managers, NEVER include team leads automatically
        receivers = receivers.filter((receiverId) => {
          const isExplicitReceiver =
            normalizeIds(receiverBody).includes(receiverId) ||
            normalizeIds(receiversBody).includes(receiverId);
          const isAssignedTeamMember = assignedToIds.includes(receiverId);
          const isClientEmployee = clientEmployees.includes(receiverId);
          const isTeamLead = tls.includes(receiverId);

          // For new threads, team leads are ONLY included if explicitly specified
          const includeTeamLead = isTeamLead && isExplicitReceiver;

          return (isExplicitReceiver || isAssignedTeamMember || isClientEmployee || includeTeamLead) && !(isTeamLead && !isExplicitReceiver);
        });
      } else {
        // For existing threads, only include team leads if they're already in the thread
        receivers = receivers.filter((receiverId) => {
          const isExplicitReceiver =
            normalizeIds(receiverBody).includes(receiverId) ||
            normalizeIds(receiversBody).includes(receiverId);
          const isAssignedTeamMember = assignedToIds.includes(receiverId);
          const isClientEmployee = clientEmployees.includes(receiverId);
          const isTeamLead = tls.includes(receiverId);

          // For existing threads, team leads are included if:
          // 1. They're explicitly specified OR
          // 2. They're already in the thread
          const includeTeamLead = isTeamLead && (isExplicitReceiver || threadHasTeamLead);

          return isExplicitReceiver || isAssignedTeamMember || isClientEmployee || includeTeamLead;
        });
      }

    } else if (senderRole === "team_lead") {
      if (approvalStatus !== "pending") approvalStatus = null;
    }

    // Redundant block removed (already handled earlier in createMessage)


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

        if (senderRole === "employee") {
          if (
            client &&
            isObjId(client) &&
            clientSupervisionMode === "needs_approval"
          ) {
            // 🔥 HIERARCHY-BASED
            const supervisorsToNotify = hasHierarchy ? hierarchySupervisors : tls;

            if (supervisorsToNotify.length > 0) {
              receivers = [...supervisorsToNotify];
              approvalStatus = "pending";
            } else {
              return res.status(400).json({
                error:
                  "No supervisors or team leads available for approval. Please specify at least one receiver for your message.",
              });
            }
          } else if (
            client &&
            isObjId(client) &&
            clientSupervisionMode === "direct"
          ) {
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

    receivers = Array.from(new Set(receivers.map((id) => String(id)))).filter(
      (id) => id !== String(sender)
    );

    if (receivers.length === 0) {
      return res.status(400).json({
        error:
          "No valid receivers found. Please specify at least one recipient.",
      });
    }

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

    let ccEmails = parseCCEmails(ccBody);

    // 🔥 NEW: Check CC emails against employee database and add matching employees as receivers
    receivers = await syncCCWithReceivers(receivers, ccEmails, owner, sender, approvalStatus);

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
      intendedRecipients: (approvalStatus === "pending") ? originalIntendedReceivers : [],
      isFromClient: inheritedIsFromClient,
      isFromCompanyEmployee: inheritedIsFromCompanyEmployee,
      clientEmployeeName: inheritedClientEmployeeName,
      clientEmployeeEmail: inheritedClientEmployeeEmail,
      clientName: inheritedClientName,
    };

    if (client && isObjId(client)) {
      msgData.client = client;
    }

    if (ccEmails.length > 0) {
      msgData.cc = ccEmails;
    }

    // Store the full ordered approval chain for display in Message Info
    if (approvalStatus === "pending") {
      const fullChain = await getManagementChainFromHierarchy(owner, String(sender));
      msgData.plannedApprovalChain = fullChain;
    }

    const msg = await AssignmentMessage.create(msgData);

    const populated = await msg.populate([
      { path: "owner", select: "_id name companyEmail" },
      { path: "sender", select: "_id name companyEmail role designation" },
      { path: "receiver", select: "_id name companyEmail role designation" },
      { path: "client", select: "_id clientName assignedTo" },
      { path: "scheduledBy", select: "_id name companyEmail" },
    ]);

    const io = getIO(req);
    if (io && !isScheduled) {
      await emitToAssignmentClients(io, msg, "new_assignment_message");

      // 🔥 HIERARCHY-BASED: Notify THE specific supervisor(s) about the thread update
      if (senderRole === "employee" && clientSupervisionMode === "needs_approval") {
        const supervisorsToNotify = targetSupervisor ? [String(targetSupervisor)] : [];

        supervisorsToNotify.forEach(supervisorId => {
          io.to(`employee_${supervisorId}`).emit("thread_updated_for_supervision", {
            threadId: threadId,
            clientId: client,
            updatedAt: new Date(),
            message: "Thread requires your supervision",
          });
        });
      }
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
      { path: "sender", select: "_id name companyEmail role designation" },
      { path: "receiver", select: "_id name companyEmail role designation" },
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
      { path: "sender", select: "_id name companyEmail role designation" },
      { path: "receiver", select: "_id name companyEmail role designation" },
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
      AssignmentMessage.find(qFinal)
        .sort({ scheduledFor: 1 })
        .skip((pageNum - 1) * lim)
        .limit(lim)
        .populate([
          { path: "owner", select: "_id name companyEmail" },
          { path: "sender", select: "_id name companyEmail role designation" },
          { path: "receiver", select: "_id name companyEmail role designation" },
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
      { path: "sender", select: "_id name companyEmail role designation" },
      { path: "receiver", select: "_id name companyEmail role designation" },
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

        // 🔥 HIERARCHY-BASED: Determine approval status and hierarchy routing
        let targetSupervisor = null;
        if (message.client) {
          const clientDoc = await ClientInfo.findById(message.client._id || message.client).lean();
          const senderId = String(message.sender?._id || message.sender);
          const assignedToIds = (clientDoc?.assignedTo || []).map((id) => String(id));
          const isSenderAssigned = assignedToIds.includes(senderId);
          const clientSupervisionMode = clientDoc?.supervision || "direct";

          if (clientSupervisionMode === "needs_approval" && isSenderAssigned) {
            const hierarchyResult = await calculateHierarchyReceiver(
              message.owner,
              senderId,
              clientDoc
            );

            // Store original intended receivers if not already stored
            if (!message.intendedRecipients || message.intendedRecipients.length === 0) {
              message.intendedRecipients = message.receiver.map(r => r._id || r);
            }

            message.receiver = hierarchyResult.receivers;
            message.approvalStatus = hierarchyResult.approvalStatus;
            targetSupervisor = hierarchyResult.targetSupervisor;
          } else {
            message.approvalStatus = "approved";
          }
        } else {
          message.approvalStatus = "approved";
        }

        await message.save();

        // 🔥 FIXED: Use targeted emission instead of broadcast
        if (io) {
          await emitToAssignmentClients(io, message, "new_assignment_message");

          // 🔥 HIERARCHY-BASED: Notify THE specific supervisor(s) about the thread update
          if (message.approvalStatus === "pending" && targetSupervisor) {
            io.to(`employee_${targetSupervisor}`).emit(
              "thread_updated_for_supervision",
              {
                threadId: message.threadId,
                clientId: message.client?._id || message.client,
                updatedAt: new Date(),
                message: "Scheduled thread requires your supervision",
              }
            );
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
exports.approveMessage = async function approveMessage(req, res) {
  try {
    const { id } = req.params;
    const msg = await AssignmentMessage.findById(id).populate([
      { path: "sender", select: "_id name companyEmail role designation" },
      { path: "receiver", select: "_id name companyEmail role designation" },
      { path: "client", select: "_id clientName" },
    ]);
    if (!msg) return res.status(404).json({ error: "Message not found" });

    const userRole = normalizeRole(req.employee?.role || "");
    const currentUserId = String(req.employee?._id);
    const ownerId = msg.owner;

    // Check if current user is one of the receivers or a manager/owner
    const isReceiver = msg.receiver.some((r) => String(r._id || r) === currentUserId);
    const isManagerOrOwner = userRole === "manager" || userRole === "owner";

    if (!isManagerOrOwner && !isReceiver) {
      return res
        .status(403)
        .json({ error: "Only designated supervisors or managers can approve messages" });
    }

    // Prevent double approval
    if (msg.approvalStatus === "approved") {
      return res.status(400).json({ error: "Message already approved" });
    }

    // 🔥 HIERARCHY-BASED 1-LEVEL ESCALATION
    // Always escalate to the immediate next senior in the EmployeeHierarchy
    // chain (one level up). Do NOT filter by ClientInfo.supervisedBy — that
    // caused mid-level seniors (e.g. Ali) to be skipped when only the top
    // manager was in supervisedBy. The full chain must approve explicitly.

    // Fetch the approver's own hierarchy link to record the level
    const approverLink = await EmployeeHierarchy.findOne({
      owner: ownerId,
      junior: currentUserId,
    })
      .select("senior hierarchyLevel")
      .lean();
    const currentHierarchyLevel = approverLink?.hierarchyLevel ?? null;

    // Diagnostic logging
    console.log("════════════════════════════════════════════════");
    console.log("📨 [assignment approveMessage] APPROVAL TRIGGERED");
    console.log("   approver (currentUserId):", currentUserId);
    console.log("   approver name:", req.employee?.name);
    console.log("   ownerId:", String(ownerId));
    console.log("   message._id:", String(msg._id));
    console.log("   message current status:", msg.approvalStatus);

    const allLinksAsJunior = await EmployeeHierarchy.find({
      owner: ownerId,
      junior: currentUserId,
    }).lean();
    console.log("   [DB] hierarchy records where approver is JUNIOR:", JSON.stringify(allLinksAsJunior, null, 2));

    // Find the immediate seniors (1 level up) of the current approver
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

    // The approver has reviewed this message — mark it as read so it doesn't
    // appear as an unread message in their email badge count after approving
    if (!msg.readBy) msg.readBy = [];
    const alreadyRead = msg.readBy.some(
      (r) => String(r.employee?._id || r.employee) === String(req.employee._id)
    );
    if (!alreadyRead) {
      msg.readBy.push({ employee: req.employee._id, readAt: new Date() });
    }

    const targetSupervisor = immediateSeniors.length > 0 ? immediateSeniors[0] : null;
    const hasNextLevel = !!targetSupervisor;
    const nextSupervisors = targetSupervisor ? [targetSupervisor] : [];

    let approvalFinalized = false;
    let responseStatusMessage = "Message approved successfully";

    if (targetSupervisor) {
      // Escalate to the next immediate senior in the hierarchy.
      // Keep the current approver in the receiver list so the message
      // remains visible in their email inbox after they approve.
      msg.approvalStatus = "pending";
      const previousApprovers = (msg.approvalChain || []).map(
        (entry) => String(entry.approver?._id || entry.approver)
      );
      msg.receiver = Array.from(
        new Set([targetSupervisor, ...previousApprovers])
      );

      // Reset read status for the next supervisor so it appears as new (bold) for them
      if (msg.readBy && msg.readBy.length > 0) {
        msg.readBy = msg.readBy.filter(
          (r) => String(r.employee?._id || r.employee) !== String(targetSupervisor)
        );
      }
      responseStatusMessage = "Message approved and escalated to next-level supervisor";
      console.log("⬆️ [assignment approveMessage] Escalating to next senior:", targetSupervisor);
    } else {
      // At top of hierarchy or no active supervisors found up-chain -> Finalize
      // Get managers and CRM for the owner
      const { managers, crm } = await findTLsAndManagersByOwner(ownerId);
      const crmIds = Array.isArray(crm) ? crm : [];

      // RESTORE INTENDED RECIPIENTS
      const intendedRecipients = Array.isArray(msg.intendedRecipients)
        ? msg.intendedRecipients.map((r) => String(r._id || r))
        : [];

      const currentReceivers = Array.isArray(msg.receiver)
        ? msg.receiver.map((r) => String(r._id || r))
        : [];

      // Include all approvers from the chain so the message stays in their inbox
      const chainApprovers = (msg.approvalChain || []).map(
        (entry) => String(entry.approver?._id || entry.approver)
      );

      const finalReceivers = Array.from(
        new Set([...currentReceivers, ...managers, ...crmIds, ...intendedRecipients, ...chainApprovers])
      ).filter((rid) => rid !== String(msg.sender?._id || msg.sender));

      msg.receiver = finalReceivers;

      // Filter CCs on approval to ensure Managers/CRM are not in the CC header
      if (msg.cc && msg.cc.length > 0) {
        const ccEmailAddresses = msg.cc.map((c) => c.email);
        const matchingEmployees = await findEmployeesByEmails(msg.owner, ccEmailAddresses);

        matchingEmployees.forEach((employee) => {
          const role = (employee.role || "").toLowerCase();
          if (role.includes("manager") || role.includes("crm")) {
            const index = msg.cc.findIndex((c) => {
              const ccEmail = (c.email || "").toLowerCase();
              return (
                ccEmail === (employee.email || "").toLowerCase() ||
                ccEmail === (employee.companyEmail || "").toLowerCase()
              );
            });
            if (index > -1) {
              msg.cc.splice(index, 1);
            }
          }
        });
      }

      msg.approvalStatus = "approved";
      msg.approvedAt = new Date();
      msg.approvedBy = req.employee._id;

      msg.readBy = [{
        employee: req.employee._id,
        readAt: new Date()
      }];

      approvalFinalized = true;
    }

    await msg.save();

    let approvedClientEmployeeMessages = [];
    if (approvalFinalized && msg.threadId) {
      try {
        // Find all messages in the same thread from client employees that are pending
        const clientEmployeeMessages = await AssignmentMessage.find({
          threadId: msg.threadId,
          approvalStatus: "pending",
          $or: [
            { isFromClient: true },
            { isFromCompanyEmployee: true },
            { senderType: "client" }
          ],
          _id: { $ne: msg._id } // Exclude the current message being approved
        });

        if (clientEmployeeMessages.length > 0) {
          // Update all client employee messages to approved
          for (const clientMsg of clientEmployeeMessages) {
            clientMsg.approvalStatus = "approved";
            clientMsg.approvedAt = new Date();
            clientMsg.approvedBy = req.employee._id;
            await clientMsg.save();
            approvedClientEmployeeMessages.push(clientMsg._id);
          }
        }
      } catch (err) {
        console.error("❌ Error auto-approving client employee messages:", err);
        // Don't fail the main approval if this fails
      }
    }

    // Populate updated message
    const populated = await msg.populate([
      { path: "owner", select: "_id name companyEmail" },
      { path: "sender", select: "_id name companyEmail role designation" },
      { path: "receiver", select: "_id name companyEmail role designation" },
      { path: "client", select: "_id clientName" },
      { path: "approvedBy", select: "_id name companyEmail role designation" },
      { path: "disapprovedBy", select: "_id name companyEmail role designation" },
      { path: "plannedApprovalChain", select: "_id name role designation" },
      {
        path: "approvalChain",
        populate: { path: "approver", select: "_id name role designation", model: "Employee" },
      },
    ]);

    // 🔥 ENHANCED REAL-TIME EMISSION - FIXED FOR HIERARCHY
    const io = getIO(req);
    if (io) {
      const allInvolvedUsers = new Set();

      // Add sender
      if (populated.sender && populated.sender._id) {
        allInvolvedUsers.add(String(populated.sender._id));
      }

      // 🔥 NEW: Add users assigned to this client for real-time visibility in external inbox
      // ONLY if the message is fully approved
      if (populated.client && populated.approvalStatus === "approved") {
        const clientId = populated.client._id || populated.client;
        const clientDoc = await ClientInfo.findById(clientId).select("assignedTo").lean();
        if (clientDoc && clientDoc.assignedTo) {
          clientDoc.assignedTo.forEach((userId) => {
            if (userId) allInvolvedUsers.add(String(userId));
          });
        }
        // Also emit to the client-specific room if anyone is joined
        io.to(`assignment_client_${clientId}`).emit("new_assignment_message", populated);
      }

      // Add all current receivers (could be next level supervisors)
      if (populated.receiver && Array.isArray(populated.receiver)) {
        populated.receiver.forEach((receiver) => {
          const receiverId = typeof receiver === "object" ? receiver._id : receiver;
          if (receiverId) allInvolvedUsers.add(String(receiverId));
        });
      }

      // Add the person who just approved
      allInvolvedUsers.add(String(req.employee._id));

      const approverId = String(req.employee._id);

      // Emit status-update events to ALL involved users (including the approver)
      allInvolvedUsers.forEach((userId) => {
        io.to(`employee_${userId}`).emit("assignment_message_updated", {
          message: populated,
          type: "message_updated",
          action: hasNextLevel ? "approved_to_next_level" : "approved",
          approvedBy: req.employee._id,
          timestamp: new Date(),
          hasNextLevel: hasNextLevel,
          nextSupervisors: nextSupervisors,
        });

        io.to(`employee_${userId}`).emit("assignment_message_approved", {
          messageId: populated._id,
          approvalStatus: populated.approvalStatus,
          message: populated,
          isNewMessage: true,
          approvedBy: {
            _id: req.employee._id,
            name: req.employee.name,
            companyEmail: req.employee.companyEmail,
          },
          timestamp: new Date(),
          hasNextLevel: hasNextLevel,
        });
      });

      // new_assignment_message → only receivers, NOT the approver
      // The approver already knows about this message; sending it to them creates a spurious notification
      allInvolvedUsers.forEach((userId) => {
        if (userId === approverId) return;
        io.to(`employee_${userId}`).emit("new_assignment_message", populated);
      });

      // Notify assignment managers if completely finalized
      if (!hasNextLevel) {
        io.to("assignment_managers").emit("assignment_message_approved", {
          messageId: populated._id,
          approvalStatus: "approved",
          message: populated,
          action: "approved",
          isNewMessage: true,
          timestamp: new Date(),
        });
      }
    }

    return res.json({
      success: true,
      message: responseStatusMessage,
      data: populated,
      hasNextLevel: hasNextLevel,
      nextSupervisors: hasNextLevel ? nextSupervisors : [],
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
    const currentUserId = String(req.employee?._id);

    const isReceiver = msg.receiver.some((r) => String(r._id || r) === currentUserId);
    const isManagerOrOwner = userRole === "manager" || userRole === "owner";

    if (!isManagerOrOwner && !isReceiver) {
      return res
        .status(403)
        .json({ error: "Only designated supervisors or managers can disapprove messages" });
    }


    // ✅ ONLY update the existing message - NO new message creation
    msg.approvalStatus = "disapproved";

    // 🔥 NEW: Reset read status so participants see the disapproval as a new unread (bold) message
    msg.readBy = [{
      employee: req.employee._id,
      readAt: new Date()
    }];

    // Store disapproval note if provided
    if (disapprovalNote && disapprovalNote.trim() !== "") {
      msg.disapprovalNote = disapprovalNote.trim();
    } else {
      // Optional: Set a default note or leave it undefined
      msg.disapprovalNote = "Message requires revisions before resubmission.";
    }

    msg.updatedAt = new Date();
    await msg.save();

    // Populate the updated message for response — include approvalChain so
    // previous approvers are identifiable both here and in the frontend
    const populated = await AssignmentMessage.findById(msg._id).populate([
      { path: "owner", select: "_id name companyEmail" },
      { path: "sender", select: "_id name companyEmail role designation" },
      { path: "receiver", select: "_id name companyEmail role designation" },
      { path: "client", select: "_id clientName" },
      {
        path: "approvalChain.approver",
        select: "_id name companyEmail role designation",
        model: "Employee",
      },
    ]);

    // 🔥 FIXED: Emit specific disapproval event
    const io = getIO(req);
    if (io) {
      // Collect ALL users who must see the disapproval in real time
      const allParticipants = new Set();

      // Original sender
      const senderId = String(populated.sender._id);
      allParticipants.add(senderId);

      // Current receivers (the person who just disapproved is likely here too)
      if (populated.receiver && Array.isArray(populated.receiver)) {
        populated.receiver.forEach((receiver) => {
          allParticipants.add(String(receiver._id));
        });
      }

      // Every senior in the approval chain who previously approved —
      // they must see the disapproval from a higher-level senior.
      // msg.approvalChain uses raw ObjectIds (not populated), so call String() directly.
      if (Array.isArray(msg.approvalChain)) {
        msg.approvalChain.forEach((step) => {
          const raw = step.approver;
          const aid = raw?._id ? String(raw._id) : raw ? String(raw) : null;
          if (aid) allParticipants.add(aid);
        });
      }

      // The senior who disapproved
      allParticipants.add(String(req.employee._id));

      const disapprovalPayload = {
        messageId: String(populated._id),
        approvalStatus: "disapproved",
        message: populated,
        disapprovedBy: {
          _id: req.employee._id,
          name: req.employee.name,
          companyEmail: req.employee.companyEmail,
        },
        timestamp: new Date(),
        disapprovalNote: msg.disapprovalNote,
      };

      // Emit to all participants
      allParticipants.forEach((participantId) => {
        io.to(`employee_${participantId}`).emit(
          "assignment_message_disapproved",
          disapprovalPayload
        );

        // Also update the email list view
        io.to(`employee_${participantId}`).emit("new_assignment_message", populated);
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
      { path: "sender", select: "_id name companyEmail role designation" },
      { path: "receiver", select: "_id name companyEmail role designation" },
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
      client: client,
      status: "sent"
    };
    if (isObjId(owner)) q.owner = owner;

    // Apply visibility rules (including client-assigned visibility)
    const qFinal = await applyVisibility(q, req);

    const [items, total] = await Promise.all([
      AssignmentMessage.find(qFinal)
        .sort({ createdAt: 1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate([
          { path: "owner", select: "_id name companyEmail" },
          { path: "sender", select: "_id name companyEmail role designation" },
          { path: "receiver", select: "_id name companyEmail role designation" },
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
      cc: ccBody,
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

    let ccEmails = parseCCEmails(ccBody);
    receivers = await syncCCWithReceivers(receivers, ccEmails, owner, sender, null);

    // Note: Drafts can be saved without receivers. 
    // The requirement for receivers should only be enforced when sending.

    const draftData = {
      owner,
      sender,
      receiver: receivers,
      subject: subject || "Draft",
      note: note || "",
      status: "draft",
      isScheduled: false,
      cc: ccEmails,
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
      { path: "sender", select: "_id name companyEmail role designation" },
      { path: "receiver", select: "_id name companyEmail role designation" },
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
      cc: ccBody,
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

    if (ccBody) {
      const ccEmails = parseCCEmails(ccBody);
      msg.cc = ccEmails;

      // Sync updated CC with receivers
      const updatedReceivers = await syncCCWithReceivers(
        msg.receiver.map(String),
        ccEmails,
        msg.owner,
        msg.sender,
        msg.approvalStatus
      );
      msg.receiver = updatedReceivers;
    }

    await msg.save();

    const populated = await msg.populate([
      { path: "owner", select: "_id name companyEmail" },
      { path: "sender", select: "_id name companyEmail role designation" },
      { path: "receiver", select: "_id name companyEmail role designation" },
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
      cc: ccBody,
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

    // Check if draft is already sent or in an invalid state
    if (msg.status === "sent") {
      return res.status(400).json({ error: "Message has already been sent" });
    }
    if (msg.status !== "draft" && msg.status !== "scheduled") {
      return res.status(400).json({ error: "Message is not a draft or scheduled" });
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

    // Process CC and sync with receivers if CC is provided during send
    if (ccBody) {
      const ccEmails = parseCCEmails(ccBody);
      msg.cc = ccEmails;

      const updatedReceivers = await syncCCWithReceivers(
        msg.receiver.map(String),
        ccEmails,
        msg.owner,
        msg.sender,
        msg.approvalStatus
      );
      msg.receiver = updatedReceivers;
    } else if (msg.cc && msg.cc.length > 0) {
      // Even if no new CC is provided, ensure existing CC is synced with receivers
      const updatedReceivers = await syncCCWithReceivers(
        msg.receiver.map(String),
        msg.cc,
        msg.owner,
        msg.sender,
        msg.approvalStatus
      );
      msg.receiver = updatedReceivers;
    }

    // Handle scheduling
    const isScheduled = isScheduledBody === true || isScheduledBody === "true";
    let targetSupervisor = null;

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

      // 🔥 HIERARCHY-BASED: Determine approval status and hierarchy routing
      targetSupervisor = null;
      if (msg.client) {
        const clientDoc = await ClientInfo.findById(msg.client).lean();
        const senderId = String(msg.sender);
        const assignedToIds = (clientDoc?.assignedTo || []).map((id) =>
          String(id)
        );
        const isSenderAssigned = assignedToIds.includes(senderId);
        const clientSupervisionMode = clientDoc?.supervision || "direct";

        if (clientSupervisionMode === "needs_approval" && isSenderAssigned) {
          const hierarchyResult = await calculateHierarchyReceiver(
            msg.owner,
            msg.sender,
            clientDoc
          );
          msg.receiver = hierarchyResult.receivers;
          msg.approvalStatus = hierarchyResult.approvalStatus;
          targetSupervisor = hierarchyResult.targetSupervisor;

          // If it's pending, store the original intended receivers
          if (msg.approvalStatus === "pending") {
            msg.intendedRecipients = receivers;
          }
        } else {
          msg.approvalStatus = "approved";
        }
      } else {
        msg.approvalStatus = "approved";
      }
    }

    await msg.save();

    const populated = await msg.populate([
      { path: "owner", select: "_id name companyEmail" },
      { path: "sender", select: "_id name companyEmail role designation" },
      { path: "receiver", select: "_id name companyEmail role designation" },
      { path: "client", select: "_id clientName" },
      { path: "attachments.uploadedBy", select: "_id name companyEmail" },
      { path: "scheduledBy", select: "_id name companyEmail" },
    ]);

    if (!isScheduled) {
      const io = getIO(req);
      if (io) {
        await emitToAssignmentClients(io, msg, "new_assignment_message");

        // 🔥 HIERARCHY-BASED: Notify THE specific supervisor(s) about the thread update
        if (msg.approvalStatus === "pending") {
          const supervisorsToNotify = targetSupervisor ? [String(targetSupervisor)] : [];

          supervisorsToNotify.forEach((supervisorId) => {
            io.to(`employee_${supervisorId}`).emit(
              "thread_updated_for_supervision",
              {
                threadId: msg.threadId,
                clientId: msg.client?._id || msg.client,
                updatedAt: new Date(),
                message: "Thread requires your supervision",
              }
            );
          });
        }
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

    // Allow any senior who previously approved the message to also edit & resubmit
    const isInApprovalChain =
      Array.isArray(msg.approvalChain) &&
      msg.approvalChain.some((step) => {
        const raw = step.approver;
        const aid = raw?._id ? String(raw._id) : raw ? String(raw) : null;
        return aid === String(currentUserId);
      });

    if (!isSender && !isTeamLead && !isManager && !isInApprovalChain) {
      return res.status(403).json({
        error: "You don't have permission to edit this message",
        messageOwner: messageSenderId,
        currentUser: currentUserId,
        userRole: req.employee?.role || "unknown",
        allowedRoles: ["sender", "team_lead", "manager", "previous_approver"],
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

    // Capture previous approvers before resetting so we can notify them
    const previousApproverIds = (msg.approvalChain || []).map((step) => {
      const aid = typeof step.approver === "object" ? step.approver?._id : step.approver;
      return aid ? String(aid) : null;
    }).filter(Boolean);

    // Prepare update data – reset approvalChain so the chain restarts from scratch
    const updateData = {
      approvalStatus: "pending",
      approvalChain: [],
      updatedAt: new Date(),
      resubmittedAt: new Date(),
      lastEditedBy: currentUserId,
      lastEditedAt: new Date(),
    };

    // 🔥 HIERARCHY-BASED: Re-calculate receiver upon resubmission.
    // When the original sender resubmits, route from their position (→ Senior B).
    // When a previous approver (senior) resubmits, route from THEIR position
    // so the message goes to their own higher-order senior, not back to themselves.
    if (msg.client) {
      const clientDoc = await ClientInfo.findById(msg.client).lean();
      if (clientDoc) {
        const hierarchyFrom = isSender ? msg.sender : currentUserId;
        const hierarchyResult = await calculateHierarchyReceiver(msg.owner, hierarchyFrom, clientDoc);
        updateData.receiver = hierarchyResult.receivers;
        updateData.approvalStatus = hierarchyResult.approvalStatus;
      }
    }

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
    updatedMsg.readBy = [{
      employee: currentUserId,
      readAt: new Date()
    }];
    await updatedMsg.save();
    // Populate the updated message
    const populated = await AssignmentMessage.findById(updatedMsg._id)
      .populate([
        { path: "owner", select: "_id name companyEmail" },
        { path: "sender", select: "_id name companyEmail role designation" },
        { path: "receiver", select: "_id name companyEmail role designation" },
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

        // Also notify every senior who had previously approved — they need to
        // re-approve and should see the message flip back to pending
        previousApproverIds.forEach((aid) => allParticipants.add(aid));

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
          previousApproverIds,
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
      { path: "sender", select: "_id name companyEmail role designation" },
      { path: "receiver", select: "_id name companyEmail role designation" },
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
      { path: "sender", select: "_id name companyEmail role designation" },
      { path: "receiver", select: "_id name companyEmail role designation" },
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

// Permanently delete a message
// DELETE /api/assignment-messages/thread/:clientId - Delete entire thread for a client
exports.deleteThread = async function deleteThread(req, res) {
  try {
    const threadId = req.params.threadId || req.params.clientId;

    if (!threadId) {
      return res.status(400).json({ error: "Valid thread ID is required" });
    }

    const currentUser = req.employee._id;
    const isIdValidObject = mongoose.isValidObjectId(threadId);

    // Find all messages for this thread where user is involved
    const threadMessages = await AssignmentMessage.find({
      $and: [
        {
          $or: isIdValidObject
            ? [{ threadId: threadId }, { client: threadId }]
            : [{ threadId: threadId }],
        },
        {
          $or: [
            { sender: currentUser },
            { receiver: currentUser },
            { receiver: { $in: [currentUser] } },
          ],
        },
      ],
    });

    if (threadMessages.length === 0) {
      return res.status(404).json({ error: "No thread found" });
    }

    // Store message IDs for socket emission
    const messageIds = threadMessages.map((msg) => msg._id);

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
          threadId: threadId,
          messageIds: messageIds,
          deletedBy: currentUser.toString(),
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
    const threadId = req.params.threadId || req.params.clientId;

    if (!threadId) {
      return res.status(400).json({ error: "Valid thread ID is required" });
    }

    const currentUser = req.employee._id;
    const isIdValidObject = mongoose.isValidObjectId(threadId);

    // Find all trashed/spam messages for this thread where user is involved
    const trashedMessages = await AssignmentMessage.find({
      $and: [
        {
          $or: isIdValidObject
            ? [{ threadId: threadId }, { client: threadId }]
            : [{ threadId: threadId }],
        },
        {
          $or: [
            { sender: currentUser },
            { receiver: currentUser },
            { receiver: { $in: [currentUser] } },
          ],
        },
        {
          $or: [
            { isTrashed: true },
            { isSpam: true }
          ]
        }
      ]
    });

    if (trashedMessages.length === 0) {
      return res
        .status(404)
        .json({ error: "No trashed or spam thread found with this thread ID" });
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
            threadId: threadId,
            messageIds: messageIds,
            deletedBy: currentUser.toString(),
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
    const threadId = req.params.threadId || req.params.clientId;

    if (!threadId) {
      return res.status(400).json({ error: "Valid thread ID is required" });
    }

    const currentUser = req.employee._id;
    const isIdValidObject = mongoose.isValidObjectId(threadId);

    // Find all messages for this thread where user is involved
    const threadMessages = await AssignmentMessage.find({
      $and: [
        {
          $or: isIdValidObject
            ? [{ threadId: threadId }, { client: threadId }]
            : [{ threadId: threadId }],
        },
        {
          $or: [
            { sender: currentUser },
            { receiver: currentUser },
            { receiver: { $in: [currentUser] } },
          ],
        },
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
        trashedBy: currentUser,
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
          trashedBy: currentUser.toString(),
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
    const threadId = req.params.threadId || req.params.clientId;

    if (!threadId) {
      return res.status(400).json({ error: "Valid thread ID is required" });
    }

    const currentUser = req.employee._id;
    const isIdValidObject = mongoose.isValidObjectId(threadId);

    // Find all trashed messages for this thread where user is involved
    const trashedMessages = await AssignmentMessage.find({
      $and: [
        {
          $or: isIdValidObject
            ? [{ threadId: threadId }, { client: threadId }]
            : [{ threadId: threadId }],
        },
        {
          $or: [
            { sender: currentUser },
            { receiver: currentUser },
            { receiver: { $in: [currentUser] } },
          ],
        },
      ],
      isTrashed: true,
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
          threadId: threadId,
          messageIds: trashedMessages.map((msg) => msg._id),
          restoredBy: currentUser.toString(),
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
      { path: "sender", select: "_id name companyEmail role designation" },
      { path: "receiver", select: "_id name companyEmail role designation" },
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
      { path: "sender", select: "_id name companyEmail role designation" },
      { path: "receiver", select: "_id name companyEmail role designation" },
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
    const isManager = currentUserRole === "manager" || currentUserRole === "owner";

    // Check permissions: either sender OR team lead OR manager can edit pending messages
    const isSender = String(msg.sender) === currentUserId;

    if (!isSender && !isTeamLead && !isManager) {
      return res.status(403).json({
        error:
          "You don't have permission to edit this pending message. Only the sender, team leads or managers can edit pending messages.",
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
        { path: "sender", select: "_id name companyEmail role designation" },
        { path: "receiver", select: "_id name companyEmail role designation" },
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

    // 🔥 NEW: Also mark the ENTIRE thread as read (optional - you can remove if not needed)
    // This ensures when user opens one message, whole thread gets marked as read
    const threadMessages = await AssignmentMessage.find({
      threadId: message.threadId,
      $or: [{ receiver: userId }, { receiver: { $in: [userId] } }, { sender: userId }],
      isTrashed: false,
      isSpam: false,
      "readBy.employee": { $ne: userId }, // Only unread ones
    });

    if (threadMessages.length > 0) {
      const threadUpdatePromises = threadMessages.map((msg) => {
        if (msg._id.toString() !== id) { // Don't update the current message again
          return AssignmentMessage.findByIdAndUpdate(
            msg._id,
            {
              $push: {
                readBy: {
                  employee: userId,
                  readAt: new Date(),
                },
              },
            },
            { new: true }
          );
        }
        return Promise.resolve();
      });

      await Promise.all(threadUpdatePromises);
    }

    // 🔥 FIX: Emit socket event
    const io = getIO(req);
    if (io) {
      // Get all participants
      const allParticipants = new Set();

      // Add sender
      const senderId = String(message.sender);
      allParticipants.add(senderId);

      // Add receivers
      if (message.receiver && Array.isArray(message.receiver)) {
        message.receiver.forEach((receiver) => {
          const receiverId = String(receiver);
          allParticipants.add(receiverId);
        });
      }

      // Add current user
      allParticipants.add(String(userId));

      // Emit to all participants
      allParticipants.forEach((participantId) => {
        io.to(`employee_${participantId}`).emit("message_read", {
          messageId: message._id,
          threadId: message.threadId,
          read: true,
          readBy: userId,
          timestamp: new Date(),
          markEntireThread: true, // Indicate that entire thread was marked
        });
      });
    }

    res.json({
      success: true,
      message: "Message and thread marked as read",
      data: {
        messageId: message._id,
        threadId: message.threadId,
        readBy: message.readBy,
        threadMarkedCount: threadMessages.length,
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

exports.markThreadAsRead = async function markThreadAsRead(req, res) {
  try {
    const { threadId } = req.params;
    const userId = req.employee._id;

    if (!threadId || threadId.trim() === "") {
      return res.status(400).json({
        success: false,
        error: "Thread ID is required",
      });
    }

    // 🔥 CRITICAL FIX: Get ALL messages in the thread (not just unread ones)
    const threadMessages = await AssignmentMessage.find({
      threadId: threadId,
      $or: [{ receiver: userId }, { receiver: { $in: [userId] } }, { sender: userId }],
      isTrashed: false,
      isSpam: false,
    });

    if (threadMessages.length === 0) {
      return res.status(404).json({
        success: false,
        error: "No messages found in this thread or you don't have access",
      });
    }

    // 🔥 FIX: Mark ALL messages in thread as read (not just unread ones)
    const updatePromises = threadMessages.map((msg) => {
      // Check if user already marked this message as read
      const alreadyRead = msg.readBy.some(
        (read) => read.employee.toString() === userId.toString()
      );

      if (!alreadyRead) {
        return AssignmentMessage.findByIdAndUpdate(
          msg._id,
          {
            $push: {
              readBy: {
                employee: userId,
                readAt: new Date(),
              },
            },
          },
          { new: true }
        );
      }
      return Promise.resolve(msg); // Already read, no update needed
    });

    await Promise.all(updatePromises);

    // 🔥 FIX: Emit socket event for entire thread
    const io = getIO(req);
    if (io) {
      // Get all participants in this thread
      const allParticipants = new Set();

      threadMessages.forEach((message) => {
        // Add sender
        const senderId = String(message.sender);
        allParticipants.add(senderId);

        // Add receivers
        if (message.receiver && Array.isArray(message.receiver)) {
          message.receiver.forEach((receiver) => {
            const receiverId = String(receiver);
            allParticipants.add(receiverId);
          });
        }
      });

      // Emit to all participants
      allParticipants.forEach((participantId) => {
        io.to(`employee_${participantId}`).emit("thread_marked_as_read", {
          threadId: threadId,
          markedBy: userId,
          timestamp: new Date(),
          messageCount: threadMessages.length,
        });
      });
    }

    res.json({
      success: true,
      message: `Marked all ${threadMessages.length} messages in thread as read`,
      threadId: threadId,
      markedCount: threadMessages.length,
    });
  } catch (error) {
    console.error("Error marking thread as read:", error);
    res.status(500).json({
      success: false,
      error: "Server error while marking thread as read",
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

    // 🔥 FIX: Emit socket event for real-time update
    const io = getIO(req);
    if (io) {
      const allParticipants = new Set();
      const senderId = String(message.sender);
      allParticipants.add(senderId);
      if (message.receiver && Array.isArray(message.receiver)) {
        message.receiver.forEach(r => allParticipants.add(String(r)));
      }
      allParticipants.add(String(userId));

      allParticipants.forEach(participantId => {
        io.to(`employee_${participantId}`).emit("message_read", {
          messageId: message._id,
          threadId: message.threadId,
          read: false,
          readBy: userId,
          timestamp: new Date()
        });
      });
    }

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

exports.markMultipleAsRead = async function markMultipleAsRead(req, res) {
  try {
    const { messageIds, markThreads = true } = req.body; // 🔥 NEW: Add markThreads option
    const userId = req.employee._id;

    if (!messageIds || !Array.isArray(messageIds)) {
      return res.status(400).json({
        success: false,
        error: "Message IDs array is required",
      });
    }

    // 🔥 FIX: Get all threads from the messages
    const messages = await AssignmentMessage.find({
      _id: { $in: messageIds },
      "readBy.employee": { $ne: userId },
      $or: [{ sender: userId }, { receiver: userId }],
    }).select('_id threadId');

    if (messages.length === 0) {
      return res.status(404).json({
        success: false,
        error: "No unread messages found",
      });
    }

    // Get unique thread IDs
    const threadIds = [...new Set(messages.map(msg => msg.threadId))];

    let threadMarkedCount = 0;

    // 🔥 NEW: Mark entire threads if requested
    if (markThreads) {
      for (const threadId of threadIds) {
        const threadMessages = await AssignmentMessage.find({
          threadId: threadId,
          $or: [{ receiver: userId }, { receiver: { $in: [userId] } }, { sender: userId }],
          isTrashed: false,
          isSpam: false,
          "readBy.employee": { $ne: userId },
        });

        if (threadMessages.length > 0) {
          const updatePromises = threadMessages.map((msg) =>
            AssignmentMessage.findByIdAndUpdate(
              msg._id,
              {
                $push: {
                  readBy: {
                    employee: userId,
                    readAt: new Date(),
                  },
                },
              },
              { new: true }
            )
          );

          await Promise.all(updatePromises);
          threadMarkedCount += threadMessages.length;
        }
      }
    } else {
      // Original behavior - mark only specific messages
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
      threadMarkedCount = result.modifiedCount;
    }

    // 🔥 FIX: Emit socket events
    const io = getIO(req);
    if (io) {
      threadIds.forEach((threadId) => {
        io.to(`employee_${userId}`).emit("thread_marked_as_read", {
          threadId: threadId,
          markedBy: userId,
          timestamp: new Date(),
        });
      });
    }

    res.json({
      success: true,
      message: markThreads
        ? `Marked ${threadMarkedCount} messages across ${threadIds.length} threads as read`
        : `Marked ${threadMarkedCount} messages as read`,
      data: {
        modifiedCount: threadMarkedCount,
        threadsAffected: threadIds.length,
        markThreads: markThreads,
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

/**
 * Get email activity for employees based on hierarchy
 * Shows activity of juniors to their seniors
 * Admin can see all employees' activity
 */
exports.getActivity = async function getActivity(req, res) {
  try {
    // This endpoint uses empAuth middleware, so req.employee is always available
    if (!req.employee || !req.employee._id) {
      return res.status(401).json({
        success: false,
        error: "Unauthorized: Employee not found",
      });
    }

    const currentEmployeeId = req.employee._id;
    let ownerId = req.employee.owner;
    const role = (req.employee.role || "").trim().toLowerCase();
    const isAdmin = role === "admin" || role === "hr";

    if (!ownerId) {
      return res.status(400).json({
        success: false,
        error: "Owner ID is missing",
      });
    }

    // Convert ownerId to string if it's an ObjectId
    ownerId = String(ownerId);

    // Ensure ownerId is a valid ObjectId
    if (!isObjId(ownerId)) {
      console.error("Invalid ownerId:", ownerId, "Type:", typeof ownerId);
      return res.status(400).json({
        success: false,
        error: "Invalid owner ID format",
      });
    }

    // Get current employee info
    const currentEmployee = await Employee.findById(currentEmployeeId)
      .select("_id name companyEmail role owner")
      .lean();

    if (!currentEmployee) {
      return res.status(404).json({
        success: false,
        error: "Employee not found",
      });
    }

    let employeeIdsToShow = [];

    if (isAdmin) {
      // Admin can see all employees' activity
      const allEmployees = await Employee.find({ owner: ownerId, status: "active" })
        .select("_id")
        .lean();
      employeeIdsToShow = allEmployees.map((emp) => String(emp._id));
    } else {
      // Regular employees see their own activity + all their juniors' activity
      employeeIdsToShow = [String(currentEmployeeId)];
      const juniors = await getAllJuniorsRecursively(ownerId, currentEmployeeId);
      employeeIdsToShow = [...employeeIdsToShow, ...juniors];
    }

    if (employeeIdsToShow.length === 0) {
      return res.json({
        success: true,
        data: {
          activities: [],
          summary: {
            totalUnread: 0,
            totalResponded: 0,
            totalEmployees: 0,
          },
        },
      });
    }

    // Convert employeeIdsToShow to ObjectIds for query
    const employeeObjectIds = employeeIdsToShow
      .filter(id => isObjId(id))
      .map(id => oid(id));

    if (employeeObjectIds.length === 0) {
      return res.json({
        success: true,
        data: {
          activities: [],
          summary: {
            totalUnread: 0,
            totalResponded: 0,
            totalEmployees: 0,
          },
        },
      });
    }

    // Get employee details first
    const employeeDetails = await Employee.find({
      _id: { $in: employeeObjectIds },
    })
      .select("_id name companyEmail")
      .lean();

    // Group activity by employee - simplified approach
    const activityMap = new Map();

    // Initialize activity for each employee
    employeeDetails.forEach((emp) => {
      const empId = String(emp._id);
      activityMap.set(empId, {
        employeeId: empId,
        employeeName: emp.name,
        employeeEmail: emp.companyEmail,
        unreadEmails: [],
        respondedEmails: [],
        unreadCount: 0,
        respondedCount: 0,
      });
    });

    // Convert ownerId to ObjectId once
    const ownerObjectId = oid(ownerId);

    // Get unread count per employee (simplified query)
    for (const empId of employeeIdsToShow) {
      if (!isObjId(empId)) continue;

      const empObjectId = oid(empId);

      // Count unread messages for this employee
      // Check messages where employee is receiver and hasn't read them
      const unreadMessages = await AssignmentMessage.find({
        owner: ownerObjectId,
        receiver: empObjectId,
        status: "sent",
        isTrashed: false,
        isSpam: false,
      })
        .select("_id readBy")
        .lean();

      const unreadCount = unreadMessages.filter(msg => {
        if (!msg.readBy || msg.readBy.length === 0) return true;
        return !msg.readBy.some(read => String(read.employee) === String(empId));
      }).length;

      // Get recent unread emails (limit to 5) - filter in memory for accuracy
      let allRecentMessages = [];
      try {
        allRecentMessages = await AssignmentMessage.find({
          owner: ownerObjectId,
          receiver: empObjectId,
          status: "sent",
          isTrashed: false,
          isSpam: false,
          sender: { $exists: true, $ne: null } // Ensure sender exists
        })
          .select("_id sender subject createdAt threadId readBy")
          .populate({
            path: "sender",
            select: "name companyEmail",
            model: "Employee",
            options: { lean: true }
          })
          .sort({ createdAt: -1 })
          .limit(20) // Get more to filter
          .lean();
      } catch (populateError) {
        console.error("Error populating sender for employee:", empId, populateError.message);
        // Try without populate if there's an error
        try {
          allRecentMessages = await AssignmentMessage.find({
            owner: ownerObjectId,
            receiver: empObjectId,
            status: "sent",
            isTrashed: false,
            isSpam: false,
          })
            .select("_id sender subject createdAt threadId readBy")
            .sort({ createdAt: -1 })
            .limit(20)
            .lean();
        } catch (queryError) {
          console.error("Error querying messages:", queryError.message);
          allRecentMessages = []; // Set to empty array on error
        }
      }

      const recentUnread = allRecentMessages
        .filter(msg => {
          if (!msg.readBy || msg.readBy.length === 0) return true;
          return !msg.readBy.some(read => String(read.employee) === String(empId));
        })
        .slice(0, 5)
        .map(msg => ({
          _id: msg._id,
          sender: msg.sender,
          subject: msg.subject,
          createdAt: msg.createdAt,
          threadId: msg.threadId,
        }));

      // Count responded messages
      const respondedCount = await AssignmentMessage.countDocuments({
        owner: ownerObjectId,
        sender: empObjectId,
        replyTo: { $exists: true, $ne: null },
        status: "sent",
        isTrashed: false,
        isSpam: false,
      });

      // Get recent responded emails (limit to 5)
      let recentResponded = [];
      try {
        recentResponded = await AssignmentMessage.find({
          owner: ownerObjectId,
          sender: empObjectId,
          replyTo: { $exists: true, $ne: null },
          status: "sent",
          isTrashed: false,
          isSpam: false,
          receiver: { $exists: true, $ne: null } // Ensure receiver exists
        })
          .select("_id receiver subject createdAt threadId replyTo")
          .populate({
            path: "receiver",
            select: "name companyEmail",
            model: "Employee",
            options: { lean: true }
          })
          .sort({ createdAt: -1 })
          .limit(5)
          .lean();
      } catch (populateError) {
        console.error("Error populating receiver for employee:", empId, populateError.message);
        // Try without populate if there's an error
        try {
          recentResponded = await AssignmentMessage.find({
            owner: ownerObjectId,
            sender: empObjectId,
            replyTo: { $exists: true, $ne: null },
            status: "sent",
            isTrashed: false,
            isSpam: false,
          })
            .select("_id receiver subject createdAt threadId replyTo")
            .sort({ createdAt: -1 })
            .limit(5)
            .lean();
        } catch (queryError) {
          console.error("Error querying responded messages:", queryError.message);
          recentResponded = []; // Set to empty array on error
        }
      }

      const empIdStr = String(empId);
      if (activityMap.has(empIdStr)) {
        const activity = activityMap.get(empIdStr);
        activity.unreadCount = unreadCount;
        activity.respondedCount = respondedCount;

        // Process recent unread
        activity.unreadEmails = recentUnread.map(msg => {
          // Handle sender - could be ObjectId or populated object
          let senderName = "Unknown";
          let senderEmail = "";

          if (msg.sender) {
            if (typeof msg.sender === 'object' && msg.sender.name) {
              senderName = msg.sender.name || msg.sender.companyEmail || "Unknown";
              senderEmail = msg.sender.companyEmail || "";
            } else if (isObjId(msg.sender)) {
              // It's an ObjectId, we'll need to fetch it separately if needed
              senderName = "Unknown";
            }
          }

          return {
            id: String(msg._id),
            subject: msg.subject || "No Subject",
            sender: senderName,
            senderEmail: senderEmail,
            createdAt: msg.createdAt,
            threadId: msg.threadId,
          };
        });

        // Process recent responded
        activity.respondedEmails = recentResponded.map(msg => {
          // Handle receiver - could be ObjectId, array of ObjectIds, or populated objects
          let receiverName = "Unknown";

          if (msg.receiver) {
            if (Array.isArray(msg.receiver)) {
              receiverName = msg.receiver
                .map((r) => {
                  if (typeof r === 'object' && r.name) {
                    return r.name || r.companyEmail || "Unknown";
                  }
                  return "Unknown";
                })
                .join(", ");
            } else if (typeof msg.receiver === 'object' && msg.receiver.name) {
              receiverName = msg.receiver.name || msg.receiver.companyEmail || "Unknown";
            }
          }

          return {
            id: String(msg._id),
            subject: msg.subject || "No Subject",
            receiver: receiverName,
            createdAt: msg.createdAt,
            threadId: msg.threadId,
            replyTo: msg.replyTo ? String(msg.replyTo) : undefined,
          };
        });
      }
    }

    // Build final activities array (already has employee details from activityMap)
    const activities = Array.from(activityMap.values())
      .filter((activity) => activity.unreadCount > 0 || activity.respondedCount > 0) // Only show employees with activity
      .sort((a, b) => {
        // Sort by total activity (unread + responded)
        const totalA = a.unreadCount + a.respondedCount;
        const totalB = b.unreadCount + b.respondedCount;
        return totalB - totalA;
      });

    // Calculate summary
    const summary = {
      totalUnread: activities.reduce((sum, act) => sum + act.unreadCount, 0),
      totalResponded: activities.reduce((sum, act) => sum + act.respondedCount, 0),
      totalEmployees: activities.length,
    };

    res.json({
      success: true,
      data: {
        activities,
        summary,
      },
    });
  } catch (error) {
    console.error("Error getting activity:", error);
    res.status(500).json({
      success: false,
      error: "Server error while fetching activity",
      message: error.message,
    });
  }
};