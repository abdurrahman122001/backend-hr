const AssignmentMessage = require("../models/AssignmentMessage");
const Employee = require("../models/Employees");
const path = require("path");
const mongoose = require("mongoose");
const ClientInfo = require("../models/ClientInfo");
const EmployeeHierarchy = require("../models/EmployeeHierarchy");
const { hasCrmAccess, getCrmUserIds } = require("../utils/crmAccess");
const { sendApprovedReplyToClient } = require("../services/clientEmailService");

function readByEmployeeId(readEntry) {
  const employee = readEntry?.employee ?? readEntry;
  return employee?._id ? String(employee._id) : employee ? String(employee) : "";
}

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
  // Callers sometimes pass a populated Employee doc rather than an id. A
  // Mongoose document passes isValidObjectId() but String()s to its inspect
  // dump, which then blows up the `junior` cast — so unwrap it first.
  const startId = employeeId?._id ?? employeeId;
  if (!isObjId(ownerId) || !isObjId(startId)) return [];

  try {
    const chain = [];
    let currentEmployee = startId;
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
// The system's own mailboxes must never appear as CC recipients. They sneak in
// when a client hits Reply-All in Gmail (our receiving address lands in their CC,
// gets stored on the inbound message, and the UI's Reply-All then inherits it).
function getOwnMailboxAddresses() {
  return [
    process.env.CLIENT_MAIL_FROM_ADDRESS,
    process.env.CLIENT_MAIL_USERNAME,
    process.env.MAIL_FROM_ADDRESS,
    process.env.MAIL_USERNAME,
    process.env.IMAP_USER,
  ]
    .filter(Boolean)
    .map((e) => e.trim().toLowerCase());
}

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

// The own-mailbox filter exists to stop the system's own inbound/outbound
// mailbox being CC'd on client mail (which would loop). But a real EMPLOYEE can
// legitimately use one of those addresses — CC'ing them was silently dropping
// the whole entry, so the message reached nobody. Only strip an own-mailbox
// address when it does NOT belong to an employee.
async function parseCCEmailsForOwner(ccBody, ownerId) {
  const ccEmails = parseCCEmails(ccBody);
  if (!ccEmails.length) return ccEmails;

  const ownMailboxes = getOwnMailboxAddresses();
  const collisions = ccEmails.filter((cc) => ownMailboxes.includes(cc.email));
  if (!collisions.length) return ccEmails;

  const employeeAddresses = new Set();
  if (isObjId(ownerId)) {
    const matches = await findEmployeesByEmails(
      ownerId,
      collisions.map((cc) => cc.email)
    );
    matches.forEach((emp) => {
      if (emp.email) employeeAddresses.add(emp.email.trim().toLowerCase());
      if (emp.companyEmail)
        employeeAddresses.add(emp.companyEmail.trim().toLowerCase());
    });
  }

  return ccEmails.filter(
    (cc) => !ownMailboxes.includes(cc.email) || employeeAddresses.has(cc.email)
  );
}

// BCC counterpart of syncCCWithReceivers. Blind recipients must still RECEIVE
// the message, so their employee ids are resolved here — but they are returned
// as a separate list rather than merged into `receiver`, because `receiver` is
// what every UI renders as the visible recipient list.
//
// Addresses that match no employee are external; they stay in the stored `bcc`
// array for the outbound envelope and simply resolve to nobody internally.
async function resolveBccReceivers(bccEmails, ownerId, senderId, approvalStatus) {
  if (!bccEmails || bccEmails.length === 0 || approvalStatus === "pending") {
    return [];
  }

  const matchingEmployees = await findEmployeesByEmails(
    ownerId,
    bccEmails.map((b) => b.email)
  );

  const blindReceivers = [];
  matchingEmployees.forEach((employee) => {
    const employeeId = String(employee._id);
    // Blind-copying yourself is a no-op; the sender already has it in Sent.
    if (employeeId === String(senderId)) return;
    if (!blindReceivers.includes(employeeId)) blindReceivers.push(employeeId);
  });

  return blindReceivers;
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

  // Hierarchy lookup for junior-based visibility — RECURSIVE (full subtree),
  // so a senior sees the messages of every junior beneath them, not just their
  // direct reports.
  const juniorIdStrings = await getAllJuniorsRecursively(ownerId, me);
  const juniorIds = juniorIdStrings.map((id) => oid(String(id)));

  // 👁️ HIERARCHY VISIBILITY (role-independent for seniority)
  // 🔑 ACCESS-BASED: CRM-access holders (and rootManager) see all org email.
  const isCrmUser = await hasCrmAccess(req.employee);
  const roleHierarchyFilter = {
    $or: [
      // Only CRM users / Owners (top of the hierarchy) see all org messages.
      // Team leads are NOT special-cased — they see their juniors via the
      // recursive junior filter below, so visibility is purely seniority-based.
      ...(isCrmUser || currentUserRole === "owner" ? [{ owner: ownerId }] : []),
      // Seniors see messages from their juniors (entire subtree)
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
          // Forwards are private to their explicit recipients — they must never
          // appear via org-wide / role-hierarchy / client-assignment visibility.
          { isForward: { $ne: true } },
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

    // Add anyone assigned to the client so it shows in their external inbox.
    // CRM-access/root sends are stored with approvalStatus null, while approved
    // employee replies use "approved"; both are deliverable. Pending messages
    // must stay limited to their approval receivers. Forwards are private to
    // their explicit recipients, so they are never fanned out to the client team.
    if (
      populatedMessage.client &&
      populatedMessage.approvalStatus !== "pending" &&
      !populatedMessage.isForward
    ) {
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
// Slim a message for socket emits / JSON responses: inbound emails store whole
// attachment files as base64 `data:` URIs — broadcasting those to every
// participant serializes megabytes per emit. Point the URL at the streaming
// endpoint instead (same shape the thread endpoint returns).
function slimEmailDoc(doc) {
  if (!doc) return doc;
  const m = typeof doc.toObject === "function" ? doc.toObject() : { ...doc };
  if (Array.isArray(m.attachments) && m.attachments.length > 0) {
    m.attachments = m.attachments.map((a) =>
      a && typeof a.url === "string" && a.url.startsWith("data:")
        ? {
            ...a,
            url: `/assignment-messages/${m._id}/attachment/${a._id}`,
            hasInlineData: true,
          }
        : a
    );
  }
  if (m.emailMetadata && m.emailMetadata.headers) {
    delete m.emailMetadata.headers;
  }
  return m;
}

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
    // Trimmed populates + slim emit payload: the old unselected populates
    // pulled the full owner/sender/receiver/client docs, and the raw message
    // carries base64 attachment data — both made this refetch/emit slow.
    const populatedDoc = await AssignmentMessage.findById(message._id)
      .populate("owner", "_id name companyEmail")
      .populate("sender", "_id name companyEmail role designation")
      .populate("receiver", "_id name companyEmail role designation")
      .populate("client", "_id clientName photographUrl");

    if (!populatedDoc) return;
    const populatedMessage = slimEmailDoc(populatedDoc);

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

    // Add users assigned to this client once the message is deliverable.
    if (populatedMessage.client && populatedMessage.approvalStatus !== "pending") {
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
  }

  // No senior above the sender. Two distinct cases:
  //  1. Sender is the TOP of the hierarchy (they have juniors below them) →
  //     nobody outranks them, so the message needs no approval. Auto-approve
  //     and deliver directly (do NOT route to CRM/managers).
  //  2. Sender is not part of the hierarchy at all → fall back to managers/CRM.
  const juniors = await getAllJuniorsRecursively(owner, sender);
  if (juniors.length > 0) {
    return {
      receivers: null, // keep the original intended recipients
      approvalStatus: "approved",
      targetSupervisor: null,
      autoApprove: true,
    };
  }

  // Sender has no hierarchy relationship — route to managers/CRM but keep pending
  const { managers, crm } = await findTLsAndManagersByOwner(owner);
  const crmIds = Array.isArray(crm) ? crm : [];
  const fallbackReceivers = Array.from(new Set([...managers, ...crmIds]));
  return {
    receivers: fallbackReceivers,
    approvalStatus: "pending",
    targetSupervisor: null
  };
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

  // 🔑 ACCESS-BASED: "managers" and "crm" are now both the CRM-access holders
  // + rootManager (was role-based: role /manager|crm/). The role field is kept
  // for hierarchy/leave/payroll but no longer grants CRM/manager powers.
  const crmUserIds = await getCrmUserIds(ownerId);

  const employees = await Employee.find({
    owner: ownerId,
    $or: [{ role: "Employee" }, { role: "employee" }],
  })
    .select("_id")
    .lean();

  return {
    tls: tls.map((x) => String(x._id)),
    managers: crmUserIds,
    employees: employees.map((x) => String(x._id)),
    crm: crmUserIds,
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
            { path: "client", select: "_id clientName legalBusinessName dba" },
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
        { path: "client", select: "_id clientName legalBusinessName dba" },
        { path: "attachments.uploadedBy", select: "_id name companyEmail" },
      ])
      .lean();

    return res.json({ messages });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Failed to load message history" });
  }
};


// Fields createMessage actually reads off thread/original messages when
// routing a reply. Everything else (note HTML, base64 attachments,
// emailMetadata) is dead weight for this path.
const THREAD_ROUTING_FIELDS =
  "_id threadId sender receiver subject client role approvalStatus " +
  "isFromClient isFromCompanyEmployee clientEmployeeName clientEmployeeEmail clientName createdAt";

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
      bcc: bccBody,
      sentOnBehalfOfAdmin,
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
      .select("_id role supervisor supervisionMode owner isAdmin")
      .lean();
    const senderRole = normalizeRole(senderDoc?.role || "");
    // The client/company-employee context below used to be preserved only for
    // role === "manager". CRM powers are access-based now, so a CRM-access
    // sender whose role is "Employee" had the context nulled and their reply
    // showed their own name instead of the company employee they addressed
    // it to. Gate on CRM access (or the legacy role) instead.
    const senderCanActAsClient =
      senderRole === "manager" || (await hasCrmAccess(req.employee));

    // Forwards must not inherit the original thread — keeping them private to
    // their selected recipients means starting their own thread, even if the
    // client provided the source threadId for linkage.
    let threadId = isForward ? undefined : providedThreadId;
    let originalMessage = null;
    let threadMessages = [];
    let isNewThread = true;
    let threadHasTeamLead = false;
    let threadOriginalSenderRole = null;
    let threadHasEmployeeWithSupervision = false;

    if (providedThreadId || replyTo) {
      try {
        if (providedThreadId) {
          // Select only routing/inheritance fields — full docs drag in base64
          // attachment data URIs (megabytes per inbound email), which was the
          // main reason sending a reply was slow.
          threadMessages = await AssignmentMessage.find({
            threadId: providedThreadId,
          })
            .sort({ createdAt: -1 })
            .limit(50)
            .select(THREAD_ROUTING_FIELDS)
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
          originalMessage = await AssignmentMessage.findById(replyTo)
            .select(THREAD_ROUTING_FIELDS)
            .lean();
          if (originalMessage && !providedThreadId) {
            threadId = originalMessage.threadId;
            threadMessages = await AssignmentMessage.find({
              threadId: originalMessage.threadId,
            })
              .sort({ createdAt: -1 })
              .limit(50)
              .select(THREAD_ROUTING_FIELDS)
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

    if (senderCanActAsClient) {
      if (isFromClient || isFromCompanyEmployee) {
        inheritedIsFromClient = isFromClient || false;
        inheritedIsFromCompanyEmployee = isFromCompanyEmployee || false;
        inheritedClientEmployeeName = clientEmployeeName || null;
        inheritedClientEmployeeEmail = clientEmployeeEmail || null;
        inheritedClientName = clientName || null;
      }
      else if (threadMessages.length > 0) {
        // Prefer inheriting from a company-employee message so the employee's
        // name is preserved. Only fall back to a plain client message if the
        // thread has no company-employee message. (Previously this grabbed the
        // newest message that was EITHER client OR company-employee, so a client
        // message could win and the reply would show the client name instead of
        // the company employee.)
        const threadCompanyEmployeeMsg =
          threadMessages.find(
            (msg) => msg.isFromCompanyEmployee && msg.clientEmployeeName
          ) || threadMessages.find((msg) => msg.isFromCompanyEmployee);
        const threadExternalMsg =
          threadCompanyEmployeeMsg ||
          threadMessages.find((msg) => msg.isFromClient);

        if (threadExternalMsg) {
          inheritedIsFromClient = threadExternalMsg.isFromClient;
          inheritedIsFromCompanyEmployee =
            threadExternalMsg.isFromCompanyEmployee;
          inheritedClientEmployeeName =
            threadExternalMsg.clientEmployeeName;
          inheritedClientEmployeeEmail =
            threadExternalMsg.clientEmployeeEmail;
          inheritedClientName = threadExternalMsg.clientName;
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
    let senderHasCrmAccess = false;

    // One parallel fetch instead of two sequential findTLsAndManagersByOwner
    // calls (here and again further down) plus a separate client lookup.
    const [tlsAndManagers, clientDocFetched] = await Promise.all([
      findTLsAndManagersByOwner(owner),
      client && isObjId(client)
        ? ClientInfo.findById(client)
            .populate("assignedTo", "_id role")
            .select("supervision assignedTo supervisedBy")
            .lean()
        : Promise.resolve(null),
    ]);
    const { tls, managers } = tlsAndManagers;

    if (client && isObjId(client)) {
      clientDoc = clientDocFetched;

      if (clientDoc) {
        clientSupervisionMode = clientDoc.supervision || "direct";
        // Support both array and single-object assignedTo
        assignedToIds = (Array.isArray(clientDoc.assignedTo) ? clientDoc.assignedTo : [clientDoc.assignedTo])
          .filter(Boolean)
          .map(emp => String(emp._id || emp));

        isSenderAssigned = assignedToIds.includes(String(sender));

        // 🔥 SENIOR → CRM ROUTING: if the sender is NOT the assigned employee
        // (a senior composing to a downline client), the message must be
        // delivered to the CRM (manager) — NOT the assigned junior/sub-junior.
        // Only when the sender IS assigned (their own client), or is themselves
        // the sole/top CRM, do we keep adding the assigned team members.
        const ownerManagerIds = managers;
        const otherManagerIds = ownerManagerIds.filter((id) => id !== String(sender));
        // CRM authority is access-based, not role-based: the sender may hold CRM
        // access (ownerManagerIds = CRM-access users + rootManager) without the
        // literal "manager" role. A CRM sender addressing a client's assigned
        // employee must reach them DIRECTLY — they must NOT be rerouted up to
        // another (top) CRM. The old role-only `senderIsTopCrm` check failed for
        // access-based CRM users, which is why a reply to the assigned employee
        // also got delivered to the top CRM (rootManager).
        senderHasCrmAccess = ownerManagerIds.includes(String(sender));
        const senderIsTopCrm =
          (senderRole === "manager" || senderHasCrmAccess) &&
          otherManagerIds.length === 0;

        // A FORWARD is private to the recipients the sender explicitly chose —
        // it must NOT fan out to the client's assigned team / CRM / admin
        // broadcast the way a normal client reply does. Skip all receiver
        // augmentation for forwards (the variables above are still computed
        // because approvalStatus logic below relies on them).
        if (!isForward) {
          if (
            !isSenderAssigned &&
            !senderIsTopCrm &&
            !senderHasCrmAccess &&
            otherManagerIds.length > 0
          ) {
            // Non-CRM senior composing to a downline client: route to the CRM
            // (manager); do NOT add the assigned junior.
            otherManagerIds.forEach((id) => {
              if (!receivers.includes(id) && id !== String(sender)) {
                receivers.push(id);
              }
            });
          } else {
            // Own client, sender is the top CRM, or sender holds CRM access:
            // add assigned team members (and never reroute to another CRM).
            assignedToIds.forEach((id) => {
              if (!receivers.includes(id) && id !== String(sender)) {
                receivers.push(id);
              }
            });
          }

          // 👑 ADMIN CRM BROADCAST: a client compose from an isAdmin employee
          // who holds CRM access is delivered to ALL CRM-access users (not just
          // the client's assigned employees), so every CRM user receives it.
          if (senderHasCrmAccess && senderDoc?.isAdmin === true) {
            otherManagerIds.forEach((id) => {
              if (!receivers.includes(id) && id !== String(sender)) {
                receivers.push(id);
              }
            });
          }
        }
      }

      if (
        inheritedIsFromClient ||
        inheritedIsFromCompanyEmployee ||
        ((isFromClient || isFromCompanyEmployee) &&
          (senderRole === "manager" || senderHasCrmAccess))
      ) {
        // Client-originated emails are outside the approval flow entirely —
        // store null (like inbound IMAP client emails), not "approved".
        // The raw body flags only count for manager/CRM-access senders: the
        // reply composer inherits isFromClient from the original message, so
        // an ungated check let a junior's reply to a client-inbound email
        // skip the needs_approval → pending supervision path below.
        approvalStatus = null;
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

    // tls/managers already fetched above (single findTLsAndManagersByOwner call)

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
        if (hierarchyResult.autoApprove) {
          // Sender is top of hierarchy — no approval needed, keep intended recipients
          approvalStatus = "approved";
          targetSupervisor = null;
        } else {
          receivers = hierarchyResult.receivers;
          approvalStatus = hierarchyResult.approvalStatus;
          targetSupervisor = hierarchyResult.targetSupervisor;
        }

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
          // Keep fellow managers (e.g. the client's CRM) — the SENIOR→CRM
          // routing above adds them and they must not be filtered out.
          const isManagerRecipient = managers.includes(receiverId);

          // For new threads, team leads are ONLY included if explicitly specified
          const includeTeamLead = isTeamLead && isExplicitReceiver;

          return (isExplicitReceiver || isAssignedTeamMember || isClientEmployee || includeTeamLead || isManagerRecipient) && !(isTeamLead && !isExplicitReceiver);
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
          // Keep fellow managers (e.g. the client's CRM) — the SENIOR→CRM
          // routing above adds them and they must not be filtered out.
          const isManagerRecipient = managers.includes(receiverId);

          // For existing threads, team leads are included if:
          // 1. They're explicitly specified OR
          // 2. They're already in the thread
          const includeTeamLead = isTeamLead && (isExplicitReceiver || threadHasTeamLead);

          return isExplicitReceiver || isAssignedTeamMember || isClientEmployee || includeTeamLead || isManagerRecipient;
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

    let ccEmails = await parseCCEmailsForOwner(ccBody, owner);

    // 🔥 NEW: Check CC emails against employee database and add matching employees as receivers
    receivers = await syncCCWithReceivers(receivers, ccEmails, owner, sender, approvalStatus);

    // BCC resolves to its own recipient list — never merged into `receivers`.
    const bccEmails = await parseCCEmailsForOwner(bccBody, owner);
    const bccReceivers = await resolveBccReceivers(
      bccEmails,
      owner,
      sender,
      approvalStatus
    );

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
      isForward: !!isForward,
      intendedRecipients: (approvalStatus === "pending") ? originalIntendedReceivers : [],
      isFromClient: inheritedIsFromClient,
      isFromCompanyEmployee: inheritedIsFromCompanyEmployee,
      clientEmployeeName: inheritedClientEmployeeName,
      clientEmployeeEmail: inheritedClientEmployeeEmail,
      clientName: inheritedClientName,
      // Marks `sender` as an explicitly chosen internal identity, so the UI
      // shows that person instead of substituting the client.
      sentOnBehalfOfAdmin: !!sentOnBehalfOfAdmin,
    };

    if (client && isObjId(client)) {
      msgData.client = client;
    }

    if (ccEmails.length > 0) {
      msgData.cc = ccEmails;
    }

    if (bccEmails.length > 0) {
      msgData.bcc = bccEmails;
      msgData.bccReceiver = bccReceivers;
    }

    // Store the full ordered approval chain for display in Message Info
    if (approvalStatus === "pending") {
      const fullChain = await getManagementChainFromHierarchy(owner, String(sender));
      msgData.plannedApprovalChain = fullChain;
    }

    const msg = await AssignmentMessage.create(msgData);

    // ── Forward carries the whole conversation ──────────────────────────────
    // A forward starts its OWN thread (see the threadId decision above), so a
    // recipient who is not assigned to the client has no other route to the
    // history: whatever is not in this thread does not exist for them. Copy the
    // source thread's messages into the new thread so they receive the
    // conversation rather than a single message.
    //
    // Written straight through insertMany on purpose. These are copies of things
    // already said, so they must not re-run the approval chain, re-notify the
    // original participants, or re-send anything to the client's real mailbox —
    // all of which createMessage would do.
    if (isForward && providedThreadId && threadId && !isScheduled) {
      try {
        const sourceMessages = await AssignmentMessage.find({
          owner,
          threadId: providedThreadId,
          status: "sent",
          isScheduled: { $ne: true },
          // Never forward something still awaiting approval — it has not been
          // cleared to leave the hierarchy yet.
          approvalStatus: { $ne: "pending" },
        })
          .sort({ createdAt: 1 })
          .lean();

        const copies = sourceMessages
          // The message being forwarded is already quoted in the covering note.
          .filter((m) => String(m._id) !== String(replyTo || ""))
          .map((m) => ({
            owner,
            sender: m.sender,
            receiver: receivers,
            subject: m.subject || "",
            note: m.note || "",
            attachments: m.attachments || [],
            cc: m.cc || [],
            status: "sent",
            approvalStatus: "approved",
            isForward: true,
            // Keeps these out of every list/count query — see the field's note
            // in the model. They are readable only inside the forward's thread.
            isForwardedCopy: true,
            threadId,
            // Keep the original timestamps so the copies sort into the same
            // order they were written and the covering note stays newest.
            createdAt: m.createdAt,
            sentAt: m.sentAt || m.createdAt,
            // Preserve who the message appears to be from, or every copied
            // client message would read as an internal one.
            ...(m.client ? { client: m.client } : {}),
            isFromClient: !!m.isFromClient,
            isFromCompanyEmployee: !!m.isFromCompanyEmployee,
            clientEmployeeName: m.clientEmployeeName || null,
            clientEmployeeEmail: m.clientEmployeeEmail || null,
            clientName: m.clientName || null,
            // Arrive unread, and carry none of the original thread's per-user
            // state (bins, stars, spam reports belong to those participants).
            readBy: [],
          }));

        if (copies.length > 0) {
          await AssignmentMessage.insertMany(copies, { ordered: false });
        }
      } catch (err) {
        // The forward itself already exists; failing to copy the history must
        // not fail the send.
        console.error(
          "❌ [createMessage] Could not copy thread into forward:",
          err.message,
        );
      }
    }

    const populated = await msg.populate([
      { path: "owner", select: "_id name companyEmail" },
      { path: "sender", select: "_id name companyEmail role designation" },
      { path: "receiver", select: "_id name companyEmail role designation" },
      { path: "client", select: "_id clientName assignedTo" },
      { path: "scheduledBy", select: "_id name companyEmail" },
    ]);

    // A reply that is already fully approved at creation (top-of-hierarchy sender,
    // direct supervision, manager/team-lead) never passes through approveMessage,
    // so it must reach the client's real mailbox from here. The service is a no-op
    // for threads that did not originate from an inbound client email.
    if (!isScheduled && approvalStatus === "approved" && msgData.client) {
      sendApprovedReplyToClient(msg)
        .then((result) => {
          if (result?.sent) {
            console.log(`📤 [createMessage] Reply emailed to client: ${result.to}`);
          }
        })
        .catch((err) =>
          console.error("❌ [createMessage] Failed to email reply to client:", err.message)
        );
    }

    const io = getIO(req);
    if (io && !isScheduled) {
      await emitToAssignmentClients(io, msg, "new_assignment_message");

      // 🔥 HIERARCHY-BASED: Notify THE specific supervisor(s) about the thread
      // update. Gate on the actual outcome (pending) rather than sender role /
      // client mode — inherited-flag replies and non-"employee" senders also
      // produce pending messages, and their approvers need the realtime event.
      if (approvalStatus === "pending") {
        const supervisorsToNotify = targetSupervisor
          ? [String(targetSupervisor)]
          : (Array.isArray(msg.receiver) ? msg.receiver.map(String) : []);

        supervisorsToNotify.forEach(supervisorId => {
          io.to(`employee_${supervisorId}`).emit("thread_updated_for_supervision", {
            threadId: threadId,
            clientId: client,
            updatedAt: new Date(),
            message: "Thread requires your supervision",
          });
        });
      }

      // PRE-APPROVAL realtime: every senior ABOVE the current approver in the
      // sender's management chain can see (and act on) this pending message in
      // their Pre-approval tab — notify them so their list/count update live.
      if (approvalStatus === "pending") {
        try {
          const chainSeniors = await getManagementChainFromHierarchy(owner, sender);
          const currentApprover = targetSupervisor ? String(targetSupervisor) : null;
          (chainSeniors || [])
            .map(String)
            .filter((id) => id !== currentApprover && id !== String(sender))
            .forEach((seniorId) => {
              io.to(`employee_${seniorId}`).emit("supervision_updated", {
                threadId: threadId,
                clientId: client,
                updatedAt: new Date(),
              });
            });
        } catch (notifyErr) {
          console.error("pre-approval realtime notify error:", notifyErr);
        }
      }
    } else if (io && isScheduled) {
      // Sender-only: update their Scheduled list in realtime. Receivers must
      // not learn about the message before it actually sends.
      io.to(`employee_${String(sender)}`).emit("message_scheduled", {
        message: populated,
        timestamp: new Date(),
      });
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
      { path: "client", select: "_id clientName legalBusinessName dba" },
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
      { path: "client", select: "_id clientName legalBusinessName dba" },
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
          { path: "client", select: "_id clientName legalBusinessName dba" },
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
      { path: "client", select: "_id clientName legalBusinessName dba" },
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

            if (hierarchyResult.autoApprove) {
              // Sender is top of hierarchy — no approval needed, keep intended recipients
              message.approvalStatus = "approved";
              targetSupervisor = null;
            } else {
              message.receiver = hierarchyResult.receivers;
              message.approvalStatus = hierarchyResult.approvalStatus;
              targetSupervisor = hierarchyResult.targetSupervisor;
            }
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
// PRE-APPROVAL: an upline senior may act on a message that is pending at a
// LOWER level of their own hierarchy chain (e.g. the current approver is
// absent today). The current approver(s) = pending receivers who have not
// recorded an approval yet; both the sender and the current approver must be
// the acting user's juniors.
async function isUplineOfPendingApprover(msg, ownerId, currentUserId) {
  if (msg.approvalStatus !== "pending") return false;
  const juniorIds = await getAllJuniorsRecursively(
    String(ownerId),
    String(currentUserId)
  );
  if (juniorIds.length === 0) return false;

  const chain = new Set(
    (msg.approvalChain || []).map((e) => String(e.approver?._id || e.approver))
  );
  const pendingApprovers = (Array.isArray(msg.receiver) ? msg.receiver : [msg.receiver])
    .filter(Boolean)
    .map((r) => String(r._id || r))
    .filter((idStr) => !chain.has(idStr));

  return (
    juniorIds.includes(String(msg.sender?._id || msg.sender)) &&
    pendingApprovers.some((idStr) => juniorIds.includes(idStr))
  );
}

exports.approveMessage = async function approveMessage(req, res) {
  try {
    const { id } = req.params;
    let msg = await AssignmentMessage.findById(id)
      .populate([
        { path: "sender", select: "_id name companyEmail role designation" },
        { path: "receiver", select: "_id name companyEmail role designation" },
        { path: "client", select: "_id clientName legalBusinessName dba" },
      ]);
    if (!msg) return res.status(404).json({ error: "Message not found" });

    const userRole = normalizeRole(req.employee?.role || "");
    const currentUserId = String(req.employee?._id);
    const ownerId = msg.owner;

    // Check if current user is one of the receivers or a manager/owner
    const isReceiver = msg.receiver.some((r) => String(r._id || r) === currentUserId);
    const isManagerOrOwner = userRole === "manager" || userRole === "owner";

    if (!isManagerOrOwner && !isReceiver) {
      // Pre-approval: an upline senior can approve a message stuck pending at
      // a lower level of their chain (current approver absent/unavailable).
      const preApprovalAllowed = await isUplineOfPendingApprover(
        msg,
        ownerId,
        currentUserId
      );
      if (!preApprovalAllowed) {
        return res
          .status(403)
          .json({ error: "Only designated supervisors or managers can approve messages" });
      }
    }

    // Prevent double approval
    if (msg.approvalStatus === "approved") {
      return res.status(400).json({ error: "Message already approved" });
    }

    // Idempotency guard: if this approver already recorded an approval for this
    // message, a duplicate/retried request arrived (the UI can fire approve more
    // than once, plus polling). Return success without re-saving — this avoids
    // the Mongoose VersionError caused by concurrent saves on the same document.
    const alreadyApprovedByMe = (msg.approvalChain || []).some(
      (entry) => String(entry.approver?._id || entry.approver) === currentUserId
    );
    if (alreadyApprovedByMe) {
      return res.json({
        success: true,
        message: "Message already approved by you",
        data: msg,
        alreadyProcessed: true,
      });
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

    const allLinksAsJunior = await EmployeeHierarchy.find({
      owner: ownerId,
      junior: currentUserId,
    }).lean();

    // Find the immediate seniors (1 level up) of the current approver
    const immediateSeniors = await findSupervisorsFromHierarchy(
      ownerId,
      currentUserId
    );

    const targetSupervisor = immediateSeniors.length > 0 ? immediateSeniors[0] : null;
    const hasNextLevel = !!targetSupervisor;
    const nextSupervisors = targetSupervisor ? [targetSupervisor] : [];

    let approvalFinalized = false;
    let responseStatusMessage = "Message approved successfully";

    // Apply the approval to a (possibly reloaded) document. Mutates `doc` and
    // sets approvalFinalized/responseStatusMessage in the outer scope.
    const applyApproval = async (doc) => {
      approvalFinalized = false;
      responseStatusMessage = "Message approved successfully";

      // Record this approval step
      if (!doc.approvalChain) doc.approvalChain = [];
      doc.approvalChain.push({
        approver: req.employee._id,
        approvedAt: new Date(),
        hierarchyLevel: currentHierarchyLevel,
      });

      // The approver has reviewed this message — mark it as read so it doesn't
      // appear as an unread message in their email badge count after approving
      if (!doc.readBy) doc.readBy = [];
      const alreadyRead = doc.readBy.some(
        (r) => String(r.employee?._id || r.employee) === String(req.employee._id)
      );
      if (!alreadyRead) {
        doc.readBy.push({ employee: req.employee._id, readAt: new Date() });
      }

      if (targetSupervisor) {
        // Escalate to the next immediate senior in the hierarchy.
        // Keep the current approver in the receiver list so the message
        // remains visible in their email inbox after they approve.
        doc.approvalStatus = "pending";
        const previousApprovers = (doc.approvalChain || []).map(
          (entry) => String(entry.approver?._id || entry.approver)
        );
        doc.receiver = Array.from(
          new Set([targetSupervisor, ...previousApprovers])
        );

        // Reset read status for the next supervisor so it appears as new (bold) for them
        if (doc.readBy && doc.readBy.length > 0) {
          doc.readBy = doc.readBy.filter(
            (r) => String(r.employee?._id || r.employee) !== String(targetSupervisor)
          );
        }
        responseStatusMessage = "Message approved and escalated to next-level supervisor";
      } else {
        const { managers, crm } = await findTLsAndManagersByOwner(ownerId);
        const crmIds = Array.isArray(crm) ? crm : [];

        // RESTORE INTENDED RECIPIENTS
        const intendedRecipients = Array.isArray(doc.intendedRecipients)
          ? doc.intendedRecipients.map((r) => String(r._id || r))
          : [];

        const currentReceivers = Array.isArray(doc.receiver)
          ? doc.receiver.map((r) => String(r._id || r))
          : [];

        // Include all approvers from the chain so the message stays in their inbox
        const chainApprovers = (doc.approvalChain || []).map(
          (entry) => String(entry.approver?._id || entry.approver)
        );

        // CC'd internal employees have to become receivers, otherwise the
        // message never reaches them. syncCCWithReceivers() does this at
        // creation time but bails out for pending messages, so for a supervised
        // sender this is the ONLY point where the CC list gets delivered.
        let ccMatchingEmployees = [];
        if (doc.cc && doc.cc.length > 0) {
          const ccEmailAddresses = doc.cc.map((c) => c.email);
          ccMatchingEmployees = await findEmployeesByEmails(
            doc.owner,
            ccEmailAddresses
          );
        }
        const ccReceiverIds = ccMatchingEmployees.map((e) => String(e._id));

        const finalReceivers = Array.from(
          new Set([...currentReceivers, ...managers, ...crmIds, ...intendedRecipients, ...chainApprovers, ...ccReceiverIds])
        ).filter((rid) => rid !== String(doc.sender?._id || doc.sender));

        doc.receiver = finalReceivers;

        // Filter CCs on approval to ensure Managers/CRM are not in the CC header
        if (doc.cc && doc.cc.length > 0) {
          ccMatchingEmployees.forEach((employee) => {
            const role = (employee.role || "").toLowerCase();
            if (role.includes("manager") || role.includes("crm")) {
              const index = doc.cc.findIndex((c) => {
                const ccEmail = (c.email || "").toLowerCase();
                return (
                  ccEmail === (employee.email || "").toLowerCase() ||
                  ccEmail === (employee.companyEmail || "").toLowerCase()
                );
              });
              if (index > -1) {
                doc.cc.splice(index, 1);
              }
            }
          });
        }

        // Same deferral as CC above: resolveBccReceivers() bails out while a
        // message is pending, so for a supervised sender this is the only point
        // where blind recipients get resolved. They go to bccReceiver, NOT into
        // finalReceivers — putting them in the visible list would unblind them.
        if (doc.bcc && doc.bcc.length > 0) {
          const bccMatchingEmployees = await findEmployeesByEmails(
            doc.owner,
            doc.bcc.map((b) => b.email)
          );
          doc.bccReceiver = bccMatchingEmployees
            .map((e) => String(e._id))
            .filter((rid) => rid !== String(doc.sender?._id || doc.sender));
        }

        doc.approvalStatus = "approved";
        doc.approvedAt = new Date();
        doc.approvedBy = req.employee._id;

        doc.readBy = [{
          employee: req.employee._id,
          readAt: new Date()
        }];

        approvalFinalized = true;
      }
    };

    // Apply + save with a bounded retry to survive concurrent saves (duplicate
    // approve clicks / polling firing the same action). On a Mongoose version
    // conflict we reload the latest document, re-check idempotency, and re-apply.
    for (let attempt = 0; ; attempt++) {
      await applyApproval(msg);
      try {
        await msg.save();
        break;
      } catch (saveErr) {
        if (saveErr?.name === "VersionError" && attempt < 3) {
          const fresh = await AssignmentMessage.findById(id).populate([
            { path: "sender", select: "_id name companyEmail role designation" },
            { path: "receiver", select: "_id name companyEmail role designation" },
            { path: "client", select: "_id clientName legalBusinessName dba" },
          ]);
          if (!fresh) return res.status(404).json({ error: "Message not found" });
          if (fresh.approvalStatus === "approved") {
            return res.json({ success: true, message: "Message already approved", data: fresh, alreadyProcessed: true });
          }
          const mineNow = (fresh.approvalChain || []).some(
            (entry) => String(entry.approver?._id || entry.approver) === currentUserId
          );
          if (mineNow) {
            return res.json({ success: true, message: "Message already approved by you", data: fresh, alreadyProcessed: true });
          }
          msg = fresh;
          continue;
        }
        throw saveErr;
      }
    }

    let approvedClientEmployeeMessages = [];
    if (approvalFinalized && msg.threadId) {
      try {
        // Auto-approve pending client/client-employee messages in the thread.
        // Single updateMany instead of load-full-doc + save per message: those
        // docs carry base64 attachment data, so the old loop pulled megabytes
        // and wrote them back one by one — a major part of the approve delay.
        const pendingClientQuery = {
          threadId: msg.threadId,
          approvalStatus: "pending",
          $or: [
            { isFromClient: true },
            { isFromCompanyEmployee: true },
            { senderType: "client" }
          ],
          _id: { $ne: msg._id } // Exclude the current message being approved
        };
        const pendingIds = await AssignmentMessage.find(pendingClientQuery)
          .select("_id")
          .lean();

        if (pendingIds.length > 0) {
          await AssignmentMessage.updateMany(
            { _id: { $in: pendingIds.map((d) => d._id) } },
            {
              $set: {
                approvalStatus: "approved",
                approvedAt: new Date(),
                approvedBy: req.employee._id,
              },
            }
          );
          approvedClientEmployeeMessages = pendingIds.map((d) => d._id);
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
      { path: "client", select: "_id clientName legalBusinessName dba" },
      { path: "approvedBy", select: "_id name companyEmail role designation" },
      { path: "disapprovedBy", select: "_id name companyEmail role designation" },
      { path: "plannedApprovalChain", select: "_id name role designation" },
      {
        path: "approvalChain",
        populate: { path: "approver", select: "_id name role designation", model: "Employee" },
      },
    ]);

    // Full doc (with real attachments) goes to SMTP; sockets/response get the
    // slim copy so ten approvals don't broadcast megabytes of base64 each.
    const slimPopulated = slimEmailDoc(populated);

    // Final approval reached: deliver the reply to the client's real mailbox via
    // SMTP. Fire-and-forget — an SMTP failure must not fail the approval itself.
    // (The service only sends for threads that started from an inbound client email.)
    if (approvalFinalized) {
      sendApprovedReplyToClient(populated)
        .then((result) => {
          if (result?.sent) {
            console.log(`📤 [approveMessage] Approved reply emailed to client: ${result.to}`);
          }
        })
        .catch((err) =>
          console.error("❌ [approveMessage] Failed to email approved reply to client:", err.message)
        );
    }

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
        io.to(`assignment_client_${clientId}`).emit("new_assignment_message", slimPopulated);
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
          message: slimPopulated,
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
          message: slimPopulated,
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
        io.to(`employee_${userId}`).emit("new_assignment_message", slimPopulated);
      });

      // Notify assignment managers if completely finalized
      if (!hasNextLevel) {
        io.to("assignment_managers").emit("assignment_message_approved", {
          messageId: populated._id,
          approvalStatus: "approved",
          message: slimPopulated,
          action: "approved",
          isNewMessage: true,
          timestamp: new Date(),
        });
      }
    }

    return res.json({
      success: true,
      message: responseStatusMessage,
      data: slimPopulated,
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

    let msg = await AssignmentMessage.findById(id);
    if (!msg) return res.status(404).json({ error: "Message not found" });

    const userRole = normalizeRole(req.employee?.role || "");
    const currentUserId = String(req.employee?._id);

    const isReceiver = msg.receiver.some((r) => String(r._id || r) === currentUserId);
    const isManagerOrOwner = userRole === "manager" || userRole === "owner";

    if (!isManagerOrOwner && !isReceiver) {
      // Pre-approval: an upline senior can reject a message stuck pending at
      // a lower level of their chain (current approver absent/unavailable).
      const preApprovalAllowed = await isUplineOfPendingApprover(
        msg,
        msg.owner,
        currentUserId
      );
      if (!preApprovalAllowed) {
        return res
          .status(403)
          .json({ error: "Only designated supervisors or managers can disapprove messages" });
      }
    }

    // Idempotency guard: a duplicate/retried request (the UI can fire disapprove
    // more than once, plus polling). Return success without re-saving to avoid
    // the Mongoose VersionError from concurrent saves on the same document.
    if (msg.approvalStatus === "disapproved") {
      return res.json({
        success: true,
        message: "Message already disapproved",
        data: msg,
        alreadyProcessed: true,
      });
    }

    // Apply the disapproval to a (possibly reloaded) document.
    const applyDisapproval = (doc) => {
      // ✅ ONLY update the existing message - NO new message creation
      doc.approvalStatus = "disapproved";

      // Record WHO disapproved and WHEN so the Message Info / approval-hierarchy
      // view can show the disapproval step (in red) to everyone viewing the message.
      doc.disapprovedBy = req.employee._id;
      doc.disapprovedAt = new Date();

      // 🔥 NEW: Reset read status so participants see the disapproval as a new unread (bold) message
      doc.readBy = [{
        employee: req.employee._id,
        readAt: new Date()
      }];

      // Store disapproval note if provided
      if (disapprovalNote && disapprovalNote.trim() !== "") {
        doc.disapprovalNote = disapprovalNote.trim();
      } else {
        doc.disapprovalNote = "Message requires revisions before resubmission.";
      }

      // Route disapproved message to the previous approver in the chain (not directly to sender).
      // If the disapprover was themselves in the chain (further-reject), remove them first.
      const workingChain = Array.isArray(doc.approvalChain) ? [...doc.approvalChain] : [];
      let disapproverIdx = -1;
      for (let i = workingChain.length - 1; i >= 0; i--) {
        const aid = String(workingChain[i].approver?._id || workingChain[i].approver);
        if (aid === currentUserId) { disapproverIdx = i; break; }
      }
      if (disapproverIdx >= 0) {
        workingChain.splice(disapproverIdx, 1);
        doc.approvalChain = workingChain;
      }
      if (workingChain.length > 0) {
        const lastApprover = workingChain[workingChain.length - 1];
        doc.receiver = [String(lastApprover.approver?._id || lastApprover.approver)];
      } else {
        doc.receiver = [String(doc.sender?._id || doc.sender)];
      }

      doc.updatedAt = new Date();
    };

    // Apply + save with a bounded retry to survive concurrent saves.
    for (let attempt = 0; ; attempt++) {
      applyDisapproval(msg);
      try {
        await msg.save();
        break;
      } catch (saveErr) {
        if (saveErr?.name === "VersionError" && attempt < 3) {
          const fresh = await AssignmentMessage.findById(id);
          if (!fresh) return res.status(404).json({ error: "Message not found" });
          if (fresh.approvalStatus === "disapproved") {
            return res.json({ success: true, message: "Message already disapproved", data: fresh, alreadyProcessed: true });
          }
          msg = fresh;
          continue;
        }
        throw saveErr;
      }
    }

    // Populate the updated message for response — include approvalChain so
    // previous approvers are identifiable both here and in the frontend
    const populated = await AssignmentMessage.findById(msg._id).populate([
      { path: "owner", select: "_id name companyEmail" },
      { path: "sender", select: "_id name companyEmail role designation" },
      { path: "receiver", select: "_id name companyEmail role designation" },
      { path: "client", select: "_id clientName legalBusinessName dba" },
      {
        path: "approvalChain.approver",
        select: "_id name companyEmail role designation",
        model: "Employee",
      },
    ]);

    // Sockets/response get the slim copy (base64 attachment data replaced by
    // streaming-endpoint URLs) — same reason as approveMessage.
    const slimPopulated = slimEmailDoc(populated);

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
        message: slimPopulated,
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
        io.to(`employee_${participantId}`).emit("new_assignment_message", slimPopulated);
      });

      await emitMessageUpdate(io, msg, "disapproved");
    }

    res.json({
      success: true,
      message: "Message disapproved successfully",
      data: slimPopulated,
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
      { path: "client", select: "_id clientName legalBusinessName dba" },
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
// Slim a message for LIST responses (same as listAssignmentMessages):
// inbound emails store attachments as base64 `data:` URIs — never ship those
// in list pages. Detail views refetch the full thread.
function slimListMessage(m) {
  if (!m) return m;
  if (Array.isArray(m.attachments) && m.attachments.length > 0) {
    m.attachments = m.attachments.map((a) =>
      a && typeof a.url === "string" && a.url.startsWith("data:")
        ? { ...a, url: "", hasInlineData: true }
        : a
    );
  }
  if (m.emailMetadata && m.emailMetadata.headers) {
    delete m.emailMetadata.headers;
  }
  return m;
}

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
      status: "sent",
      sender: me
    };
    if (isObjId(owner)) q.owner = owner;

    // Apply visibility rules (including client-assigned visibility)
    const qFinal = await applyVisibility(q, req);

    const [items, total] = await Promise.all([
      AssignmentMessage.find(qFinal)
        .sort({ createdAt: 1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .select("-emailMetadata.headers")
        .populate([
          { path: "owner", select: "_id name companyEmail" },
          { path: "sender", select: "_id name companyEmail role designation" },
          { path: "receiver", select: "_id name companyEmail role designation" },
          { path: "client", select: "_id clientName legalBusinessName dba" },
          { path: "attachments.uploadedBy", select: "_id name companyEmail" },
          { path: "scheduledBy", select: "_id name companyEmail" },
        ])
        .lean(),
      AssignmentMessage.countDocuments(q),
    ]);

    return res.json({
      items: items.map(slimListMessage),
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
      bcc: bccBody,
      isFromClient,
      isFromCompanyEmployee,
      clientEmployeeName,
      clientEmployeeEmail,
      clientName,
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

    let ccEmails = await parseCCEmailsForOwner(ccBody, owner);
    receivers = await syncCCWithReceivers(receivers, ccEmails, owner, sender, null);

    // A draft is not delivered yet, so only the address list is kept here; the
    // blind recipients are resolved when the draft is actually sent.
    const bccEmails = await parseCCEmailsForOwner(bccBody, owner);

    // Note: Drafts can be saved without receivers.
    // The requirement for receivers should only be enforced when sending.

    const senderDoc = await Employee.findById(sender).select("_id role").lean();
    const senderRole = normalizeRole(senderDoc?.role || "");
    // Same reasoning as the send path: a CRM-access sender must keep the
    // company-employee context they explicitly chose, whatever their role.
    const senderCanActAsClient =
      senderRole === "manager" || (await hasCrmAccess(req.employee));

    // Resolve client employee tracking fields — only managers may set them
    let inheritedIsFromClient = false;
    let inheritedIsFromCompanyEmployee = false;
    let inheritedClientEmployeeName = null;
    let inheritedClientEmployeeEmail = null;
    let inheritedClientName = null;

    if (senderCanActAsClient) {
      if (isFromClient || isFromCompanyEmployee) {
        inheritedIsFromClient = isFromClient || false;
        inheritedIsFromCompanyEmployee = isFromCompanyEmployee || false;
        inheritedClientEmployeeName = clientEmployeeName || null;
        inheritedClientEmployeeEmail = clientEmployeeEmail || null;
        inheritedClientName = clientName || null;
      }
    }

    const draftData = {
      owner,
      sender,
      receiver: receivers,
      subject: subject || "Draft",
      note: note || "",
      status: "draft",
      isScheduled: false,
      cc: ccEmails,
      bcc: bccEmails,
      isFromClient: inheritedIsFromClient,
      isFromCompanyEmployee: inheritedIsFromCompanyEmployee,
      clientEmployeeName: inheritedClientEmployeeName,
      clientEmployeeEmail: inheritedClientEmployeeEmail,
      clientName: inheritedClientName,
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
        ? [{ path: "client", select: "_id clientName legalBusinessName dba" }]
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
      bcc: bccBody,
      client: clientBody,
      isFromClient,
      isFromCompanyEmployee,
      clientEmployeeName,
      clientEmployeeEmail,
      clientName,
    } = req.body;
    const msg = await AssignmentMessage.findById(req.params.id);

    if (!msg) return res.status(404).json({ error: "Message not found" });

    // Check if user has permission to update this message
    if (String(msg.sender) !== String(req.employee._id)) {
      return res.status(403).json({
        error: "You can only update your own messages",
      });
    }

    // Update basic fields if provided
    if (typeof subject === "string") msg.subject = subject;
    if (typeof note === "string") msg.note = note;

    // Keep draft client context in sync with the composer. An explicit null
    // means the user switched to an internal-only message, so stale client
    // context must be removed instead of surviving the autosave.
    if (Object.prototype.hasOwnProperty.call(req.body, "client")) {
      if (clientBody && isObjId(clientBody)) {
        msg.client = clientBody;
      } else if (
        clientBody === null ||
        clientBody === "" ||
        clientBody === "none"
      ) {
        msg.client = undefined;
      }
    }

    // Update client employee tracking fields for managers
    const senderDoc = await Employee.findById(msg.sender).select("_id role").lean();
    const senderRole = normalizeRole(senderDoc?.role || "");

    if (senderRole === "manager") {
      if (isFromClient !== undefined) msg.isFromClient = isFromClient || false;
      if (isFromCompanyEmployee !== undefined) msg.isFromCompanyEmployee = isFromCompanyEmployee || false;
      if (clientEmployeeName !== undefined) msg.clientEmployeeName = clientEmployeeName || null;
      if (clientEmployeeEmail !== undefined) msg.clientEmployeeEmail = clientEmployeeEmail || null;
      if (clientName !== undefined) msg.clientName = clientName || null;
    }

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
      const ccEmails = await parseCCEmailsForOwner(ccBody, msg.owner);
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

    if (bccBody !== undefined) {
      // Still a draft here, so only the address list is stored; blind
      // recipients are resolved by sendDraft when it actually goes out.
      msg.bcc = await parseCCEmailsForOwner(bccBody, msg.owner);
    }

    await msg.save();

    const populated = await msg.populate([
      { path: "owner", select: "_id name companyEmail" },
      { path: "sender", select: "_id name companyEmail role designation" },
      { path: "receiver", select: "_id name companyEmail role designation" },
      { path: "client", select: "_id clientName legalBusinessName dba" },
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
      bcc: bccBody,
      client: clientBody,
      isFromClient,
      isFromCompanyEmployee,
      clientEmployeeName,
      clientEmployeeEmail,
      clientName,
      sender: senderBody,
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

    // A CRM user may send this on behalf of an isAdmin employee, chosen in the
    // composer's From field. Drafts are always saved under their real author
    // (so ownership above and the drafts listing stay correct) — the override
    // is applied here, at send time, before senderDoc/routing/receivers are
    // derived below so every one of them follows the chosen identity, exactly
    // as createMessage does for a message sent without a draft.
    if (
      senderBody &&
      isObjId(senderBody) &&
      String(senderBody) !== String(msg.sender)
    ) {
      const canSendAs =
        (await hasCrmAccess(req.employee)) &&
        (await Employee.exists({
          _id: senderBody,
          owner: msg.owner,
          isAdmin: true,
        }));
      if (!canSendAs) {
        return res
          .status(403)
          .json({ error: "Not allowed to send as that employee" });
      }
      msg.sender = senderBody;
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

    // An explicit null clears client context left on an autosaved draft when
    // the recipients were changed to colleagues before sending.
    if (Object.prototype.hasOwnProperty.call(req.body, "client")) {
      if (clientBody && isObjId(clientBody)) {
        msg.client = clientBody;
      } else if (
        clientBody === null ||
        clientBody === "" ||
        clientBody === "none"
      ) {
        msg.client = undefined;
      }
    }

    // Update client employee tracking fields for managers
    const senderDoc = await Employee.findById(msg.sender).select("_id role isAdmin").lean();
    const senderRole = normalizeRole(senderDoc?.role || "");

    if (senderRole === "manager") {
      if (isFromClient !== undefined) msg.isFromClient = isFromClient || false;
      if (isFromCompanyEmployee !== undefined) msg.isFromCompanyEmployee = isFromCompanyEmployee || false;
      if (clientEmployeeName !== undefined) msg.clientEmployeeName = clientEmployeeName || null;
      if (clientEmployeeEmail !== undefined) msg.clientEmployeeEmail = clientEmployeeEmail || null;
      if (clientName !== undefined) msg.clientName = clientName || null;
    }

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

    // 🔥 SENIOR → CRM ROUTING (mirror of createMessage): if the sender is NOT
    // the assigned employee for this client, the message must go to the CRM
    // (manager), NOT the assigned junior/sub-junior. Strip any assigned junior
    // that may have been saved on the draft and add the CRM instead.
    try {
      const clientId = msg.client;
      if (clientId && isObjId(String(clientId))) {
        const clientDoc = await ClientInfo.findById(clientId)
          .select("assignedTo")
          .lean();
        const assignedToIds = (
          Array.isArray(clientDoc?.assignedTo)
            ? clientDoc.assignedTo
            : [clientDoc?.assignedTo]
        )
          .filter(Boolean)
          .map((e) => String(e._id || e));
        const isSenderAssigned = assignedToIds.includes(String(msg.sender));
        const { managers: ownerManagerIds } = await findTLsAndManagersByOwner(
          msg.owner,
        );
        const otherManagerIds = ownerManagerIds.filter(
          (mid) => mid !== String(msg.sender),
        );
        const senderHasCrmAccess = ownerManagerIds.includes(String(msg.sender));
        const senderIsTopCrm =
          (senderRole === "manager" || senderHasCrmAccess) &&
          otherManagerIds.length === 0;

        if (!isSenderAssigned && !senderIsTopCrm && !senderHasCrmAccess && otherManagerIds.length > 0) {
          // Remove the assigned junior(s) and add the CRM (manager).
          receivers = receivers.filter((id) => !assignedToIds.includes(id));
          otherManagerIds.forEach((mid) => {
            if (!receivers.includes(mid) && mid !== String(msg.sender)) {
              receivers.push(mid);
            }
          });
        }

        // 👑 ADMIN CRM BROADCAST (mirror of createMessage): an isAdmin sender
        // with CRM access sending a client message → deliver to ALL CRM users.
        if (senderHasCrmAccess && senderDoc?.isAdmin === true) {
          otherManagerIds.forEach((mid) => {
            if (!receivers.includes(mid) && mid !== String(msg.sender)) {
              receivers.push(mid);
            }
          });
        }
      }
    } catch (e) {
      console.error("sendDraft CRM routing error:", e);
    }

    if (receivers.length > 0) {
      msg.receiver = receivers;
    }

    // Process CC and sync with receivers if CC is provided during send
    if (ccBody) {
      const ccEmails = await parseCCEmailsForOwner(ccBody, msg.owner);
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

      // Client/company-originated mail is also outside the approval workflow,
      // so use null just like createMessage does.
      if (msg.isFromClient || msg.isFromCompanyEmployee) {
        msg.approvalStatus = null;
      } else if (msg.client) {
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
          if (hierarchyResult.autoApprove) {
            // Sender is top of hierarchy — no approval needed, keep intended recipients
            msg.approvalStatus = "approved";
            targetSupervisor = null;
          } else {
            msg.receiver = hierarchyResult.receivers;
            msg.approvalStatus = hierarchyResult.approvalStatus;
            targetSupervisor = hierarchyResult.targetSupervisor;

            // If it’s pending, store the original intended receivers
            if (msg.approvalStatus === "pending") {
              msg.intendedRecipients = receivers;
            }
          }
        } else {
          msg.approvalStatus = "approved";
        }
      } else {
        msg.approvalStatus = null;
      }
    }

    // Resolve blind recipients last: approvalStatus is decided above, and a
    // message still awaiting approval must not be delivered to anyone yet.
    if (bccBody !== undefined) {
      msg.bcc = await parseCCEmailsForOwner(bccBody, msg.owner);
    }
    if (msg.bcc && msg.bcc.length > 0) {
      msg.bccReceiver = await resolveBccReceivers(
        msg.bcc,
        msg.owner,
        msg.sender,
        msg.approvalStatus
      );
    }

    await msg.save();

    const populated = await msg.populate([
      { path: "owner", select: "_id name companyEmail" },
      { path: "sender", select: "_id name companyEmail role designation" },
      { path: "receiver", select: "_id name companyEmail role designation" },
      { path: "client", select: "_id clientName legalBusinessName dba" },
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

          // PRE-APPROVAL realtime: seniors above the current approver see this
          // pending message in their Pre-approval tab — notify them live.
          try {
            const chainSeniors = await getManagementChainFromHierarchy(
              msg.owner,
              msg.sender
            );
            const currentApprover = targetSupervisor
              ? String(targetSupervisor)
              : null;
            (chainSeniors || [])
              .map(String)
              .filter((sid) => sid !== currentApprover && sid !== String(msg.sender))
              .forEach((seniorId) => {
                io.to(`employee_${seniorId}`).emit("supervision_updated", {
                  threadId: msg.threadId,
                  clientId: msg.client?._id || msg.client,
                  updatedAt: new Date(),
                });
              });
          } catch (notifyErr) {
            console.error("pre-approval realtime notify error:", notifyErr);
          }
        }
      }
    } else {
      const io = getIO(req);
      if (io) {
        // Sender-only: update their Scheduled list in realtime. Receivers must
        // not learn about the message before it actually sends.
        io.to(
          `employee_${String(populated.sender?._id || populated.sender)}`
        ).emit("message_scheduled", {
          message: populated,
          timestamp: new Date(),
        });
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

    // Allow any senior who previously approved the message to also edit & resubmit
    const isInApprovalChain =
      Array.isArray(msg.approvalChain) &&
      msg.approvalChain.some((step) => {
        const raw = step.approver;
        const aid = raw?._id ? String(raw._id) : raw ? String(raw) : null;
        return aid === String(currentUserId);
      });

    // Permission is hierarchy-based (not role-based): the sender, anyone who
    // already approved this message, OR any senior of the sender in the
    // EmployeeHierarchy chain can edit & resubmit a disapproved message.
    let isSeniorOfSender = false;
    if (!isSender && !isInApprovalChain) {
      const seniorChain = await getManagementChainFromHierarchy(
        msg.owner,
        msg.sender
      );
      isSeniorOfSender = seniorChain.some(
        (id) => String(id) === String(currentUserId)
      );
    }

    if (!isSender && !isInApprovalChain && !isSeniorOfSender) {
      return res.status(403).json({
        error: "You don't have permission to edit this message",
        messageOwner: messageSenderId,
        currentUser: currentUserId,
        allowedRoles: ["sender", "senior_in_hierarchy", "previous_approver"],
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
        if (hierarchyResult.autoApprove) {
          // Resubmitter is top of hierarchy — no approval needed, deliver to intended recipients
          updateData.approvalStatus = "approved";
          if (Array.isArray(msg.intendedRecipients) && msg.intendedRecipients.length > 0) {
            updateData.receiver = msg.intendedRecipients;
          }
        } else {
          updateData.receiver = hierarchyResult.receivers;
          updateData.approvalStatus = hierarchyResult.approvalStatus;
        }
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
        { path: "client", select: "_id clientName legalBusinessName dba" },
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
      { path: "client", select: "_id clientName legalBusinessName dba" },
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
      { path: "client", select: "_id clientName legalBusinessName dba" },
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

    const threadQuery = isIdValidObject
      ? { $or: [{ threadId: threadId }, { client: threadId }, { _id: threadId }] }
      : { threadId: threadId };

    const threadMessages = await AssignmentMessage.find(threadQuery);

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

    const threadQuery = isIdValidObject
      ? { $or: [{ threadId: threadId }, { client: threadId }, { _id: threadId }] }
      : { threadId: threadId };

    const trashedMessages = await AssignmentMessage.find({
      ...threadQuery,
      $or: [{ isTrashed: true }, { isSpam: true }],
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

    const threadQuery = isIdValidObject
      ? { $or: [{ threadId: threadId }, { client: threadId }, { _id: threadId }] }
      : { threadId: threadId };

    // PER USER: find thread messages this user hasn't already binned.
    const threadMessages = await AssignmentMessage.find({
      ...threadQuery,
      trashedBy: { $ne: currentUser },
    });

    if (threadMessages.length === 0) {
      return res
        .status(404)
        .json({ error: "No active thread found with this thread ID" });
    }

    // Move all messages to THIS user's Bin only (other employees still see them).
    await AssignmentMessage.updateMany(
      {
        _id: { $in: threadMessages.map((msg) => msg._id) },
      },
      {
        $addToSet: { trashedBy: currentUser },
        $set: { isTrashed: true, trashedAt: new Date() },
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

    // Mirror moveThreadToTrash's lookup exactly (match by threadId, client, or
    // the thread-root message _id). Restoring must be able to find anything that
    // could be trashed — the frontend passes the thread-root message _id here,
    // so omitting the _id branch (and over-constraining by sender/receiver)
    // caused every restore to 404.
    const threadQuery = isIdValidObject
      ? { $or: [{ threadId: threadId }, { client: threadId }, { _id: threadId }] }
      : { threadId: threadId };

    // PER USER: find messages THIS user has in their Bin for this thread.
    const trashedMessages = await AssignmentMessage.find({
      ...threadQuery,
      trashedBy: currentUser,
    });

    if (trashedMessages.length === 0) {
      return res
        .status(404)
        .json({ error: "No trashed thread found with this thread ID" });
    }

    // Restore from THIS user's Bin only; isTrashed stays true while any other
    // user still has it binned.
    await AssignmentMessage.updateMany(
      {
        _id: { $in: trashedMessages.map((msg) => msg._id) },
      },
      [
        {
          $set: {
            trashedBy: {
              $filter: {
                input: { $ifNull: ["$trashedBy", []] },
                cond: { $ne: ["$$this", currentUser] },
              },
            },
          },
        },
        {
          $set: {
            isTrashed: { $gt: [{ $size: "$trashedBy" }, 0] },
          },
        },
      ]
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
// ⛔ SPAM FEATURE DISABLED — neutralized no-op.
// The spam feature was removed from the product. This endpoint no longer flags
// anything; it returns success so any lingering caller doesn't error.
exports.reportSpam = async function reportSpam(req, res) {
  return res.json({
    success: true,
    message: "Spam feature is disabled",
    disabled: true,
  });
};

// ⛔ SPAM FEATURE DISABLED — neutralized no-op.
exports.removeFromSpam = async function removeFromSpam(req, res) {
  return res.json({
    success: true,
    message: "Spam feature is disabled",
    disabled: true,
  });
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

    // Check permissions: either the sender OR ANY senior of the sender in the
    // hierarchy chain can edit a pending message. Role (team lead / manager) is
    // no longer used — seniority is determined purely by the EmployeeHierarchy
    // chain, so every senior can edit their junior's pending messages.
    const isSender = String(msg.sender) === currentUserId;

    let isSeniorOfSender = false;
    if (!isSender) {
      const seniorChain = await getManagementChainFromHierarchy(
        msg.owner,
        msg.sender
      );
      isSeniorOfSender = seniorChain.some((id) => String(id) === currentUserId);
    }

    if (!isSender && !isSeniorOfSender) {
      return res.status(403).json({
        error:
          "You don't have permission to edit this pending message. Only the sender or a senior in their hierarchy can edit it.",
        messageOwner: msg.sender,
        currentUser: currentUserId,
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
        { path: "client", select: "_id clientName legalBusinessName dba" },
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
          editedByTeamLead: isSeniorOfSender,
        };

        authorizedParticipants.forEach((participantId) => {
          io.to(`employee_${participantId}`).emit(
            "assignment_message_updated",
            notificationData
          );
        });

        if (isSeniorOfSender) {
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
        isSeniorOfSender
          ? "Pending message updated by senior"
          : "Pending message updated successfully",
      data: populated,
      editedByTeamLead: isSeniorOfSender,
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

// GET /:id/read-by — read receipts for an email/message (for the "Read by"
// dialog). Owner-scoped, excludes the sender. Returns BOTH:
//   • readers    — employees who actually opened it (kept for the existing
//                  EmailDetail dialog; each has `seenAt`).
//   • recipients — the full "delivered" set (direct receivers + planned and
//                  actual approvers), each flagged read/pending, so the dialog
//                  can show who it was delivered to and how many have read it.
exports.getReadBy = async function getReadBy(req, res) {
  try {
    const { id } = req.params;
    if (!isObjId(id)) return res.status(400).json({ error: "Invalid message id" });

    const ownerId = req.employee?.owner;
    const empSelect = "_id name companyEmail role designation photographUrl";
    const msg = await AssignmentMessage.findOne({ _id: id, owner: ownerId })
      .select("readBy sender receiver plannedApprovalChain approvalChain")
      .populate({ path: "readBy.employee", select: empSelect })
      .populate({ path: "receiver", select: empSelect })
      .populate({ path: "plannedApprovalChain", select: empSelect })
      .populate({ path: "approvalChain.approver", select: empSelect })
      .lean();

    if (!msg) return res.status(404).json({ error: "Message not found" });

    const senderId = String(msg.sender || "");

    // employeeId → earliest readAt (only for employees who actually read).
    const readAtMap = new Map();
    for (const r of msg.readBy || []) {
      if (!r.employee || !r.employee._id) continue;
      const eid = String(r.employee._id);
      if (eid === senderId) continue; // exclude the sender
      const seenAt = r.readAt || null;
      const existing = readAtMap.get(eid);
      if (
        existing === undefined ||
        (seenAt && (!existing || new Date(seenAt) < new Date(existing)))
      ) {
        readAtMap.set(eid, seenAt);
      }
    }

    // Delivered set = direct receivers + planned approvers + actual approvers
    // (+ anyone who read), minus the sender. De-duplicated per employee.
    const deliveredMap = new Map();
    const addEmp = (emp) => {
      if (!emp || !emp._id) return;
      const eid = String(emp._id);
      if (eid === senderId) return;
      if (!deliveredMap.has(eid)) deliveredMap.set(eid, emp);
    };
    (Array.isArray(msg.receiver) ? msg.receiver : []).forEach(addEmp);
    (Array.isArray(msg.plannedApprovalChain) ? msg.plannedApprovalChain : []).forEach(addEmp);
    (Array.isArray(msg.approvalChain) ? msg.approvalChain : []).forEach((ac) =>
      addEmp(ac && ac.approver),
    );
    (msg.readBy || []).forEach((r) => addEmp(r.employee));

    const recipients = Array.from(deliveredMap.values()).map((emp) => {
      const eid = String(emp._id);
      const read = readAtMap.has(eid);
      return {
        _id: emp._id,
        name: emp.name,
        companyEmail: emp.companyEmail,
        role: emp.role,
        designation: emp.designation,
        photographUrl: emp.photographUrl || null,
        read,
        seenAt: read ? readAtMap.get(eid) : null,
      };
    });

    // Read employees first (earliest read on top), then pending ones by name.
    recipients.sort((a, b) => {
      if (a.read && b.read)
        return new Date(a.seenAt || 0).getTime() - new Date(b.seenAt || 0).getTime();
      if (a.read !== b.read) return a.read ? -1 : 1;
      return String(a.name || "").localeCompare(String(b.name || ""));
    });

    // Back-compat: `readers` is just the read subset (with `seenAt`).
    const readers = recipients
      .filter((r) => r.read)
      .map(({ read, ...rest }) => rest);

    return res.json({
      count: readers.length,
      readCount: readers.length,
      deliveredCount: recipients.length,
      readers,
      recipients,
    });
  } catch (e) {
    console.error("Error fetching read-by:", e);
    return res.status(500).json({ error: "Failed to fetch read receipts" });
  }
};

// GET /:id/approval-info — lightweight payload for the "Message Info" approval
// stepper. Deliberately avoids the heavy fully-populated getMessage (no
// attachments/labels/permission-chain walk) so the dialog opens fast.
exports.getApprovalInfo = async function getApprovalInfo(req, res) {
  try {
    const { id } = req.params;
    if (!isObjId(id)) return res.status(400).json({ error: "Invalid message id" });

    const ownerId = req.employee?.owner;
    const empSelect = "_id name role designation";
    const msg = await AssignmentMessage.findOne({ _id: id, owner: ownerId })
      .select(
        "approvalStatus sender receiver plannedApprovalChain approvalChain " +
          "approvedBy approvedAt disapprovedBy disapprovedAt disapprovalNote " +
          "createdAt clientName client isFromClient",
      )
      .populate({ path: "sender", select: empSelect })
      .populate({ path: "receiver", select: empSelect })
      .populate({ path: "plannedApprovalChain", select: empSelect })
      .populate({ path: "approvalChain.approver", select: empSelect })
      .populate({ path: "approvedBy", select: empSelect })
      .populate({ path: "disapprovedBy", select: empSelect })
      .populate({ path: "client", select: "_id clientName" })
      .lean();

    if (!msg) return res.status(404).json({ error: "Message not found" });
    return res.json(msg);
  } catch (e) {
    console.error("Error fetching approval-info:", e);
    return res.status(500).json({ error: "Failed to fetch approval info" });
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

    // Check if user is authorized to read this message. Same-org viewers
    // (hierarchy seniors reading juniors' activity in All Activity) must also
    // be able to record their read — otherwise the sidebar unread badge,
    // which is based on readBy, can never clear for them.
    const sameOrg =
      String(message.owner) ===
      String(req.employee.owner || req.employee._id);
    const isAuthorized =
      sameOrg ||
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
    const alreadyRead = (message.readBy || []).some(
      (read) => readByEmployeeId(read) === userId.toString()
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

// POST /api/assignment-messages/read-all
// Marks EVERY unread message for the current user as read in one query —
// covers all folders and all pages so sidebar unread counts reach zero.
exports.markAllMessagesRead = async function markAllMessagesRead(req, res) {
  try {
    const userId = req.employee._id;

    const result = await AssignmentMessage.updateMany(
      {
        // Org-wide, not receiver-only: hierarchy seniors also see juniors'
        // threads (All Activity) and "mark all read" must clear those badges.
        owner: req.employee.owner || userId,
        "readBy.employee": { $ne: userId },
        status: "sent",
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

    // Let the user's other open tabs/devices refresh their counts
    const io = getIO(req);
    if (io) {
      io.to(`employee_${String(userId)}`).emit("all_messages_read", {
        markedBy: String(userId),
        markedCount: result.modifiedCount || 0,
        timestamp: new Date(),
      });
    }

    res.json({
      success: true,
      markedCount: result.modifiedCount || 0,
    });
  } catch (error) {
    console.error("Error marking all messages as read:", error);
    res.status(500).json({
      success: false,
      error: "Server error while marking all messages as read",
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

    // 🔥 CRITICAL FIX: Get ALL messages in the thread (not just unread ones).
    // Scoped by owner, NOT by participant: hierarchy seniors open juniors'
    // threads from All Activity without being sender/receiver, and their read
    // must still be recorded or the readBy-based unread badge never clears.
    const threadMessages = await AssignmentMessage.find({
      threadId: threadId,
      owner: req.employee.owner || req.employee._id,
      // $ne matches older documents where these fields were never set
      isTrashed: { $ne: true },
      isSpam: { $ne: true },
    });

    if (threadMessages.length === 0) {
      // Nothing for this user to mark (e.g. a hierarchy-visible thread where
      // they are not a direct participant) — succeed quietly instead of 404
      // so bulk "mark all as read" doesn't fail.
      return res.json({
        success: true,
        message: "No messages to mark as read in this thread",
        threadId: threadId,
        markedCount: 0,
      });
    }

    // 🔥 FIX: Mark ALL messages in thread as read (not just unread ones)
    const updatePromises = threadMessages.map((msg) => {
      // Check if user already marked this message as read
      const alreadyRead = (msg.readBy || []).some(
        (read) => readByEmployeeId(read) === userId.toString()
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

    // Check if user is authorized. Participants can always toggle unread.
    // Seniors/managers may also see messages through the same visibility rules
    // used by the email list, so allow unread for those visible messages too.
    let isAuthorized =
      message.sender.toString() === userId.toString() ||
      message.receiver.some(
        (receiver) => receiver.toString() === userId.toString()
      );

    if (!isAuthorized) {
      const visibleQuery = await applyVisibility({ _id: message._id }, req);
      const visibleMessage = await AssignmentMessage.exists(visibleQuery);
      isAuthorized = !!visibleMessage;
    }

    if (!isAuthorized) {
      return res.status(403).json({
        success: false,
        error: "Not authorized to access this message",
      });
    }

    // Remove user from readBy array
    message.readBy = (message.readBy || []).filter(
      (read) => readByEmployeeId(read) !== userId.toString()
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
