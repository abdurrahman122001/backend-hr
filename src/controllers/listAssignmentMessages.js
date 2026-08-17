const AssignmentMessage = require("../models/AssignmentMessage");
const Employee = require("../models/Employees");
const path = require("path");
const mongoose = require("mongoose");
const ClientInfo = require("../models/ClientInfo");
const EmployeeHierarchy = require("../models/EmployeeHierarchy");
const { hasCrmAccess } = require("../utils/crmAccess");

async function findSupervisorsFromHierarchy(ownerId, employeeId) {
  if (!isObjId(ownerId) || !isObjId(employeeId)) return [];

  try {
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

async function getAllJuniorsRecursively(ownerId, seniorId) {
  if (!isObjId(ownerId) || !isObjId(seniorId)) return [];

  try {
    const allJuniors = [];
    const visited = new Set();

    async function collectJuniors(currentSeniorId) {
      const currentIdStr = String(currentSeniorId);
      if (visited.has(currentIdStr)) return;
      visited.add(currentIdStr);

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

async function getManagementChainFromHierarchy(ownerId, employeeId) {
  // Same unwrap as assignmentMessageController: a populated Employee doc
  // String()s to its inspect dump and breaks the `junior` cast.
  const startId = employeeId?._id ?? employeeId;
  if (!isObjId(ownerId) || !isObjId(startId)) return [];

  try {
    const chain = [];
    let currentEmployee = startId;
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

const escapeSearchRegex = (value = "") =>
  String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const parseSearchSize = (value) => {
  const match = String(value || "")
    .trim()
    .match(/^(\d+(?:\.\d+)?)([kmg])?b?$/i);
  if (!match) return null;
  const multiplier =
    { k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[
      String(match[2] || "").toLowerCase()
    ] || 1;
  return Math.round(Number(match[1]) * multiplier);
};

const parseGmailStyleSearch = (rawQuery = "") => {
  let remaining = String(rawQuery || "").trim();
  const parsed = {
    from: [],
    to: [],
    subject: "",
    filename: "",
    excluded: [],
    scope: "",
    hasAttachments: null,
    unread: null,
    largerThan: null,
    smallerThan: null,
    dateFrom: null,
    dateTo: null,
  };

  const takeOperators = (name) => {
    const values = [];
    const pattern = new RegExp(
      `(?:^|\\s)${name}:(?:\"([^\"]*)\"|\\(([^)]*)\\)|(\\S+))`,
      "gi",
    );
    remaining = remaining.replace(pattern, (_match, quoted, grouped, plain) => {
      const value = String(quoted ?? grouped ?? plain ?? "").trim();
      if (value) values.push(value);
      return " ";
    });
    return values;
  };

  parsed.from = takeOperators("from");
  parsed.to = takeOperators("to");
  parsed.subject = takeOperators("subject").join(" ").trim();
  parsed.filename = [
    ...takeOperators("filename"),
    ...takeOperators("attachment"),
  ]
    .join(" ")
    .trim();
  parsed.scope = (takeOperators("in").pop() || "").toLowerCase();

  const larger = takeOperators("larger").pop();
  const smaller = takeOperators("smaller").pop();
  const exactSize = takeOperators("size").pop();
  parsed.largerThan = parseSearchSize(larger || exactSize);
  parsed.smallerThan = parseSearchSize(smaller);

  const after = takeOperators("after").pop();
  const before = takeOperators("before").pop();
  const newerThan = takeOperators("newer_than").pop();
  if (after) {
    const date = new Date(after.replace(/\//g, "-"));
    if (!Number.isNaN(date.getTime())) parsed.dateFrom = date;
  }
  if (before) {
    const date = new Date(before.replace(/\//g, "-"));
    if (!Number.isNaN(date.getTime())) parsed.dateTo = date;
  }
  if (!parsed.dateFrom && newerThan) {
    const match = newerThan.match(/^(\d+)([dmy])$/i);
    if (match) {
      const date = new Date();
      const amount = Number(match[1]);
      const unit = match[2].toLowerCase();
      if (unit === "d") date.setDate(date.getDate() - amount);
      if (unit === "m") date.setMonth(date.getMonth() - amount);
      if (unit === "y") date.setFullYear(date.getFullYear() - amount);
      parsed.dateFrom = date;
    }
  }

  if (/(?:^|\s)has:attachment(?:\s|$)/i.test(remaining)) {
    parsed.hasAttachments = true;
    remaining = remaining.replace(/(?:^|\s)has:attachment(?=\s|$)/gi, " ");
  }
  if (/(?:^|\s)is:unread(?:\s|$)/i.test(remaining)) {
    parsed.unread = true;
    remaining = remaining.replace(/(?:^|\s)is:unread(?=\s|$)/gi, " ");
  } else if (/(?:^|\s)is:read(?:\s|$)/i.test(remaining)) {
    parsed.unread = false;
    remaining = remaining.replace(/(?:^|\s)is:read(?=\s|$)/gi, " ");
  }
  remaining = remaining.replace(/(?:^|\s)-label:chats(?=\s|$)/gi, " ");

  remaining = remaining.replace(
    /(?:^|\s)-(?:"([^"]+)"|\(([^)]+)\)|(\S+))/g,
    (_match, quoted, grouped, plain) => {
      const value = String(quoted ?? grouped ?? plain ?? "").trim();
      if (value) parsed.excluded.push(value);
      return " ";
    },
  );

  parsed.text = remaining
    .replace(/"([^"]+)"/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return parsed;
};

// ── In-process hierarchy cache (5-minute TTL per employee) ──────────────────
// Hierarchy traversals hit the DB up to 10× per request. Caching per employee
// for 5 min eliminates nearly all of that overhead on repeated list fetches.
const _hc = new Map(); // key → { data, exp }
const HC_TTL = 5 * 60 * 1000;

function _hcKey(type, ownerId, empId) {
  return `${type}|${String(ownerId)}|${String(empId)}`;
}

async function getCachedJuniors(ownerId, empId) {
  const k = _hcKey("j", ownerId, empId);
  const e = _hc.get(k);
  if (e && Date.now() < e.exp) return e.data;
  const data = await getAllJuniorsRecursively(String(ownerId), String(empId));
  _hc.set(k, { data, exp: Date.now() + HC_TTL });
  return data;
}

async function getCachedChain(ownerId, empId) {
  const k = _hcKey("c", ownerId, empId);
  const e = _hc.get(k);
  if (e && Date.now() < e.exp) return e.data;
  const data = await getManagementChainFromHierarchy(String(ownerId), String(empId));
  _hc.set(k, { data, exp: Date.now() + HC_TTL });
  return data;
}
// ────────────────────────────────────────────────────────────────────────────

/** ---------- SOCKET.IO UTILITIES ---------- **/
function getIO(req) {
  return req.app.get("io");
}
const oid = (v) =>
  mongoose.isValidObjectId(v) ? new mongoose.Types.ObjectId(v) : null;

// Slim a message for LIST responses: inbound emails store whole attachment
// files as base64 `data:` URIs — shipping those in every list page makes the
// payload megabytes and is the main reason "Loading emails" took so long.
// The list UI only renders attachment names/counts; the detail view refetches
// the full thread, so nothing user-facing is lost. Uploaded-file attachments
// (short path URLs) are kept untouched.
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

// Employees whose mail inside a CLIENT thread the thread view renders as the
// client itself — getSmartDisplayName in EmailDetail hands the client's name
// and avatar to any CRM or manager sender there, whatever the message flags
// say. Both the Activity visibility rule and the Unread/Unresponded anchor
// below have to use this same set, or the list contradicts the thread on
// screen. Resolved from the sender's own record on purpose: `role` is not
// denormalised onto messages (every document stores null), so this is the same
// place the UI reads it from.
async function getClientVoiceSenderIds(ownerId) {
  if (!ownerId) return [];
  const ids = await Employee.find({
    owner: ownerId,
    $or: [{ role: /^\s*manager\s*$/i }, { role: /crm/i }],
  }).distinct("_id");
  return ids.map(String);
}

/**
 * "<clientId>|<employeeId>" for every client-voice sender who is ALSO on that
 * client's own team (assignedTo or supervisedBy).
 *
 * Those people are answering the client, never speaking for them, so the
 * client-voice rule below must skip them for that client — see IS_FROM_CLIENT.
 *
 * A flat pair list rather than a per-client map, so the aggregation can test it
 * with a plain `$in` on a concatenated key instead of `$getField` (which would
 * impose a MongoDB 5.0 floor). It stays small: only client-voice senders are
 * ever in it.
 */
async function getClientTeamPairs(ownerId, clientVoiceSenderIds) {
  if (!ownerId || !clientVoiceSenderIds?.length) return [];

  const voiceSet = new Set(clientVoiceSenderIds.map(String));
  const voiceObjIds = clientVoiceSenderIds.filter(isObjId).map((id) => oid(id));
  if (!voiceObjIds.length) return [];

  const clients = await ClientInfo.find({
    owner: ownerId,
    $or: [
      { assignedTo: { $in: voiceObjIds } },
      { supervisedBy: { $in: voiceObjIds } },
    ],
  })
    .select("_id assignedTo supervisedBy")
    .lean();

  const pairs = new Set();
  for (const c of clients) {
    for (const id of [...(c.assignedTo || []), ...(c.supervisedBy || [])]) {
      const s = String(id);
      if (voiceSet.has(s)) pairs.add(`${c._id}|${s}`);
    }
  }
  return Array.from(pairs);
}

async function applyVisibility(q, req, filterParam) {
  if (!req.employee?._id) return { _id: null };

  const me = oid(String(req.employee._id));
  if (!me) return { _id: null };

  const currentUserRole = normalizeRole(req.employee?.role || "");
  const ownerId = req.employee?.owner ? oid(req.employee.owner) : null;
  const isCrmUser = await hasCrmAccess(req.employee);

  // 🛡️ CORE PRIVACY RULE: Pending messages are ONLY visible to participants (Sender & Receiver)
  const isParticipant = {
    $or: [
      { sender: me },
      { receiver: me },
      { receiver: { $in: [me] } },
      // Blind recipients participate too — see receiverMe in the list query.
      { bccReceiver: me },
    ],
  };

  // Get clients I'm assigned to OR supervising for shared visibility
  const assignedClients = await ClientInfo.find({
    owner: ownerId,
    $or: [{ assignedTo: me }, { supervisedBy: me }],
  }).select("_id").lean();
  const assignedClientIds = assignedClients.map(c => oid(c._id));

  // Hierarchy lookup for junior-based visibility — all levels, not just direct
  const allJuniorIdStrings = await getCachedJuniors(ownerId, me);
  const juniorIds = allJuniorIdStrings.filter(isObjId).map((id) => oid(id));

  // PRE-APPROVAL: a pending message stuck at a LOWER level of my chain (both
  // its sender and its current approver are my juniors) is visible to me, so
  // an upline senior can open and approve it when the approver is absent.
  if (juniorIds.length > 0) {
    isParticipant.$or.push({
      approvalStatus: "pending",
      sender: { $in: juniorIds },
      receiver: { $in: juniorIds },
    });
  }

  // Activity filter: show ALL messages (any status) from every junior in the
  // hierarchy — but EXTERNAL (client) mail only, never internal/team messages.
  // Includes inbound client mail delivered to juniors (sender is a ClientInfo
  // id, so it never matches the junior-sender rule) — otherwise a client email
  // the assigned employee hasn't responded to is invisible to their seniors.
  if (filterParam === "review") {
    const isOwner = currentUserRole === "owner";
    const isCrmActivityScope =
      String(req.query.scope || "") === "crm" && isCrmUser;
    const externalOnly = { client: { $exists: true, $ne: null } };
    // CRM-scoped requests are organization-wide for CRM-access holders. The
    // same employee remains hierarchy-limited in Employee Dashboard/Connect,
    // where scope=crm is intentionally absent.
    if (isOwner || isCrmActivityScope) {
      return { $and: [q, { owner: ownerId }, externalOnly] };
    }
    if (juniorIds.length === 0) return { _id: null };
    const clientVoiceIds = (await getClientVoiceSenderIds(ownerId))
      .filter(isObjId)
      .map((id) => oid(id));
    return {
      $and: [
        q,
        externalOnly,
        {
          $or: [
            { sender: { $in: juniorIds } },
            // Client-authored mail delivered to my juniors: real inbound
            // (senderType "client") OR manually composed client messages
            // (isFromClient flag with an employee sender — the composer may
            // be OUTSIDE my subtree, e.g. a top manager, but the assigned
            // employee receiving it is my junior, so I must see it).
            {
              receiver: { $in: juniorIds },
              $or: [
                { senderType: "client" },
                { isFromClient: true },
                // A CRM/manager writing in a client thread is shown AS the
                // client, so it reaches me for exactly the reason above —
                // and without it the thread's Unread/Unresponded state is
                // decided from a thread this query pretended ended earlier.
                ...(clientVoiceIds.length
                  ? [{ sender: { $in: clientVoiceIds } }]
                  : []),
              ],
            },
          ],
        },
      ],
    };
  }

  // 🔑 ACCESS-BASED: CRM-access holders (and rootManager) get org-wide email view.
  const roleHierarchyFilters = [];
  if (isCrmUser || currentUserRole === "owner") {
    roleHierarchyFilters.push({ owner: ownerId });
  }

  // Team leads are NOT given org-wide visibility by role — they see their
  // juniors (entire subtree) via the hierarchy filter below, so visibility is
  // purely seniority-based.
  const nonManagerFilters = [];
  if (juniorIds.length > 0) {
    nonManagerFilters.push({ sender: { $in: juniorIds } });
    nonManagerFilters.push({ receiver: { $in: juniorIds } });
  }

  if (nonManagerFilters.length > 0) {
    roleHierarchyFilters.push({
      $or: nonManagerFilters
    });
  }

  if (roleHierarchyFilters.length === 0) {
    roleHierarchyFilters.push({ _id: null });
  }

  const roleHierarchyFilter = {
    $or: roleHierarchyFilters
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

  // The Scheduled folder is the author's own outbox: mail that has NOT been
  // delivered yet, so only the person who scheduled it may see it.
  //
  // This used to fall back to `inboxVisibility`, which matches RECEIVERS. That
  // bypassed the sender-only rule declared in `scheduledVisibility` just above
  // and handed every addressee — and, for CRM-access holders, the whole org —
  // the subject, body and send time of mail that had not gone out yet.
  //
  // `scheduledBy` is included alongside `sender` because a message can be
  // scheduled on someone else's behalf (rescheduleMessage sets scheduledBy to
  // the acting employee while `sender` stays the original author).
  if (q.isScheduled === true && q.status === "scheduled") {
    return {
      $and: [q, { $or: [{ sender: me }, { scheduledBy: me }] }],
    };
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
      { path: "sender", select: "_id name companyEmail role designation" },
      { path: "client", select: "_id clientName legalBusinessName dba assignedTo" },
      { path: "approvalChain.approver", select: "_id name companyEmail role designation" },
      { path: "plannedApprovalChain", select: "_id name companyEmail role designation" },
      { path: "approvedBy", select: "_id name companyEmail role designation" },
      { path: "disapprovedBy", select: "_id name companyEmail role designation" },
      { path: "readBy.employee", select: "_id name companyEmail" },
      { path: "starredBy", select: "_id name companyEmail" },
      { path: "attachments.uploadedBy", select: "_id name companyEmail" },
      {
        path: "receiver",
        select: "_id name companyEmail email role designation",
        options: { allowNull: true },
      },
      // BCC'd employees resolve to their real identity so the UI can show the
      // company email rather than whatever address was typed.
      {
        path: "bccReceiver",
        select: "_id name companyEmail email role designation",
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

    // 🕒 A scheduled message that has NOT gone out yet belongs to its author
    // alone. This gate runs before every rule below because all of them would
    // otherwise expose undelivered mail: recipients are already stored in
    // `receiver[]` at schedule time (so the participant check right below
    // passes), and the org-wide clause further down explicitly accepted
    // status "scheduled". Mirrors the Scheduled-folder rule in applyVisibility.
    //
    // Once scheduledFor has passed the message is treated as delivered — the
    // same boundary `scheduledVisibility` uses — so a lagging cron run never
    // hides mail whose send time has already arrived.
    if (
      msg.status === "scheduled" &&
      msg.scheduledFor &&
      new Date(msg.scheduledFor) > new Date()
    ) {
      const scheduledById = String(
        msg.scheduledBy?._id || msg.scheduledBy || ""
      );
      if (userId !== senderId && userId !== scheduledById) {
        return res
          .status(403)
          .json({ error: "You don't have permission to view this message" });
      }
    }

    // Check basic participant access
    let hasAccess = userId === senderId || receiverIds.includes(userId);

    // Manager/Owner org-wide view (they sit at the top of the hierarchy).
    // Team leads are NOT special-cased here — they get access via the
    // hierarchy path below (senior-of-sender), so visibility is purely
    // seniority-based.
    if (!hasAccess && ["manager", "owner"].includes(currentUserRole)) {
      if (String(msg.owner?._id || msg.owner) === String(ownerId)) {
        // Managers and Owners can view organization mail ONLY if it is not pending
        if (msg.approvalStatus !== "pending") {
          hasAccess = true;
        }
      }
    }

    // Check client assignment access (team visibility)
    // 🔥 APPROVAL FIX: Assigned-client access does NOT apply to pending messages
    if (!hasAccess && msg.client) {
      const clientId = msg.client?._id || msg.client;
      // Check both assignedTo (deployed employees) AND supervisedBy (hierarchy seniors)
      const client = await ClientInfo.findOne({
        _id: clientId,
        $or: [{ assignedTo: me }, { supervisedBy: me }],
      }).select("_id").lean();
      if (client && msg.approvalStatus !== "pending") hasAccess = true;
    }

    // Check hierarchy access (senior viewing junior)
    // 🔥 APPROVAL FIX: Hierarchy access does NOT apply to pending messages
    if (!hasAccess && senderId) {
      const seniorsOfSender = await getCachedChain(ownerId, senderId);
      if (seniorsOfSender.includes(userId) && msg.approvalStatus !== "pending") hasAccess = true;
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
      threadId,
      reviewState,
    } = req.query;

    const q = {};

    // Forwarded copies belong to their forward's thread only: they carry the
    // ORIGINAL sender, so leaving them in would put them in that person's Sent
    // folder and show the client's mail twice in the Client Box.
    // getMessagesByThread deliberately does NOT apply this — that is where they
    // are meant to be read.
    q.isForwardedCopy = { $ne: true };

    // Thread scope: narrows the query to a single thread so clients don't
    // have to download a large page and filter locally.
    if (threadId) q.threadId = String(threadId);

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

    // Review filter shows all messages from hierarchy juniors — no status restriction
    if (filter !== "review") {
      if (approvalStatus === "pending") {
        q.approvalStatus = "pending";
      }
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
    const isDraftView = req.query.status === "draft";
    const isScheduledView = req.query.status === "scheduled" || filter === "scheduled" || isScheduled === "true";
    const isTrashedVal = isTrashed === "true" || isTrashed === true;
    const isSpamVal = isSpam === "true" || isSpam === true;
    const isParticipantView = !!req.query.participant;

    // Unified inbox view (incoming only) applies ONLY if we aren't in Sent, Draft, Scheduled, Trash, Spam, participant view, or Activity.
    // "inbox" is treated as incoming-only here too: it must show messages
    // RECEIVED by the user, never the ones they sent.
    const isInboxView = !isSentView && !isDraftView && !isScheduledView && !isTrashedVal && !isSpamVal && !isParticipantView && !["review", "all", "external", "internal"].includes(filter);

    // Force incoming-only for unified inbox unless explicitly in Sent, Trash, or asking for ALL mail
    if (isInboxView) {
      const isCrmScope = String(req.query.scope || "") === "crm";
      // Inbox = mail addressed to ME plus inbound mail of MY assigned
      // clients. Juniors' client mail is monitored in Activity, not here.
      // Outside the CRM app "my clients" means strictly assignedTo — a
      // hierarchy senior sits in `supervisedBy` of every downline client,
      // which would pull the whole org's client threads into his Primary.
      const myAssignedClients = await ClientInfo.find({
        owner: q.owner || req.employee?.owner,
        $or: isCrmScope
          ? [{ assignedTo: me }, { supervisedBy: me }]
          : [{ assignedTo: me }],
      })
        .select("_id")
        .lean();
      const myAssignedClientIds = myAssignedClients.map((c) => c._id);

      // A blind recipient is a real recipient: bccReceiver has to be matched
      // everywhere `receiver` is, or the message is delivered nowhere they can
      // see it. It is only the DISCLOSURE of that list that is restricted.
      const receiverMe = {
        $or: [
          { receiver: me },
          { receiver: { $in: [me] } },
          { bccReceiver: me },
        ],
      };
      if (isCrmScope) {
        // CRM app: Primary shows everything addressed to me plus inbound
        // mail of my assigned clients (org-wide client mail is CRM's job).
        q.$or = [
          { receiver: me },
          { receiver: { $in: [me] } },
          { bccReceiver: me },
          ...(myAssignedClientIds.length > 0
            ? [{ client: { $in: myAssignedClientIds }, isFromClient: true }]
            : []),
        ];
      } else {
        // Employee_dashboard/Connect: CLIENT mail reaches Primary only for MY
        // assigned clients — even when I'm a receiver (e.g. a CRM-access user
        // added to a client compose). Internal (non-client) mail addressed to
        // me is unaffected; unassigned client mail lives in the CRM app.
        q.$or = [
          {
            $and: [
              receiverMe,
              { $or: [{ client: { $exists: false } }, { client: null }] },
            ],
          },
          // A forward is private to the people it was explicitly sent to, so it
          // reaches their Primary inbox whether or not they are assigned to the
          // client. Without this, forwarding a client email to a colleague who
          // is not on that client delivered it nowhere they could see: it has a
          // `client`, so it failed the internal-mail branch, and it failed both
          // assigned-client branches too. The Client Box query already carries
          // the same exemption.
          { $and: [receiverMe, { isForward: true }] },
          ...(myAssignedClientIds.length > 0
            ? [
                {
                  $and: [
                    receiverMe,
                    { client: { $in: myAssignedClientIds } },
                  ],
                },
                { client: { $in: myAssignedClientIds }, isFromClient: true },
              ]
            : []),
        ];
      }
      // Supervision items don't belong in the Primary inbox: a pending
      // message's receiver is its current APPROVER, and it must only show in
      // the For-approval filter until it's approved and actually delivered.
      q.approvalStatus = { $ne: "pending" };
      // System announcements have their own tab. Leaving them here as well
      // would bury real mail under machine-written notices — the inbox tabs
      // partition mail, they don't duplicate it.
      q.isSystemAnnouncement = { $ne: true };
      // Emails I only touched as an APPROVER (in the approval chain) belong
      // to the For-approval history, not my inbox — unless I was an intended
      // recipient of the message myself.
      q.$and = [
        ...(q.$and || []),
        {
          $or: [
            { "approvalChain.approver": { $ne: me } },
            { intendedRecipients: me },
          ],
        },
      ];
    } else if (
      ["all", "inbox", "allMail"].includes(filter) &&
      !isSentView &&
      !isDraftView &&
      !isScheduledView &&
      !isTrashedVal &&
      !isSpamVal &&
      !isParticipantView
    ) {
      // Inbox/All Mail: only threads the user actually participates in.
      // Include own sent messages so newly started threads still appear;
      // incoming client mail is narrowed further by applyVisibility.
      q.$or = [
        { isFromClient: true },
        { receiver: me },
        { receiver: { $in: [me] } },
        { bccReceiver: me },
        { sender: me }
      ];
    }

    // Sent view: only the user's own sent messages unless an explicit
    // sender/participant scope was requested.
    if (isSentView && !isParticipantView && between.length !== 2 && !isObjId(sender)) {
      q.sender = me;
    }

    const qFinal = await applyVisibility(q, req, filter);

    const isThreaded = req.query.threadMode === "true" || req.query.threadMode === true;

    if (isThreaded) {
      // Activity sub-filter: threads whose latest message is the client's
      // (no employee has responded yet), split by whether an assigned
      // employee (receiver) has at least read it:
      //   unresponded → read by an assignee but not replied
      //   unread      → not even read by any assignee
      const reviewStateVal =
        filter === "review" &&
        ["unresponded", "unread"].includes(String(reviewState))
          ? String(reviewState)
          : null;

      // All activity: a message pending at one of MY juniors belongs to Pre
      // approval — while a thread has one, the whole thread is hidden from my
      // All activity (mirrors the pending-at-ME → My approval rule below).
      let reviewJuniorIdStrings = [];
      if (filter === "review") {
        const ownerForJuniors = q.owner || req.employee?.owner;
        const isCrmOrgActivity =
          String(req.query.scope || "") === "crm" &&
          (normalizeRole(req.employee?.role || "") === "owner" ||
            (await hasCrmAccess(req.employee)));

        if (isCrmOrgActivity) {
          // CRM watches the whole organization, not only its own hierarchy
          // subtree. Use every employee id when deciding whether a thread is
          // still pending below, preserving the existing rule that unapproved
          // work stays in For Approval instead of leaking into All Activity.
          reviewJuniorIdStrings = (
            await Employee.find({
              owner: ownerForJuniors,
              _id: { $ne: me },
            }).distinct("_id")
          ).map(String);
        } else {
          reviewJuniorIdStrings = (
            await getCachedJuniors(ownerForJuniors, me)
          ).map(String);
        }
      }

      // A message authored under either external identity is client mail for
      // Activity response tracking, even when a CRM user created it through
      // the From picker. A normal senior/employee reply has both flags false
      // and therefore closes Unresponded once it is delivered.

      const IS_FROM_CLIENT = {
        $or: [
          { $eq: ["$senderType", "client"] },
          { $eq: ["$isFromClient", true] },
          { $eq: ["$isFromCompanyEmployee", true] },
          {
            $and: [
              { $ne: [{ $ifNull: ["$client", null] }, null] },
              { $eq: [{ $toString: "$sender" }, { $toString: "$client" }] },
            ],
          },
        ],
      };
      // A reply the client can actually have received. Mail still waiting on an
      // approver — or rejected by one — never left the building, so it must not
      // count as an answer. (Drafts are already excluded by the base query;
      // `scheduled` hasn't gone out yet either.)
      const IS_DELIVERED_REPLY = {
        $and: [
          { $not: IS_FROM_CLIENT },
          { $eq: ["$status", "sent"] },
          { $not: { $in: ["$approvalStatus", ["pending", "disapproved"]] } },
        ],
      };

      const pipeline = [
        { $match: qFinal },
        // Perf: keep only the scalar fields the $group below reads, so the
        // in-memory sort/group doesn't drag full email bodies + headers around.
        {
          $project: {
            threadId: 1,
            owner: 1,
            createdAt: 1,
            // Feeds `rootSubject` below — the thread's own name.
            subject: 1,
            senderType: 1,
            isFromClient: 1,
            isFromCompanyEmployee: 1,
            client: 1,
            sender: 1,
            receiver: 1,
            approvalStatus: 1,
            status: 1,
            "readBy.employee": 1,
          },
        },
        { $sort: { createdAt: -1 } },
        {
          $group: {
            _id: "$threadId",
            threadOwner: { $first: "$owner" },
            latestId: { $first: "$_id" },
            latestMessageAt: { $max: "$createdAt" },
            // Docs arrive newest-first, so $last is the mail that STARTED the
            // thread. A conversation is named after that mail — not after
            // whatever landed on top of it. Anyone editing one reply's subject
            // (the pending-message editor allows exactly that) would otherwise
            // silently rename the whole conversation in the list, while the
            // side chat — which reads the thread's first message — kept the
            // original name. That disagreement is what users see as a glitch.
            rootSubject: { $last: "$subject" },
            // Docs are sorted newest-first, so $first = the thread's latest message.
            latestClient: { $first: "$client" },
            // Unread/Unresponded is anchored on the LAST MAIL THE CLIENT SENT,
            // not on the thread's last message. A client who writes again into
            // a thread that was answered before is waiting again from that
            // moment on, and the earlier reply says nothing about the new mail
            // — anchoring on the thread's last message dropped exactly those
            // threads out of both views. Pairing it with the last DELIVERED
            // reply also keeps a thread listed while its answer is still stuck
            // in approval, which the client cannot see.
            lastClientAt: { $max: { $cond: [IS_FROM_CLIENT, "$createdAt", null] } },
            lastReplyAt: {
              $max: { $cond: [IS_DELIVERED_REPLY, "$createdAt", null] },
            },
            // [sortKey, …payload]: $max compares arrays element by element, so
            // the winner is the newest client message and it carries its own
            // id and readers out with it. Cheaper than a second lookup, and
            // the readers must come from THAT message — the read state of a
            // later internal note says nothing about the client's mail.
            lastClientMeta: {
              $max: {
                $cond: [
                  IS_FROM_CLIENT,
                  [
                    "$createdAt",
                    { $ifNull: ["$readBy.employee", []] },
                    "$_id",
                  ],
                  null,
                ],
              },
            },
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
            },
            // Thread has a message currently pending MY approval (a pending
            // message's receiver is its current approver). While true, the
            // whole thread belongs in For approval → My approval, NOT in
            // All activity; once I approve (receiver moves to the next
            // senior) the thread returns to All activity for me.
            hasPendingForMe: {
              $max: {
                $cond: [
                  {
                    $and: [
                      { $eq: ["$approvalStatus", "pending"] },
                      { $in: [{ $toString: me }, { $map: { input: { $ifNull: ["$receiver", []] }, as: "r", in: { $toString: "$$r" } } }] },
                      // A senior who ALREADY approved is kept in `receiver` (so the
                      // mail lingers in their inbox) even though it's now pending
                      // ABOVE them at the next senior. That is no longer "pending
                      // for me", so it must NOT hide the thread from their All
                      // Activity — the approved work is legitimate activity for them.
                      { $not: { $in: [{ $toString: me }, { $map: { input: { $ifNull: ["$approvalChain", []] }, as: "a", in: { $toString: "$$a.approver" } } }] } }
                    ]
                  },
                  true,
                  false
                ]
              }
            },
            // Thread has a message pending at one of MY junior approvers —
            // that work lives in For approval → Pre approval, so the thread
            // must stay out of my All activity until it's approved.
            hasPendingBelowMe: {
              $max: {
                $cond: [
                  {
                    $and: [
                      { $eq: ["$approvalStatus", "pending"] },
                      {
                        $gt: [
                          {
                            $size: {
                              $setIntersection: [
                                reviewJuniorIdStrings,
                                { $map: { input: { $ifNull: ["$receiver", []] }, as: "r", in: { $toString: "$$r" } } }
                              ]
                            }
                          },
                          0
                        ]
                      }
                    ]
                  },
                  true,
                  false
                ]
              }
            },
            // Thread has at least one message a senior has ALREADY approved
            // (approvalChain populated, or status approved). Once true, the
            // thread is real activity and must appear in All Activity regardless
            // of any further pending step above — it still lives in For Approval
            // for whoever it's pending on, but is no longer hidden from Activity.
            hasApproval: {
              $max: {
                $cond: [
                  {
                    $or: [
                      { $eq: ["$approvalStatus", "approved"] },
                      { $gt: [{ $size: { $ifNull: ["$approvalChain", []] } }, 0] }
                    ]
                  },
                  true,
                  false
                ]
              }
            }
          }
        }
      ];

      // Visibility establishes which threads this user may review, but reply
      // state belongs to the complete thread. A response from the current
      // senior, another senior, or any assigned employee can sit outside the
      // hierarchy-reduced qFinal set. Inspect all messages in each already-
      // visible thread so any delivered employee response clears Unresponded.
      if (filter === "review") pipeline.push(
        {
          $lookup: {
            from: "assignmentmessages",
            let: { reviewThreadId: "$_id", reviewOwnerId: "$threadOwner" },
            pipeline: [
              {
                $match: {
                  $expr: {
                    $and: [
                      { $eq: ["$threadId", "$$reviewThreadId"] },
                      { $eq: ["$owner", "$$reviewOwnerId"] },
                    ],
                  },
                },
              },
              {
                $group: {
                  _id: null,
                  lastClientAt: {
                    $max: { $cond: [IS_FROM_CLIENT, "$createdAt", null] },
                  },
                  lastReplyAt: {
                    $max: { $cond: [IS_DELIVERED_REPLY, "$createdAt", null] },
                  },
                  lastClientMeta: {
                    $max: {
                      $cond: [
                        IS_FROM_CLIENT,
                        [
                          "$createdAt",
                          { $ifNull: ["$readBy.employee", []] },
                          "$_id",
                        ],
                        null,
                      ],
                    },
                  },
                },
              },
            ],
            as: "wholeThreadReview",
          },
        },
        {
          $addFields: {
            lastClientAt: {
              $ifNull: [
                { $arrayElemAt: ["$wholeThreadReview.lastClientAt", 0] },
                "$lastClientAt",
              ],
            },
            lastReplyAt: {
              $ifNull: [
                { $arrayElemAt: ["$wholeThreadReview.lastReplyAt", 0] },
                "$lastReplyAt",
              ],
            },
            lastClientMeta: {
              $ifNull: [
                { $arrayElemAt: ["$wholeThreadReview.lastClientMeta", 0] },
                "$lastClientMeta",
              ],
            },
          },
        },
        { $project: { wholeThreadReview: 0 } },
      );

      // Unpack the client anchor: is the client still waiting, who read the
      // mail they are waiting on, and which message it is.
      pipeline.push({
        $addFields: {
          awaitingClientReply: {
            $and: [
              { $ne: ["$lastClientAt", null] },
              {
                $or: [
                  { $eq: ["$lastReplyAt", null] },
                  { $lt: ["$lastReplyAt", "$lastClientAt"] },
                ],
              },
            ],
          },
          lastClientReadByIds: {
            $ifNull: [{ $arrayElemAt: ["$lastClientMeta", 1] }, []],
          },
          lastClientId: { $arrayElemAt: ["$lastClientMeta", 2] },
        },
      });

      // Only restrict to received threads if we are strictly filtering for incoming-only inboxes.
      // 'all'/'allMail' show every thread (including ones I started); 'inbox'
      // is incoming-only, so it DOES require the thread to have received something.
      if (filter !== "all" && filter !== "allMail") {
        pipeline.push({ $match: { receivedSomething: true } });
      }

      // All activity hides threads awaiting approval: pending at ME → they
      // show exclusively in For approval → My approval; pending at one of MY
      // juniors → For approval → Pre approval. Either way the whole thread
      // stays out of All activity until the pending work is cleared.
      if (filter === "review") {
        pipeline.push({
          $match: {
            // Hide only threads STILL wholly awaiting their first approval
            // (pending at me or a junior AND no senior has approved yet). The
            // moment a senior approves, `hasApproval` is true and the thread
            // shows in All Activity immediately — even while it's pending to the
            // next senior up the chain.
            $or: [
              { hasApproval: true },
              {
                $and: [
                  { hasPendingForMe: { $ne: true } },
                  { hasPendingBelowMe: { $ne: true } },
                ],
              },
            ],
          },
        });
      }
      if (filter === "review" && !reviewStateVal) {
        pipeline.push(
          {
            $lookup: {
              from: "assignmentmessages",
              let: { threadId: "$_id", ownerId: "$threadOwner" },
              pipeline: [
                {
                  $match: {
                    $expr: {
                      $and: [
                        { $eq: ["$threadId", "$$threadId"] },
                        { $eq: ["$owner", "$$ownerId"] },
                      ],
                    },
                    isTrashed: { $ne: true },
                    isSpam: { $ne: true },
                  },
                },
                { $sort: { createdAt: -1 } },
                { $limit: 1 },
                { $project: { _id: 1, createdAt: 1 } },
              ],
              as: "actualLatestMessage",
            },
          },
          {
            $addFields: {
              latestId: {
                $ifNull: [
                  { $arrayElemAt: ["$actualLatestMessage._id", 0] },
                  "$latestId",
                ],
              },
              latestMessageAt: {
                $ifNull: [
                  { $arrayElemAt: ["$actualLatestMessage.createdAt", 0] },
                  "$latestMessageAt",
                ],
              },
            },
          },
          { $project: { actualLatestMessage: 0 } }
        );
      }



      if (reviewStateVal) {
        pipeline.push(
          { $match: { awaitingClientReply: true } },
          // "Read" must mean read by one of the client's ASSIGNED employees.
          // Inbound mail is also delivered to team leads / CC'd employees, and
          // they (or a senior receiver) opening it must NOT move the thread
          // out of Unread — only the assignee's read counts.
          {
            $lookup: {
              from: "clientinfos",
              localField: "latestClient",
              foreignField: "_id",
              as: "clientDoc",
            },
          },
          {
            $addFields: {
              latestReadByAssignee: {
                $gt: [
                  {
                    $size: {
                      $setIntersection: [
                        { $ifNull: ["$lastClientReadByIds", []] },
                        {
                          $ifNull: [
                            { $arrayElemAt: ["$clientDoc.assignedTo", 0] },
                            [],
                          ],
                        },
                      ],
                    },
                  },
                  0,
                ],
              },
            },
          },
          {
            $match: {
              latestReadByAssignee: reviewStateVal === "unresponded",
            },
          },
          // These two views are ABOUT the unanswered client mail, so each row
          // is that mail — not whatever internal message happens to sit on top
          // of the thread. A no-op for threads the client's mail already ends;
          // it only re-points the ones this fix newly surfaces.
          {
            $addFields: {
              latestId: { $ifNull: ["$lastClientId", "$latestId"] },
              latestMessageAt: {
                $ifNull: ["$lastClientAt", "$latestMessageAt"],
              },
            },
          },
          { $project: { clientDoc: 0 } }
        );
      }

      pipeline.push(
        { $sort: { latestMessageAt: -1 } },
        // Page + total in ONE pass. The match/sort/group above is by far the
        // expensive part of this endpoint — previously a second, nearly
        // identical aggregation re-grouped the whole mailbox just to count
        // the threads, doubling the load time.
        {
          $facet: {
            page: [{ $skip: (pageNum - 1) * lim }, { $limit: lim }],
            total: [{ $count: "total" }],
          },
        }
      );

      const [aggResult] = await AssignmentMessage.aggregate(pipeline).allowDiskUse(true);
      const distinctThreads = aggResult?.page || [];
      const totalCount = aggResult?.total?.[0]?.total || 0;

      const latestMessageIds = distinctThreads.map(t => t.latestId);
      if (latestMessageIds.length === 0) {
        return res.json({
          items: [],
          total: totalCount,
          page: pageNum,
          pages: Math.ceil(totalCount / lim),
          limit: lim,
        });
      }

      const messages = await AssignmentMessage.find({ _id: { $in: latestMessageIds } })
        // Raw RFC-2822 headers are never rendered in the list and can be huge
        .select("-emailMetadata.headers")
        .populate([
          { path: "owner", select: "_id name companyEmail" },
          { path: "sender", select: "_id name companyEmail role designation supervisionMode photographUrl imageUrl" },
          { path: "receiver", select: "_id name companyEmail email role designation" },
          // BCC'd employees resolve to their real identity so the UI can show
          // the company email rather than whatever address was typed.
          { path: "bccReceiver", select: "_id name companyEmail email role designation" },
          // client photo + contacts travel with the thread list so detail
          // view avatars render instantly without extra requests; assignedTo
          // feeds the Unread/Unresponded badge (read-by-assignee check)
          { path: "client", select: "_id clientName photographUrl companyEmployees assignedTo" },
        ])
        .lean();

      const finalItems = messages.map(m => {
        const stats = distinctThreads.find(t => String(t.latestId) === String(m._id));
        return {
          ...slimListMessage(m),
          receiver: Array.isArray(m.receiver) ? m.receiver : [m.receiver].filter(Boolean),
          isDirectMessage: !m.client,
          threadMessageCount: stats ? stats.threadMessageCount : 1,
          threadUnreadCount: stats ? stats.threadUnreadCount : 0,
          // Thread-level Unread/Unresponded state. In All activity the row is
          // whatever message came last, which is not necessarily the client's,
          // so the badge cannot be derived from this message alone — these two
          // carry the state of the client mail actually being waited on.
          awaitingClientReply: !!stats?.awaitingClientReply,
          clientMailReadBy: (stats?.lastClientReadByIds || []).map(String),
          // The row is the thread's LATEST message, so its own subject is not
          // the conversation's name. Falls back to it for a one-message thread.
          threadSubject: stats?.rootSubject || m.subject,
        };
      }).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

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
        .select("-emailMetadata.headers")
        .populate([
          { path: "owner", select: "_id name companyEmail" },
          {
            path: "sender",
            select: "_id name companyEmail role designation supervisionMode photographUrl imageUrl",
          }, // 🔥 ADDED supervisionMode
          { path: "receiver", select: "_id name companyEmail email role designation" },
          // BCC'd employees resolve to their real identity so the UI can show
          // the company email rather than whatever address was typed.
          { path: "bccReceiver", select: "_id name companyEmail email role designation" },
          { path: "client", select: "_id clientName photographUrl companyEmployees" },
          { path: "attachments.uploadedBy", select: "_id name companyEmail" },
          { path: "scheduledBy", select: "_id name companyEmail" },
          { path: "trashedBy", select: "_id name companyEmail" },
          { path: "spamReportedBy", select: "_id name companyEmail" },
          // Same reason as the thread endpoint: EmailDetail falls back to this
          // list when the thread call comes back empty, and it names the senior
          // who edited a message.
          { path: "lastEditedBy", select: "_id name companyEmail role designation" },
        ])
        .lean(),
      AssignmentMessage.countDocuments(qFinal),
    ]);

    const normalizedItems = items.map((item) => ({
      ...slimListMessage(item),
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
        { path: "sender", select: "_id name companyEmail role designation" },
        { path: "receiver", select: "_id name companyEmail email role designation" },
        { path: "client", select: "_id clientName legalBusinessName dba assignedTo" },
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

    // Forwarded copies belong to their forward's thread only: they carry the
    // ORIGINAL sender, so leaving them in would put them in that person's Sent
    // folder and show the client's mail twice in the Client Box.
    // getMessagesByThread deliberately does NOT apply this — that is where they
    // are meant to be read.
      isForwardedCopy: { $ne: true },
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

    // Trash + Spam are PER USER: the Bin/Spam tabs show only what THIS user
    // binned/marked, and the inbox hides only what THIS user binned/marked
    // (other employees still see the message).
    if (isTrashed === "true") q.trashedBy = currentUser;
    else if (isSpam === "true") q.spamReporters = currentUser;
    else {
      q.trashedBy = { $ne: currentUser };
      q.spamReporters = { $ne: currentUser };
    }

    if (filter !== "review" && approvalStatus === "pending") {
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
    const isInboxView = !isSentView && isTrashed !== "true" && isSpam !== "true" && filter !== "review";

    // Client Box inbox: org-wide client mail is a CRM-app feature — the CRM
    // frontend sends scope=crm and its users hold CRM access. In
    // Employee_dashboard/Connect (no scope param) everyone, including
    // CRM-access holders, sees only mail of clients assigned directly to them.
    if (isInboxView) {
      const canSeeAllClientBox =
        String(req.query.scope || "") === "crm" &&
        (await hasCrmAccess(req.employee));

      if (!canSeeAllClientBox) {
        const myAssignedClients = await ClientInfo.find({
          owner: q.owner,
          assignedTo: me,
        })
          .select("_id")
          .lean();
        const myAssignedClientIds = myAssignedClients.map((c) => c._id);

        // Which clients' mail I may see in my Client Box (my assigned clients).
        let assignedClientConstraint;
        if (myAssignedClientIds.length === 0) {
          assignedClientConstraint = { $in: [] };
        } else if (isObjId(client)) {
          assignedClientConstraint = myAssignedClientIds.some(
            (id) => String(id) === String(client),
          )
            ? oid(String(client))
            : { $in: [] };
        } else {
          assignedClientConstraint = { $in: myAssignedClientIds };
        }

        // A client email FORWARDED directly to me belongs in my Client Box even
        // when I'm not assigned to that client — forwards are private to their
        // explicit recipients. Allow those alongside my assigned-client mail
        // instead of hard-restricting q.client (which excluded them entirely).
        q.$and = [
          ...(q.$and || []),
          {
            $or: [
              { client: assignedClientConstraint },
              { isForward: true, receiver: me },
            ],
          },
        ];
      }

      q.approvalStatus = { $ne: "pending" };
      q.$and = [
        ...(q.$and || []),
        {
          $or: [
            { "approvalChain.approver": { $ne: me } },
            { intendedRecipients: me },
          ],
        },
      ];
    }

    const qFinal = await applyVisibility(q, req, filter);

    // Robust threadMode check
    const isThreaded = threadMode === "true" || threadMode === true;

    if (isThreaded) {
      const [extAgg] = await AssignmentMessage.aggregate([
        { $match: qFinal },
        // Perf: slim to the fields the $group reads before the in-memory sort.
        {
          $project: {
            threadId: 1,
            owner: 1,
            createdAt: 1,
            // Feeds `rootSubject` below — the thread's own name.
            subject: 1,
            senderType: 1,
            isFromClient: 1,
            client: 1,
            sender: 1,
            receiver: 1,
            approvalStatus: 1,
            "readBy.employee": 1,
          },
        },
        { $sort: { createdAt: -1 } },
        {
          $group: {
            _id: "$threadId",
            latestId: { $first: "$_id" },
            latestMessageAt: { $max: "$createdAt" },
            // Docs arrive newest-first, so $last is the mail that STARTED the
            // thread. A conversation is named after that mail — not after
            // whatever landed on top of it. Anyone editing one reply's subject
            // (the pending-message editor allows exactly that) would otherwise
            // silently rename the whole conversation in the list, while the
            // side chat — which reads the thread's first message — kept the
            // original name. That disagreement is what users see as a glitch.
            rootSubject: { $last: "$subject" },
            // CRM (manager) and all users: External Inbox strictly shows threads with CLIENT replies.
            // Solitary sent messages remain in "Sent".
            hasClientInteraction: {
              $max: {
                $cond: [
                  {
                    $or: [
                      { $eq: ["$isFromClient", true] },
                      {
                        $and: [
                          { $ifNull: ["$client", false] },
                          { $ne: ["$senderType", "client"] }
                        ]
                      }
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
        // Filter: Must have client ID AND must have an incoming message from a client
        { $match: { hasClient: true, hasClientInteraction: true } },
        { $sort: { latestMessageAt: -1 } },
        // Page + total in one pass — no second full re-group just to count
        {
          $facet: {
            page: [{ $skip: (pageNum - 1) * lim }, { $limit: lim }],
            total: [{ $count: "total" }],
          },
        },
      ]).allowDiskUse(true);

      const distinctThreads = extAgg?.page || [];
      const totalCount = extAgg?.total?.[0]?.total || 0;

      const latestMessageIds = distinctThreads.map(t => t.latestId);
      if (latestMessageIds.length === 0) {
        return res.json({ communicationType: "external", items: [], total: totalCount, page: pageNum, pages: Math.ceil(totalCount / lim), limit: lim });
      }

      const messages = await AssignmentMessage.find({ _id: { $in: latestMessageIds } })
        .select("-emailMetadata.headers")
        .populate([
          { path: "owner", select: "_id name companyEmail" },
          { path: "sender", select: "_id name companyEmail role designation supervisionMode" },
          { path: "receiver", select: "_id name companyEmail email role designation" },
          { path: "client", select: "_id clientName legalBusinessName dba assignedTo" },
        ])
        .lean();

      const finalItems = messages.map(m => {
        const stats = distinctThreads.find(t => String(t.latestId) === String(m._id));
        return {
          ...slimListMessage(m),
          receiver: Array.isArray(m.receiver) ? m.receiver : [m.receiver].filter(Boolean),
          isDirectMessage: !m.client,
          threadMessageCount: stats ? stats.threadMessageCount : 1,
          threadUnreadCount: stats ? stats.threadUnreadCount : 0,
          // The row is the thread's LATEST message, so its own subject is not
          // the conversation's name. Falls back to it for a one-message thread.
          threadSubject: stats?.rootSubject || m.subject
        };
      }).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

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
            select: "_id name companyEmail role designation supervisionMode",
          },
          { path: "receiver", select: "_id name companyEmail email role designation" },
          { path: "client", select: "_id clientName legalBusinessName dba assignedTo" },
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

    // Forwarded copies belong to their forward's thread only: they carry the
    // ORIGINAL sender, so leaving them in would put them in that person's Sent
    // folder and show the client's mail twice in the Client Box.
    // getMessagesByThread deliberately does NOT apply this — that is where they
    // are meant to be read.
      isForwardedCopy: { $ne: true },

      // Team Box is people talking to people. Announcements are non-client
      // mail too, so without this they would swamp it; they have their own tab.
      isSystemAnnouncement: { $ne: true },
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

    // Trash + Spam are PER USER (see listMessages): scope tabs + inbox by user.
    if (isTrashed === "true") q.trashedBy = req.employee._id;
    else if (isSpam === "true") q.spamReporters = req.employee._id;
    else {
      q.trashedBy = { $ne: req.employee._id };
      q.spamReporters = { $ne: req.employee._id };
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
        // Perf: slim to the fields the $group reads before the in-memory sort.
        {
          $project: {
            threadId: 1,
            owner: 1,
            createdAt: 1,
            // Feeds `rootSubject` below — the thread's own name.
            subject: 1,
            senderType: 1,
            isFromClient: 1,
            client: 1,
            sender: 1,
            receiver: 1,
            approvalStatus: 1,
            "readBy.employee": 1,
          },
        },
        { $sort: { createdAt: -1 } },
        {
          $group: {
            _id: "$threadId",
            latestId: { $first: "$_id" },
            latestMessageAt: { $max: "$createdAt" },
            // Docs arrive newest-first, so $last is the mail that STARTED the
            // thread. A conversation is named after that mail — not after
            // whatever landed on top of it. Anyone editing one reply's subject
            // (the pending-message editor allows exactly that) would otherwise
            // silently rename the whole conversation in the list, while the
            // side chat — which reads the thread's first message — kept the
            // original name. That disagreement is what users see as a glitch.
            rootSubject: { $last: "$subject" },
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
        // Page + total in one pass — no second full re-group just to count
        {
          $facet: {
            page: [{ $skip: (pageNum - 1) * lim }, { $limit: lim }],
            total: [{ $count: "total" }],
          },
        },
      ]).allowDiskUse(true);

      const intAgg = distinctThreads[0];
      const pageThreads = intAgg?.page || [];
      const totalCount = intAgg?.total?.[0]?.total || 0;

      const latestMessageIds = pageThreads.map(t => t.latestId);
      if (latestMessageIds.length === 0) {
        return res.json({ communicationType: "internal", items: [], total: totalCount, page: pageNum, pages: Math.ceil(totalCount / lim), limit: lim });
      }

      const messages = await AssignmentMessage.find({ _id: { $in: latestMessageIds } })
        .select("-emailMetadata.headers")
        .populate([
          { path: "owner", select: "_id name companyEmail" },
          { path: "sender", select: "_id name companyEmail role designation supervisionMode" },
          { path: "receiver", select: "_id name companyEmail email role designation" },
        ])
        .lean();

      const finalItems = messages.map(m => {
        const stats = pageThreads.find(t => String(t.latestId) === String(m._id));
        return {
          ...slimListMessage(m),
          receiver: Array.isArray(m.receiver) ? m.receiver : [m.receiver].filter(Boolean),
          isDirectMessage: !m.client,
          threadMessageCount: stats ? stats.threadMessageCount : 1,
          threadUnreadCount: stats ? stats.threadUnreadCount : 0,
          // The row is the thread's LATEST message, so its own subject is not
          // the conversation's name. Falls back to it for a one-message thread.
          threadSubject: stats?.rootSubject || m.subject
        };
      }).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

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
          { path: "sender", select: "_id name companyEmail role designation" },
          { path: "receiver", select: "_id name companyEmail email role designation" },
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

// GET /api/assignment-messages/system-announcements
//
// The inbox's "System Announcements" tab: mail the APP wrote to me rather than
// a colleague — every Request Center event (submitted / approved / rejected)
// plus the other system deliveries such as the HR policy.
//
// Deliberately flat, not threaded: each announcement is its own record of one
// event, and grouping them by threadId would collapse a run of decisions into
// a single row.
exports.getSystemAnnouncements = async function getSystemAnnouncements(
  req,
  res
) {
  try {
    const currentUser = req.employee?._id;
    const owner = req.employee?.owner;
    if (!isObjId(currentUser)) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { page = 1, limit = 50, isTrashed, isSpam } = req.query;
    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
    const me = oid(String(currentUser));

    const q = {
      ...(isObjId(owner) ? { owner } : {}),
      status: "sent",
      // Both flavours of system mail belong here: the Request Center
      // announcements and the older system deliveries (HR policy).
      $or: [{ isSystemAnnouncement: true }, { isSystemMessage: true }],
      // Blind recipients are real recipients everywhere else, so match both.
      $and: [{ $or: [{ receiver: me }, { bccReceiver: me }] }],
      // Trash and spam are PER USER, like every other mail view.
      ...(isTrashed === "true"
        ? { trashedBy: me }
        : { trashedBy: { $ne: me } }),
      ...(isSpam === "true"
        ? { spamReporters: me }
        : { spamReporters: { $ne: me } }),
    };

    const [items, total] = await Promise.all([
      AssignmentMessage.find(q)
        .sort({ createdAt: -1 })
        .skip((pageNum - 1) * lim)
        .limit(lim)
        .select("-emailMetadata.headers")
        .populate([
          { path: "sender", select: "_id name companyEmail role designation" },
          {
            path: "receiver",
            select: "_id name companyEmail email role designation",
          },
        ])
        .lean(),
      AssignmentMessage.countDocuments(q),
    ]);

    res.set("Cache-Control", "no-store");
    res.json({
      communicationType: "system-announcements",
      items,
      total,
      page: pageNum,
      pages: Math.max(1, Math.ceil(total / lim)),
      limit: lim,
    });
  } catch (e) {
    console.error("❌ Error in getSystemAnnouncements:", e);
    res.status(500).json({ error: "Failed to fetch system announcements" });
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
      { path: "sender", select: "_id name companyEmail role designation" },
      { path: "receiver", select: "_id name companyEmail email role designation" },
      { path: "client", select: "_id clientName legalBusinessName dba assignedTo" },
      { path: "approvalChain.approver", select: "_id name companyEmail role designation" },
      { path: "approvedBy", select: "_id name companyEmail role designation" },
      { path: "disapprovedBy", select: "_id name companyEmail role designation" },
      { path: "readBy.employee", select: "_id name companyEmail" },
      { path: "starredBy", select: "_id name companyEmail" },
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
    const owner = req.employee.owner;

    // Mirror getMessageCounts' "unread" (the EmailSidebar Inbox badge):
    // thread-level, MY inbox only. Pending approvals, approver-only copies
    // and unassigned clients' mail never clear from the inbox, so counting
    // them left the Mail-icon badge permanently stuck.
    const myAssignedClients = await ClientInfo.find({
      owner,
      assignedTo: userId,
    })
      .select("_id")
      .lean();
    const assignedClientIds = myAssignedClients.map((c) => c._id);

    // Count by the thread's ABSOLUTE latest message so this matches the list's
    // per-thread bold state (and getMessageCounts' "unread"): a thread is
    // unread iff its latest message is addressed to me and I haven't read it.
    // Counting "any unread message in the thread" left an old unread message
    // (buried under a newer read/own reply) stuck on the Mail-icon badge.
    const meId = oid(String(userId));
    const result = await AssignmentMessage.aggregate([
      {
        $match: {
          owner: oid(String(owner)),
          status: "sent",
          approvalStatus: { $ne: "pending" },
          // Keep this endpoint aligned with the Primary Inbox list. These
          // records live outside that list and otherwise leave a Mail-rail
          // badge that the user has no visible thread available to clear.
          isForwardedCopy: { $ne: true },
          isSystemAnnouncement: { $ne: true },
          isSystemMessage: { $ne: true },
        },
      },
      { $sort: { createdAt: -1 } },
      {
        $group: {
          _id: { $ifNull: ["$threadId", { $toString: "$_id" }] },
          latestSender: { $first: "$sender" },
          latestReceiver: { $first: "$receiver" },
          latestReadBy: { $first: { $ifNull: ["$readBy.employee", []] } },
          latestClient: { $first: "$client" },
          latestTrashedBy: { $first: { $ifNull: ["$trashedBy", []] } },
          latestSpam: { $first: { $ifNull: ["$spamReporters", []] } },
          latestApprover: {
            $first: { $ifNull: ["$approvalChain.approver", []] },
          },
          latestIntended: { $first: { $ifNull: ["$intendedRecipients", []] } },
        },
      },
      {
        $match: {
          $and: [
            { latestReceiver: meId },
            { latestSender: { $ne: meId } },
            { latestReadBy: { $ne: meId } },
            { latestTrashedBy: { $ne: meId } },
            { latestSpam: { $ne: meId } },
            {
              $or: [
                { latestApprover: { $ne: meId } },
                { latestIntended: meId },
              ],
            },
            // Assigned-clients-only client scope (this endpoint is used by the
            // non-CRM apps' Mail rail; internal mail always counts).
            {
              $or: [
                { latestClient: null },
                ...(assignedClientIds.length > 0
                  ? [{ latestClient: { $in: assignedClientIds } }]
                  : []),
              ],
            },
          ],
        },
      },
      { $count: "count" },
    ]);
    const unreadCount = result[0]?.count || 0;

    res.set("Cache-Control", "no-store");
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
                {
                  $and: [
                    { $not: { $in: [me, { $ifNull: ["$readBy.employee", []] }] } },
                    { $in: [{ $toString: me }, { $map: { input: { $ifNull: ["$receiver", []] }, as: "r", in: { $toString: "$$r" } } }] }
                  ]
                },
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

    const aggResult = await AssignmentMessage.aggregate(pipeline).allowDiskUse(true);
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
      { path: "latestMessage.client", select: "_id clientName legalBusinessName dba" },
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
    const { limit = 50, page = 1, clientId: requestedClientId } = req.query;

    if (!threadId) {
      return res.status(400).json({ error: "Thread ID is required" });
    }

    // Build base query
    const q = { threadId };

    // A legacy thread id may have been reused across clients. When the email
    // detail view supplies its client, preserve that boundary in the query so
    // only that client and its company employees appear in the conversation.
    if (requestedClientId && isObjId(requestedClientId)) {
      q.client = requestedClientId;
    }

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
          { path: "sender", select: "_id name companyEmail role designation photographUrl imageUrl" },
          { path: "receiver", select: "_id name companyEmail email role designation photographUrl imageUrl" },
          // BCC'd employees resolve to their real identity so the UI can show
          // the company email rather than whatever address was typed.
          { path: "bccReceiver", select: "_id name companyEmail email role designation photographUrl imageUrl" },
          // photographUrl + companyEmployees ride along so the client/contact
          // avatars render without a separate client-info request.
          // Signatures now live on the business (businesses[].emailSignature,
          // and per-contact inside businesses[].companyEmployees) so the reply
          // box can pick the one matching the address being replied to. The
          // client-level emailSignature/companyEmployees stay in the projection
          // only for records created before that move.
          {
            path: "client",
            select:
              "_id clientName photographUrl companyEmployees emailSignature businesses",
          },
          { path: "attachments.uploadedBy", select: "_id name companyEmail" },
          { path: "scheduledBy", select: "_id name companyEmail" },
          { path: "approvedBy", select: "_id name companyEmail role designation" },
          { path: "disapprovedBy", select: "_id name companyEmail role designation" },
          // A senior may rewrite a junior's pending mail. The thread has to say
          // WHO, by name, to everyone reading it — without this the id arrives
          // unpopulated and the "Last edited by …" line silently disappears on
          // the next reload, leaving edited text with no author.
          { path: "lastEditedBy", select: "_id name companyEmail role designation" },
          { path: "plannedApprovalChain", select: "_id name role designation" },
          {
            path: "approvalChain",
            populate: { path: "approver", select: "_id name role designation", model: "Employee" },
          },
        ])
        .lean(),
      AssignmentMessage.countDocuments(qFinal),
    ]);

    // Add direct message flag + slim inbound-email attachments: whole files
    // are stored as base64 `data:` URIs on the message, which made loading a
    // thread ship megabytes of JSON. Point the URL at the streaming endpoint
    // instead; the download handler fetches it with auth like any relative URL.
    const normalizedItems = items.map((item) => {
      if (Array.isArray(item.attachments) && item.attachments.length > 0) {
        item.attachments = item.attachments.map((a) =>
          a && typeof a.url === "string" && a.url.startsWith("data:")
            ? {
                ...a,
                url: `/assignment-messages/${item._id}/attachment/${a._id}`,
                hasInlineData: true,
              }
            : a
        );
      }
      if (item.emailMetadata && item.emailMetadata.headers) {
        delete item.emailMetadata.headers;
      }
      
      return {
        ...item,
        isDirectMessage: !item.client,
      };
    });

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

// GET /assignment-messages/:id/attachment/:attId
// Streams an inbound-email attachment that is stored as a base64 data URI on
// the message document. Thread responses replace those URIs with this URL so
// the thread JSON stays small; the file is only transferred when downloaded.
exports.downloadInlineAttachment = async function downloadInlineAttachment(
  req,
  res
) {
  try {
    const { id, attId } = req.params;
    if (!isObjId(id)) {
      return res.status(400).json({ error: "Invalid message id" });
    }

    // Same visibility rules as reading the thread itself.
    const visibleQuery = await applyVisibility({ _id: oid(id) }, req);
    const msg = await AssignmentMessage.findOne(visibleQuery)
      .select("attachments")
      .lean();
    if (!msg) {
      return res.status(404).json({ error: "Message not found" });
    }

    const att = (msg.attachments || []).find(
      (a) => String(a._id) === String(attId)
    );
    if (!att || typeof att.url !== "string") {
      return res.status(404).json({ error: "Attachment not found" });
    }

    if (att.url.startsWith("data:")) {
      const comma = att.url.indexOf(",");
      const meta = comma > 5 ? att.url.slice(5, comma) : "";
      const mime =
        (meta.split(";")[0] || att.mimetype || "application/octet-stream").trim() ||
        "application/octet-stream";
      const buf = Buffer.from(att.url.slice(comma + 1), "base64");
      const name = encodeURIComponent(
        att.originalName || att.filename || "attachment"
      );
      res.set({
        "Content-Type": mime,
        "Content-Length": String(buf.length),
        "Content-Disposition": `attachment; filename="${name}"; filename*=UTF-8''${name}`,
        "Cache-Control": "private, max-age=86400",
      });
      return res.send(buf);
    }

    // Uploaded-file attachments keep their static/absolute URL — redirect.
    return res.redirect(att.url);
  } catch (e) {
    console.error("Error in downloadInlineAttachment:", e);
    res.status(500).json({ error: "Failed to download attachment" });
  }
};
exports.getMessageCounts = async function getMessageCounts(req, res) {
  try {
    const currentUser = req.employee?._id;
    const owner = req.employee?.owner;

    if (!isObjId(currentUser) || !isObjId(owner)) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    // ── Per-category unread (for the Gmail-style sidebar badges) ───────────
    // external = client mail, internal = no client, review = activity from my
    // hierarchy juniors. "unread" = I'm a receiver and haven't read it.
    const currentUserRole = normalizeRole(req.employee?.role || "");
    const isOwner = currentUserRole === "owner";
    const juniorIdStrings = await getCachedJuniors(
      oid(String(owner)),
      oid(String(currentUser)),
    );
    const juniorIds = juniorIdStrings.filter(isObjId).map((id) => oid(id));

    const baseUnread = {
      status: "sent",
      // Forwarded copies are excluded from every list, so counting them here
      // would leave a badge that no list can ever account for.
      isForwardedCopy: { $ne: true },
      // PER USER: exclude only what THIS user binned / marked as spam.
      trashedBy: { $ne: currentUser },
      spamReporters: { $ne: currentUser },
      "readBy.employee": { $ne: currentUser },
    };

    // Primary-inbox client scoping must match listMessages: outside the CRM
    // app (no scope=crm), client mail only counts for MY assigned clients.
    const isCrmScope = String(req.query.scope || "") === "crm";
    let inboxClientScope = null;
    let assignedClientIds = [];
    if (!isCrmScope) {
      // Strictly assignedTo — matches the Primary list (supervisedBy would
      // count every downline client's mail for hierarchy seniors).
      const myAssignedClients = await ClientInfo.find({
        owner,
        assignedTo: currentUser,
      })
        .select("_id")
        .lean();
      assignedClientIds = myAssignedClients.map((c) => c._id);
      inboxClientScope = {
        $or: [
          { client: { $exists: false } },
          { client: null },
          ...(assignedClientIds.length > 0
            ? [{ client: { $in: assignedClientIds } }]
            : []),
        ],
      };
    }
    const receiverOr = [
      { receiver: currentUser },
      { receiver: { $in: [currentUser] } },
    ];
    const countUnreadThreads = async (query) => {
      const result = await AssignmentMessage.aggregate([
        { $match: query },
        { $group: { _id: { $ifNull: ["$threadId", { $toString: "$_id" }] } } },
        { $count: "count" },
      ]);
      return result[0]?.count || 0;
    };

    // Primary-inbox unread that mirrors what the LIST actually bolds: the list
    // shows ONE row per thread (its latest message) and marks it unread only
    // when that latest message is addressed to me and I haven't read it. The
    // old "any unread message in the thread" count left the badge stuck at a
    // phantom number when an old unread message sat under a newer message I had
    // already read or sent myself (I'd never re-open a thread that doesn't look
    // unread, so it never cleared). This counts by the thread's ABSOLUTE latest
    // message instead.
    const meId = oid(String(currentUser));
    const countInboxUnreadByLatest = async () => {
      const latestMatch = {
        $and: [
          { latestReceiver: meId }, // I'm a receiver of the latest message
          { latestSender: { $ne: meId } }, // …and it isn't my own message
          { latestReadBy: { $ne: meId } }, // …and I haven't read it
          { latestTrashedBy: { $ne: meId } },
          { latestSpam: { $ne: meId } },
          {
            $or: [
              { latestApprover: { $ne: meId } },
              { latestIntended: meId },
            ],
          },
        ],
      };
      // Non-CRM apps: client mail only counts for my assigned clients (mirrors
      // inboxClientScope, remapped onto the grouped `latestClient`).
      if (inboxClientScope) {
        latestMatch.$and.push({
          $or: [
            { latestClient: null },
            ...(assignedClientIds.length > 0
              ? [{ latestClient: { $in: assignedClientIds } }]
              : []),
          ],
        });
      }
      const result = await AssignmentMessage.aggregate([
        {
          $match: {
            owner: oid(String(owner)),
            status: "sent",
            approvalStatus: { $ne: "pending" },
            // Their own tab, their own badge — see systemAnnouncements below.
            isSystemAnnouncement: { $ne: true },
          },
        },
        { $sort: { createdAt: -1 } },
        {
          $group: {
            _id: { $ifNull: ["$threadId", { $toString: "$_id" }] },
            latestSender: { $first: "$sender" },
            latestReceiver: { $first: "$receiver" },
            latestReadBy: { $first: { $ifNull: ["$readBy.employee", []] } },
            latestClient: { $first: "$client" },
            latestTrashedBy: { $first: { $ifNull: ["$trashedBy", []] } },
            latestSpam: { $first: { $ifNull: ["$spamReporters", []] } },
            latestApprover: {
              $first: { $ifNull: ["$approvalChain.approver", []] },
            },
            latestIntended: { $first: { $ifNull: ["$intendedRecipients", []] } },
          },
        },
        { $match: latestMatch },
        { $count: "count" },
      ]);
      return result[0]?.count || 0;
    };

    // Review (All Activity): unread EXTERNAL (client) messages authored by my
    // juniors (owners see the whole org), plus inbound client mail delivered
    // to juniors (unresponded client emails). Excludes my own messages.
    // NOTE: no readBy filter here — the badge must match the list's bold rows,
    // which are threads whose LATEST message is unread by me (an old unread
    // message buried in a read thread must not keep the thread counted).
    const externalOnly = { client: { $exists: true, $ne: null } };
    const baseVisible = {
      status: "sent",
      trashedBy: { $ne: currentUser },
      spamReporters: { $ne: currentUser },
    };
    let reviewQuery = { _id: null };
    if (isOwner) {
      reviewQuery = { owner, sender: { $ne: currentUser }, ...externalOnly, ...baseVisible };
    } else if (juniorIds.length > 0) {
      reviewQuery = {
        $or: [
          { sender: { $in: juniorIds } },
          // Client-authored mail delivered to my juniors (inbound OR manual
          // isFromClient compose) — must match the review list visibility.
          {
            receiver: { $in: juniorIds },
            $or: [{ senderType: "client" }, { isFromClient: true }],
          },
        ],
        ...externalOnly,
        ...baseVisible,
      };
    }

    // Threads whose latest (visible) message is unread by me — mirrors the
    // list's per-thread bold state instead of "any unread message ever".
    const countUnreadLatestThreads = async (query) => {
      if (query._id === null) return 0;
      const result = await AssignmentMessage.aggregate([
        { $match: query },
        { $sort: { createdAt: -1 } },
        {
          $group: {
            _id: { $ifNull: ["$threadId", { $toString: "$_id" }] },
            latestReadBy: { $first: "$readBy" },
          },
        },
        { $match: { "latestReadBy.employee": { $ne: oid(String(currentUser)) } } },
        { $count: "count" },
      ]);
      return result[0]?.count || 0;
    };

    // Get counts for different categories
    const [
      inboxCount,
      unreadCount,
      starredCount,
      sentCount,
      draftCount,
      scheduledCount,
      spamCount,
      trashCount,
      externalUnread,
      internalUnread,
      reviewUnread,
      supervisionPending,
      systemAnnouncementsUnread,
    ] = await Promise.all([
      // Inbox: messages where user is receiver, not in THEIR bin/spam, status sent.
      // Pending items are supervision work (receiver = current approver) and
      // live in the For-approval filter, not the inbox; messages I only
      // touched as an approver don't count either.
      AssignmentMessage.countDocuments({
        $and: [
          { $or: [{ receiver: currentUser }, { receiver: { $in: [currentUser] } }] },
          {
            $or: [
              { "approvalChain.approver": { $ne: currentUser } },
              { intendedRecipients: currentUser },
            ],
          },
          ...(inboxClientScope ? [inboxClientScope] : []),
        ],
        // My OWN messages are never in my inbox (the list uses isReceiver &&
        // !isSender). Supervision $addToSet / CC-sync can add me as a receiver
        // of a message I sent, which otherwise leaked into this count.
        sender: { $ne: currentUser },
        status: "sent",
        approvalStatus: { $ne: "pending" },
        trashedBy: { $ne: currentUser },
        spamReporters: { $ne: currentUser },
        // Not in the list (see the list queries), so not in the count either.
        isForwardedCopy: { $ne: true },
        isSystemAnnouncement: { $ne: true },
      }),

      // Unread: Primary-inbox threads whose LATEST message is unread & addressed
      // to me — mirrors the list's per-thread bold state (see helper above).
      countInboxUnreadByLatest(),

      // Starred: messages starred by current user
      AssignmentMessage.countDocuments({
        starredBy: currentUser,
        trashedBy: { $ne: currentUser },
      }),

      // Sent: messages where user is sender, status sent
      AssignmentMessage.countDocuments({
        sender: currentUser,
        status: "sent",
        trashedBy: { $ne: currentUser },
      }),

      // Drafts: draft messages by current user
      AssignmentMessage.countDocuments({
        sender: currentUser,
        status: "draft",
        trashedBy: { $ne: currentUser },
      }),

      // Scheduled: scheduled messages by current user
      AssignmentMessage.countDocuments({
        sender: currentUser,
        status: "scheduled",
        trashedBy: { $ne: currentUser },
      }),

      // Spam: messages THIS user marked as spam
      AssignmentMessage.countDocuments({
        spamReporters: currentUser,
      }),

      // Trash: messages THIS user moved to their Bin
      AssignmentMessage.countDocuments({
        trashedBy: currentUser,
      }),

      // External Inbox unread: client threads where I'm a receiver and haven't
      // read. Pending items live in For-approval, not the Client Box.
      countUnreadThreads({
        $or: receiverOr,
        client: { $exists: true, $ne: null },
        approvalStatus: { $ne: "pending" },
        ...baseUnread,
      }),

      // TeamBox (internal) unread: non-client threads where I'm a receiver,
      // unread. Announcements are non-client mail but live in their own tab.
      countUnreadThreads({
        $and: [
          { $or: receiverOr },
          { $or: [{ client: { $exists: false } }, { client: null }] },
        ],
        isSystemAnnouncement: { $ne: true },
        ...baseUnread,
      }),

      // All Activity (review): threads whose latest message is unread by me
      countUnreadLatestThreads(reviewQuery),

      // For-approval: threads with messages pending MY approval (I'm the
      // current approver in the chain and haven't actioned them yet).
      //
      // Nobody below me in the hierarchy means nothing can be waiting on my
      // approval — approvals only ever travel upward from a junior — so the
      // whole query is skipped rather than counting mail that merely landed in
      // my inbox. Mirrors the same rule in getTeamLeadPendingApprovals.
      juniorIds.length === 0
        ? Promise.resolve(0)
        : countUnreadThreads({
            owner,
            receiver: currentUser,
            approvalStatus: "pending",
            "approvalChain.approver": { $ne: currentUser },
            trashedBy: { $ne: currentUser },
            spamReporters: { $ne: currentUser },
            // Never my own message: a reply carries its sender in the receiver
            // array as a thread participant, so without this my own message
            // awaiting SOMEONE ELSE's approval sat in my approval badge.
            sender: { $ne: currentUser },
          }),

      // NOTE: a "myPending" count (threads I SENT that are awaiting someone
      // else's approval) used to be computed here and drove the Mail rail
      // badge. It was removed: it is not an approval queue — there is nothing
      // the viewer can do about those messages, and the number never cleared
      // from their own badge. The only approval count is `supervision` above.

      // System Announcements: unread notices addressed to me. Counted per
      // MESSAGE, not per thread — each one records a separate event.
      AssignmentMessage.countDocuments({
        owner,
        status: "sent",
        $or: [{ isSystemAnnouncement: true }, { isSystemMessage: true }],
        $and: [{ $or: [{ receiver: currentUser }, { bccReceiver: currentUser }] }],
        "readBy.employee": { $ne: currentUser },
        trashedBy: { $ne: currentUser },
        spamReporters: { $ne: currentUser },
      }),
    ]);

    const payload = {
      inbox: inboxCount,
      unread: unreadCount,
      starred: starredCount,
      sent: sentCount,
      draft: draftCount,
      scheduled: scheduledCount,
      spam: spamCount,
      trash: trashCount,
      archive: 0,
      external: externalUnread,
      internal: internalUnread,
      review: reviewUnread,
      supervision: supervisionPending,
      systemAnnouncements: systemAnnouncementsUnread,
    };
    res.set("Cache-Control", "no-store");
    res.json(payload);
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
          { path: "receiver", select: "name companyEmail email role designation" },
          { path: "client", select: "_id clientName legalBusinessName dba assignedTo" },
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
// GET /assignment-messages/has-juniors — lightweight check for Activity tab visibility
exports.hasJuniors = async function hasJuniors(req, res) {
  try {
    const me = req.employee?._id;
    const ownerId = req.employee?.owner;
    if (!me || !ownerId) return res.json({ hasJuniors: false });

    const currentUserRole = normalizeRole(req.employee?.role || "");

    // Owners always have org-wide activity access
    if (currentUserRole === "owner") {
      return res.json({ hasJuniors: true });
    }

    // Everyone else (including managers) must have an actual hierarchy junior entry
    const link = await EmployeeHierarchy.findOne({
      owner: oid(String(ownerId)),
      senior: oid(String(me)),
    })
      .select("_id")
      .lean();

    res.json({ hasJuniors: !!link });
  } catch (e) {
    console.error("hasJuniors error:", e);
    res.json({ hasJuniors: false });
  }
};

// GET /assignment-messages/my-juniors — all hierarchy junior ids of the
// current user (used by EmailDetail to gate pre-approval actions: an upline
// senior can approve a message pending at a lower level of their own chain).
exports.getMyJuniors = async function getMyJuniors(req, res) {
  try {
    const me = req.employee?._id;
    const ownerId = req.employee?.owner;
    if (!isObjId(me) || !isObjId(ownerId)) return res.json({ juniorIds: [] });

    const juniorIds = await getCachedJuniors(oid(String(ownerId)), oid(String(me)));
    res.json({ juniorIds });
  } catch (e) {
    console.error("getMyJuniors error:", e);
    res.json({ juniorIds: [] });
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
        .select("-emailMetadata.headers")
        .populate([
          { path: "owner", select: "_id name companyEmail" },
          { path: "sender", select: "_id name companyEmail role designation" },
          { path: "receiver", select: "_id name companyEmail email role designation" },
          { path: "client", select: "_id clientName legalBusinessName dba assignedTo" },
          { path: "attachments.uploadedBy", select: "_id name companyEmail" },
          { path: "scheduledBy", select: "_id name companyEmail" },
          { path: "starredBy", select: "_id name companyEmail" }, // Populate who starred it
        ])
        .lean(),
      AssignmentMessage.countDocuments(qFinal),
    ]);

    res.json({
      items: items.map(slimListMessage),
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

    // PER USER: only show messages THIS user moved to the Bin (others who can
    // see the message keep it in their normal inbox).
    const q = {
      trashedBy: currentUser,
    };

    // Add client filter if provided
    if (client && mongoose.isValidObjectId(client)) {
      q.client = client;
    }
    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 1000);
    const populateFields = [
      { path: "sender", select: "_id name companyEmail" },
      { path: "receiver", select: "_id name companyEmail email role designation" },
      { path: "client", select: "_id clientName legalBusinessName dba assignedTo" },
      { path: "trashedBy", select: "_id name companyEmail" },
    ];

    const items = await AssignmentMessage.find(q)
      .sort({ trashedAt: -1, updatedAt: -1 })
      .skip((pageNum - 1) * lim)
      .limit(lim)
      .select("-emailMetadata.headers")
      .populate(populateFields)
      .lean();

    const total = await AssignmentMessage.countDocuments(q);
    // Ensure receiver is always treated as array for consistency
    const normalizedItems = items.map((item) => ({
      ...slimListMessage(item),
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
  // ⛔ SPAM FEATURE DISABLED — always return an empty list.
  const { limit = 50, page = 1 } = req.query;
  return res.json({
    items: [],
    total: 0,
    page: Number(page) || 1,
    pages: 0,
    limit: Number(limit) || 50,
  });
};

// eslint-disable-next-line no-unused-vars
async function _getSpamMessages_disabled(req, res) {
  try {
    const { client, owner, limit = 50, page = 1 } = req.query;

    const currentUser = req.employee?._id;
    if (!isObjId(currentUser)) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    // Build base query for spam messages — PER USER: only show messages that
    // THIS user reported as spam (not every employee who can see the message).
    const q = {
      spamReporters: currentUser,
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
          .select("-emailMetadata.headers")
          .populate([
            { path: "owner", select: "_id name companyEmail" },
            { path: "sender", select: "_id name companyEmail role designation" },
            { path: "receiver", select: "_id name companyEmail email role designation" },
            { path: "client", select: "_id clientName legalBusinessName dba assignedTo" },
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
      items: (items || []).map(slimListMessage),
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
      participantEmail,
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

    const parsedSearch = parseGmailStyleSearch(searchQuery || "");
    const effectiveSearchQuery = parsedSearch.text;

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

    if (parsedSearch.scope === "drafts" || parsedSearch.scope === "draft") {
      q.status = "draft";
      q.isScheduled = false;
      if (req.employee?._id) q.sender = req.employee._id;
    } else if (parsedSearch.scope === "sent") {
      q.status = "sent";
      if (req.employee?._id) q.sender = req.employee._id;
    } else if (parsedSearch.scope === "inbox") {
      q.status = "sent";
      if (req.employee?._id) q.receiver = req.employee._id;
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

    // ✅ Trash/Spam filters — PER USER (only what THIS user binned / marked spam)
    const _meSearch = req.employee?._id;
    const searchScope = parsedSearch.scope;
    if (searchScope === "trash" || searchScope === "bin") {
      q.trashedBy = _meSearch;
    } else if (searchScope === "spam") {
      q.spamReporters = _meSearch;
    } else if (isTrashed === "true" || isTrashed === true) {
      q.trashedBy = _meSearch;
    } else if (isSpam === "true" || isSpam === true) {
      q.spamReporters = _meSearch;
    } else if (
      searchScope !== "anywhere" &&
      isTrashed === "false" &&
      isSpam === "false"
    ) {
      // Default: exclude this user's own trash and spam from normal searches
      q.trashedBy = { $ne: _meSearch };
      q.spamReporters = { $ne: _meSearch };
    }

    // ✅ Starred filter
    if (starred === "true" && req.employee?._id) {
      q.starredBy = req.employee._id;
    }

    // ✅ Attachment filter
    if (parsedSearch.hasAttachments === true || hasAttachments === "true") {
      q["attachments.0"] = { $exists: true };
    } else if (hasAttachments === "false") {
      q.attachments = { $size: 0 };
    }

    // ✅ Date range filter
    const dateFilter = {};
    if (parsedSearch.dateFrom || dateFrom) {
      const fromDate = parsedSearch.dateFrom || new Date(dateFrom);
      if (!isNaN(fromDate)) dateFilter.$gte = fromDate;
    }
    if (parsedSearch.dateTo || dateTo) {
      const toDate = parsedSearch.dateTo || new Date(dateTo);
      if (!isNaN(toDate)) {
        if (parsedSearch.dateTo) dateFilter.$lt = toDate;
        else dateFilter.$lte = toDate;
      }
    }
    if (Object.keys(dateFilter).length) {
      // Received/synced emails retain their real message date in
      // emailMetadata.date. createdAt is only the time the local record was
      // inserted, which can be much later and made Gmail-style date searches
      // return the wrong results. Outbound/manual records fall back to sentAt
      // and then createdAt.
      const messageDateExpression = {
        $ifNull: [
          "$emailMetadata.date",
          { $ifNull: ["$sentAt", "$createdAt"] },
        ],
      };
      const dateComparisons = [];
      if (dateFilter.$gte) {
        dateComparisons.push({ $gte: [messageDateExpression, dateFilter.$gte] });
      }
      if (dateFilter.$lte) {
        dateComparisons.push({ $lte: [messageDateExpression, dateFilter.$lte] });
      }
      if (dateFilter.$lt) {
        dateComparisons.push({ $lt: [messageDateExpression, dateFilter.$lt] });
      }
      q.$and = q.$and || [];
      q.$and.push({
        $expr:
          dateComparisons.length === 1
            ? dateComparisons[0]
            : { $and: dateComparisons },
      });
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

    const addAndCondition = (condition) => {
      qFinal.$and = qFinal.$and || [];
      qFinal.$and.push(condition);
    };

    // A client's own address (as opposed to a "company employee" sub-contact,
    // which IS stored per-message via clientEmployeeEmail) is never stored as
    // text on the message — only as the `client` ObjectId reference. Every
    // message in that client's thread carries it regardless of send
    // direction, so resolving the term against ClientInfo and matching
    // `client` is what actually finds a client's sent+received history;
    // without this, from:/to:/participantEmail search for a client's email
    // silently returns nothing.
    const resolveClientIds = async (value) => {
      const term = String(value || "").trim();
      if (!term) return [];
      const pattern = new RegExp(escapeSearchRegex(term), "i");
      const clientQuery = {
        $or: [
          { clientEmail: pattern },
          { "businesses.email": pattern },
          { clientName: pattern },
          { legalBusinessName: pattern },
          { dba: pattern },
          { "companyEmployees.email": pattern },
          { "companyEmployees.name": pattern },
        ],
      };
      if (req.employee?.owner) clientQuery.owner = req.employee.owner;
      const clients = await ClientInfo.find(clientQuery)
        .select("_id")
        .limit(50)
        .lean();
      return clients.map((c) => c._id);
    };

    const resolveEmployeeIds = async (value) => {
      const term = String(value || "").trim();
      if (!term) return [];
      const pattern = new RegExp(escapeSearchRegex(term), "i");
      const employeeQuery = {
        $or: [
          { companyEmail: pattern },
          { email: pattern },
          { name: pattern },
        ],
      };
      if (qFinal.owner) employeeQuery.owner = qFinal.owner;
      const employees = await Employee.find(employeeQuery)
        .select("_id")
        .limit(50)
        .lean();
      return employees.map((e) => e._id);
    };

    const resolveEmployeeClauses = async (values, direction) => {
      const clauses = [];
      const individualValues = values.flatMap((rawValue) =>
        String(rawValue || "").split(","),
      );
      for (const rawValue of individualValues) {
        const value = String(rawValue || "").trim();
        if (!value) continue;
        const pattern = new RegExp(escapeSearchRegex(value), "i");
        const employeeQuery = {
          $or: [
            { companyEmail: pattern },
            { email: pattern },
            { name: pattern },
          ],
        };
        if (qFinal.owner) employeeQuery.owner = qFinal.owner;
        const [employeeIds, clientIds] = await Promise.all([
          Employee.find(employeeQuery).select("_id").limit(50).lean(),
          resolveClientIds(value),
        ]);
        const ids = employeeIds.map((employee) => employee._id);

        if (clientIds.length) clauses.push({ client: { $in: clientIds } });

        if (direction === "from") {
          if (ids.length) clauses.push({ sender: { $in: ids } });
          clauses.push(
            { clientEmployeeEmail: pattern },
            { clientEmployeeName: pattern },
            { "emailMetadata.from": pattern },
            { "emailMetadata.fromName": pattern },
          );
        } else {
          if (ids.length) clauses.push({ receiver: { $in: ids } });
          clauses.push({ "emailMetadata.to": pattern });
        }
      }
      return clauses;
    };

    if (parsedSearch.from.length) {
      const fromClauses = await resolveEmployeeClauses(parsedSearch.from, "from");
      if (fromClauses.length) addAndCondition({ $or: fromClauses });
    }
    if (parsedSearch.to.length) {
      const toClauses = await resolveEmployeeClauses(parsedSearch.to, "to");
      if (toClauses.length) addAndCondition({ $or: toClauses });
    }
    if (parsedSearch.subject) {
      const subjectWords = parsedSearch.subject.split(/\s+/).filter(Boolean);
      addAndCondition({
        $and: subjectWords.map((word) => ({
          subject: { $regex: escapeSearchRegex(word), $options: "i" },
        })),
      });
    }
    if (parsedSearch.filename) {
      const filenameWords = parsedSearch.filename.split(/\s+/).filter(Boolean);
      addAndCondition({
        $and: filenameWords.map((word) => ({
          "attachments.originalName": { $regex: escapeSearchRegex(word), $options: "i" },
        })),
      });
    }
    if (parsedSearch.unread === true && currentEmployeeId) {
      addAndCondition({ "readBy.employee": { $ne: currentEmployeeId } });
    } else if (parsedSearch.unread === false && currentEmployeeId) {
      addAndCondition({ "readBy.employee": currentEmployeeId });
    }
    if (parsedSearch.largerThan !== null) {
      addAndCondition({
        $expr: {
          $gt: [
            { $sum: { $ifNull: ["$attachments.size", []] } },
            parsedSearch.largerThan,
          ],
        },
      });
    }
    if (parsedSearch.smallerThan !== null) {
      addAndCondition({
        $expr: {
          $lt: [
            { $sum: { $ifNull: ["$attachments.size", []] } },
            parsedSearch.smallerThan,
          ],
        },
      });
    }
    if (parsedSearch.excluded.length) {
      const excludedFields = [
        "subject",
        "note",
        "clientName",
        "clientEmployeeName",
        "clientEmployeeEmail",
        "emailMetadata.from",
        "emailMetadata.fromName",
        "emailMetadata.to",
        "emailMetadata.cc",
        "emailMetadata.bcc",
        "attachments.originalName",
      ];
      parsedSearch.excluded.forEach((value) => {
        const pattern = new RegExp(escapeSearchRegex(value), "i");
        addAndCondition({
          $nor: excludedFields.map((field) => ({ [field]: pattern })),
        });
      });
    }

    // Match every message where a selected person participated, regardless of
    // whether they were the sender, a direct recipient, CC, or BCC.
    if (participantEmail && participantEmail.trim()) {
      const escapeParticipantRegex = (s) =>
        s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const participantTerm = participantEmail.trim();
      const participantPattern = new RegExp(
        escapeParticipantRegex(participantTerm),
        "i",
      );
      const [participantClientIds, participantEmployeeIds] = await Promise.all([
        resolveClientIds(participantTerm),
        resolveEmployeeIds(participantTerm),
      ]);
      qFinal.$and = qFinal.$and || [];
      qFinal.$and.push({
        $or: [
          { clientEmployeeEmail: participantPattern },
          { "emailMetadata.from": participantPattern },
          { "emailMetadata.to": participantPattern },
          { "emailMetadata.cc": participantPattern },
          { "emailMetadata.bcc": participantPattern },
          { "cc.email": participantPattern },
          ...(participantClientIds.length
            ? [{ client: { $in: participantClientIds } }]
            : []),
          ...(participantEmployeeIds.length
            ? [
                { sender: { $in: participantEmployeeIds } },
                { receiver: { $in: participantEmployeeIds } },
              ]
            : []),
        ],
      });
    }

    // ✅ SEARCH LOGIC - Only add search conditions if searchQuery is provided
    if (effectiveSearchQuery) {
      const searchTerm = effectiveSearchQuery;
      const searchConditions = [];

      // Escape regex metacharacters
      const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const words = searchTerm.split(/\s+/).filter(Boolean).map(escapeRegex);
      const fieldMatchesAllWords = (field) => ({
        $and: words.map((w) => ({ [field]: { $regex: w, $options: "i" } })),
      });

      // Determine which fields to search in
      const searchFields = Array.isArray(searchIn) ? searchIn : [searchIn];

      // Text search in specified fields
      if (searchFields.includes("subject") || searchFields.includes("all")) {
        searchConditions.push(fieldMatchesAllWords("subject"));
      }

      if (searchFields.includes("note") || searchFields.includes("all")) {
        searchConditions.push(fieldMatchesAllWords("note"));
      }

      if (searchFields.includes("all")) {
        const [freeTextClientIds, freeTextEmployeeIds] = await Promise.all([
          resolveClientIds(searchTerm),
          resolveEmployeeIds(searchTerm),
        ]);
        if (freeTextClientIds.length) {
          searchConditions.push({ client: { $in: freeTextClientIds } });
        }
        if (freeTextEmployeeIds.length) {
          searchConditions.push({ sender: { $in: freeTextEmployeeIds } });
          searchConditions.push({ receiver: { $in: freeTextEmployeeIds } });
        }
        [
          "clientName",
          "clientEmployeeName",
          "clientEmployeeEmail",
          "emailMetadata.from",
          "emailMetadata.fromName",
          "emailMetadata.to",
          "emailMetadata.cc",
          "emailMetadata.bcc",
          "cc.name",
          "cc.email",
        ].forEach((field) => {
          searchConditions.push(fieldMatchesAllWords(field));
        });
      }

      // Search in attachment filenames
      if (
        searchFields.includes("attachments") ||
        searchFields.includes("all")
      ) {
        searchConditions.push(fieldMatchesAllWords("attachments.originalName"));
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
          { path: "sender", select: "_id name companyEmail role designation" },
          { path: "receiver", select: "_id name companyEmail email role designation" },
          { path: "client", select: "_id clientName legalBusinessName dba assignedTo" },
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
        participantEmail,
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
      // Drafts you have binned belong in the Bin, not in Drafts. Without this
      // they kept showing here after being moved, so selecting them again sent
      // the trash request for a thread the API had already binned — which
      // correctly answers 404, making the Bin look permanently broken.
      trashedBy: { $ne: sender },
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
        .select("-emailMetadata.headers")
        .populate([
          { path: "owner", select: "_id name companyEmail" },
          { path: "sender", select: "_id name companyEmail role designation" },
          { path: "receiver", select: "_id name companyEmail email role designation" },
          { path: "client", select: "_id clientName legalBusinessName dba assignedTo" },
          { path: "attachments.uploadedBy", select: "_id name companyEmail" },
        ])
        .lean(),
      AssignmentMessage.countDocuments(q),
    ]);

    res.json({
      items: items.map(slimListMessage),
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

// GET /api/assignment-messages/supervision - Pending messages from team members (juniors) to supervisor (senior)
// Shows pending approval messages sent by team members
exports.getSupervisionMessages = async function getSupervisionMessages(req, res) {
  try {
    const { page = 1, limit = 50, client, view } = req.query;
    const currentUserId = req.employee?._id;
    const ownerId = req.employee?.owner;

    if (!isObjId(currentUserId) || !isObjId(ownerId)) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    // "pre" = Pre approval tab: messages pending at a LOWER level of my chain
    // (the current approver is one of my juniors) — I can approve over them.
    const isPreApproval = String(view || "") === "pre";

    // Get all juniors (team members) under current user in the hierarchy
    const juniorIds = await getAllJuniorsRecursively(String(ownerId), String(currentUserId));

    // If no juniors, return empty list
    if (juniorIds.length === 0) {
      return res.json({
        items: [],
        total: 0,
        page: 1,
        pages: 0,
        limit,
      });
    }

    const juniorObjIds = juniorIds.map(id => new mongoose.Types.ObjectId(id));

    // Approval-related messages sent FROM team members (juniors)
    const query = {
      owner: ownerId,
      sender: { $in: juniorObjIds }, // Messages from juniors
      trashedBy: { $ne: currentUserId },
      spamReporters: { $ne: currentUserId },
    };

    if (isPreApproval) {
      // Pending at one of MY juniors and not yet escalated to me.
      query.approvalStatus = "pending";
      query["approvalChain.approver"] = { $ne: currentUserId };
      query.receiver = { $in: juniorObjIds, $nin: [currentUserId] };
    } else {
      // My approval = ONLY work currently pending at ME. Once I approve or
      // disapprove, the row leaves this tab (approved mail is then visible in
      // All activity); the tab stays empty until a new message escalates to me.
      query.approvalStatus = "pending";
      query.receiver = currentUserId;
      query["approvalChain.approver"] = { $ne: currentUserId };
    }

    // Apply client filter if provided
    if (isObjId(client)) {
      query.client = client;
    }

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 100);

    const populateFields = [
      { path: "owner", select: "_id name companyEmail" },
      { path: "sender", select: "_id name companyEmail role designation supervisionMode" },
      { path: "receiver", select: "_id name companyEmail email role designation" },
      { path: "client", select: "_id clientName legalBusinessName dba assignedTo" },
      { path: "approvalChain.approver", select: "_id name companyEmail role designation" },
      { path: "approvedBy", select: "_id name companyEmail role designation" },
      { path: "disapprovedBy", select: "_id name companyEmail role designation" },
      { path: "readBy.employee", select: "_id name companyEmail" },
      { path: "starredBy", select: "_id name companyEmail" },
      { path: "attachments.uploadedBy", select: "_id name companyEmail" },
    ];

    // Paginate by THREAD, not by raw message. Otherwise a page can contain
    // several messages from the same thread and the UI either shows duplicates
    // or collapses them into fewer than 50 rows.
    const matching = await AssignmentMessage.find(query)
      .sort({ createdAt: -1 })
      .select("_id threadId createdAt approvalStatus subject")
      .lean();

    const threadGroups = [];
    const threadMap = new Map();

    matching.forEach((message) => {
      const threadId = message.threadId || `single_${message._id}`;
      if (!threadMap.has(threadId)) {
        const group = {
          threadId,
          latestId: message._id,
          latestMessageAt: message.createdAt,
          totalMessages: 0,
          pendingMessages: 0,
        };
        threadMap.set(threadId, group);
        threadGroups.push(group);
      }

      const group = threadMap.get(threadId);
      group.totalMessages += 1;
      // Newest-first, so the last write wins = the mail that started the
      // thread. That is the conversation's name (see rootSubject above).
      group.rootSubject = message.subject;
      if ((message.approvalStatus || "pending") === "pending") {
        group.pendingMessages += 1;
      }
    });

    const total = threadGroups.length;
    const pageGroups = threadGroups.slice((pageNum - 1) * lim, pageNum * lim);
    const latestIds = pageGroups.map((group) => group.latestId);

    const pageItems = latestIds.length
      ? await AssignmentMessage.find({ _id: { $in: latestIds } })
        .populate(populateFields)
        .lean()
      : [];

    const itemMap = new Map(pageItems.map((item) => [String(item._id), item]));
    const items = pageGroups
      .map((group) => {
        const item = itemMap.get(String(group.latestId));
        if (!item) return null;
        return {
          ...item,
          threadMessageCount: group.totalMessages,
          threadPendingCount: group.pendingMessages,
          threadSubject: group.rootSubject || item.subject,
        };
      })
      .filter(Boolean);

    res.json({
      items: items.map(slimListMessage),
      total,
      page: pageNum,
      pages: Math.ceil(total / lim),
      limit: lim,
      juniorCount: juniorIds.length,
    });
  } catch (e) {
    console.error("Error in getSupervisionMessages:", e);
    res.status(500).json({ error: "Failed to fetch supervision messages" });
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
      // Match listDrafts — a binned draft must not keep counting here.
      trashedBy: { $ne: sender },
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

      // No role shortcut here on purpose. This used to let anyone whose role
      // string said "manager"/"owner" through even with an empty hierarchy,
      // which is how employees with no juniors ended up with a pending-approval
      // badge. Eligibility is the hierarchy itself — see the isSenior check.
      const currentUserId = req.employee?._id;
      const ownerId = req.employee?.owner;

      if (!isObjId(currentUserId) || !isObjId(ownerId)) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      // 🔥 HIERARCHY-BASED: Get all juniors recursively for this supervisor
      const supervisedEmployeeIds = await getCachedJuniors(ownerId, currentUserId);

      // Access is hierarchy-based (not role-based): anyone who is a senior to at
      // least one other employee can view pending approvals for their juniors.
      const isSenior = Array.isArray(supervisedEmployeeIds) && supervisedEmployeeIds.length > 0;

      // Nobody below you in the hierarchy means nothing can be waiting on your
      // approval — approvals only ever travel upward from a junior. This holds
      // regardless of role: a manager with an empty hierarchy approves nothing,
      // so the badge must read zero rather than counting mail that merely landed
      // in their inbox.
      //
      // Answered as an empty result rather than the old 403: every app polls
      // this for a sidebar badge, and a 403 there is not an error worth logging
      // in six consoles — the honest answer is "you have none".
      if (!isSenior) {
        return res.json({
          success: true,
          items: [],
          threads: [],
          messages: [],
          total: 0,
          totalCount: 0,
          page: 1,
          pages: 0,
          limit: Math.min(Math.max(parseInt(limit, 10) || 50, 1), 100),
          statistics: {
            totalThreads: 0,
            totalMessages: 0,
            pendingMessages: 0,
            directMessages: 0,
            clientMessages: 0,
            uniqueSenders: 0,
          },
          debug: { supervisedEmployeesCount: 0, reason: "no juniors in hierarchy" },
        });
      }

      // Base query: Get pending messages
      // Managers see everything for their owner
      // Team leads see where they are receiver OR sender is a junior
      const query = {
        owner: ownerId,
        approvalStatus: "pending",
        trashedBy: { $ne: currentUserId },
        spamReporters: { $ne: currentUserId },
        // 🔥 Exclude messages I've already approved. They may still be "pending"
        // for the next approver in the chain, but they should no longer count
        // toward MY pending-approvals badge or list.
        "approvalChain.approver": { $ne: currentUserId },
        // 🔥 Only count messages currently escalated to ME (I'm the current
        // approver/receiver). This keeps the badge in sync with the for-approval
        // list, which is participant-scoped — a message still pending at a lower
        // level in the chain isn't actionable (or even openable) by me yet.
        receiver: currentUserId,
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
            select: "_id name companyEmail role designation supervisionMode",
          },
          { path: "receiver", select: "_id name companyEmail email role designation" },
          { path: "client", select: "_id clientName legalBusinessName dba assignedTo" },
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
