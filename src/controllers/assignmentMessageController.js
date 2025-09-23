// controllers/assignmentMessageController.js
const AssignmentMessage = require("../models/AssignmentMessage");
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
  if (["teamlead", "team_lead", "team-lead", "lead"].includes(r))
    return "team_lead";
  if (r === "manager") return "manager";
  if (["employee", "staff", "associate"].includes(r)) return "employee";
  return r;
}

/** ---------- SIMPLE visibility: I sent it or I’m in receiver[] ---------- **/
async function applyVisibility(q, req) {
  if (!req.employee?._id) return q;

  const me = oid(String(req.employee._id));
  if (!me) return q;

  const andParts = [];
  if (q.$and) {
    andParts.push(...q.$and);
    delete q.$and;
  }
  if (q.$or) {
    andParts.push({ $or: q.$or });
    delete q.$or;
  }
  const base = Object.keys(q).length ? [q] : [];

  // receiver is an array; Mongo matches scalars against array elements automatically
  const visOr = [{ sender: me }, { receiver: me }];

  return { $and: [...base, ...andParts, { $or: visOr }] };
}

/** ---------- helpers: find TLs and Managers for an owner (no supervisor chain) ---------- **/
async function findTLsAndManagersByOwner(ownerId) {
  if (!isObjId(ownerId)) return { tls: [], managers: [], employees: [] };

  // Accept both stored forms of the role (“Team Lead” from your DB and normalized hint strings)
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

/** ----------------- CONTROLLERS ----------------- **/

// GET /api/assignment-messages
// Supports filtering by owner/client/sender/receiver/participant/between
exports.listMessages = async function listMessages(req, res) {
  try {
    const {
      client,
      sender,
      receiver,
      participant,
      owner,
      limit = 50,
      page = 1,
      between: betweenRaw,
    } = req.query;

    const q = {};

    // scope by owner (explicit or from session)
    if (isObjId(owner)) q.owner = owner;
    else if (req.employee?.owner) q.owner = req.employee.owner;

    if (isObjId(client)) q.client = client;

    // receiver is array in the schema; matching with a scalar still works
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

    if (!q.owner && !q.client && !q.sender && !q.receiver && !q.$or) {
      return res.status(400).json({
        error:
          "Provide at least one scope: owner, client, sender, receiver, or participant",
      });
    }

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);

    const qFinal = await applyVisibility(q, req);

    const [items, total] = await Promise.all([
      AssignmentMessage.find(qFinal)
        .sort({ createdAt: -1 })
        .skip((pageNum - 1) * lim)
        .limit(lim)
        .populate([
          { path: "owner", select: "_id name companyEmail" },
          { path: "sender", select: "_id name companyEmail role" },
          { path: "receiver", select: "_id name companyEmail role" }, // array
          { path: "client", select: "_id clientName" },
          { path: "attachments.uploadedBy", select: "_id name companyEmail" },
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
    res.status(500).json({ error: "Failed to fetch assignment messages" });
  }
};

// GET /api/assignment-messages/messages
// GET /api/assignment-messages/messages/:clientId
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
    if (isObjId(clientId)) q.client = clientId;

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

    if (!q.owner && !q.client && !q.sender && !q.receiver && !q.$or) {
      return res.status(400).json({
        error:
          "Provide at least one scope: clientId/client, owner, sender, receiver, or participant",
      });
    }

    const qFinal = await applyVisibility(q, req);

    const messages = await AssignmentMessage.find(qFinal)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate([
        { path: "owner", select: "_id name companyEmail" },
        { path: "sender", select: "_id name companyEmail role" },
        { path: "receiver", select: "_id name companyEmail role" }, // array
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
//     } = req.body;

//     const owner = ownerBody || req.employee?.owner;
//     const sender = senderBody || req.employee?._id;

//     if (!isObjId(owner) || !isObjId(client) || !isObjId(sender)) {
//       return res.status(400).json({
//         error: "owner, client, and sender are required (ObjectId strings)",
//       });
//     }

//     // Normalize incoming receivers
//     let receivers = [];
//     if (receiverBody) receivers = receivers.concat(normalizeIds(receiverBody));
//     if (receiversBody)
//       receivers = receivers.concat(normalizeIds(receiversBody));
//     receivers = receivers.filter((id) => id !== String(sender));

//     // Fetch sender details
//     const senderDoc = await Employee.findById(sender)
//       .select("_id role supervisor supervisionMode owner")
//       .lean();
//     const senderRole = normalizeRole(senderDoc?.role || "");

//     let approvalStatus;
//     const needsApproval =
//       String(senderDoc?.supervisionMode || "").toLowerCase() ===
//       "needs_approval";

//     if (needsApproval) {
//       approvalStatus = "pending";
//       // Only send to TLs at first
//       const { tls } = await findTLsAndManagersByOwner(owner);
//       receivers = [...tls];
//     }

//     // If still no receivers, fall back to role-based logic
//     if (receivers.length === 0) {
//       const { tls, managers } = await findTLsAndManagersByOwner(owner);

//       if (senderRole === "employee") {
//         receivers = [...tls]; // Employees always → TLs first
//         approvalStatus = "pending"; // always pending for employees
//       } else if (senderRole === "team_lead") {
//         receivers = [...managers]; // TLs → Managers
//       } else if (senderRole === "manager") {
//         receivers = [...tls]; // Managers → TLs
//       }
//     }

//     receivers = Array.from(new Set(receivers)).filter(
//       (id) => id !== String(sender)
//     );

//     if (receivers.length === 0) {
//       return res.status(400).json({ error: "No valid receivers found" });
//     }

//     const msg = await AssignmentMessage.create({
//       owner,
//       client,
//       sender,
//       receiver: receivers,
//       subject: subject || "",
//       note: note || "",
//       approvalStatus: approvalStatus || undefined,
//     });

//     const populated = await msg.populate([
//       { path: "owner", select: "_id name companyEmail" },
//       { path: "sender", select: "_id name companyEmail role" },
//       { path: "receiver", select: "_id name companyEmail role" },
//       { path: "client", select: "_id clientName" },
//     ]);

//     res.status(201).json(populated);
//   } catch (e) {
//     console.error(e);
//     res.status(500).json({ error: "Failed to create assignment message" });
//   }
// };

// Updated createMessage function in controllers/assignmentMessageController.js
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
//     } = req.body;

//     const owner = ownerBody || req.employee?.owner;
//     const sender = senderBody || req.employee?._id;

//     if (!isObjId(owner) || !isObjId(client) || !isObjId(sender)) {
//       return res.status(400).json({
//         error: "owner, client, and sender are required (ObjectId strings)",
//       });
//     }

//     // Normalize incoming receivers
//     let receivers = [];
//     if (receiverBody) receivers = receivers.concat(normalizeIds(receiverBody));
//     if (receiversBody)
//       receivers = receivers.concat(normalizeIds(receiversBody));
//     receivers = receivers.filter((id) => id !== String(sender));

//     // Fetch sender details
//     const senderDoc = await Employee.findById(sender)
//       .select("_id role supervisor supervisionMode owner")
//       .lean();
//     const senderRole = normalizeRole(senderDoc?.role || "");

//     let approvalStatus;
//     const supervisionMode = String(senderDoc?.supervisionMode || "").toLowerCase();
//     const needsApproval = supervisionMode === "needs_approval";
//     const isDirect = supervisionMode === "direct";

//     if (needsApproval) {
//       approvalStatus = "pending";
//       // Only send to TLs at first for approval
//       const { tls } = await findTLsAndManagersByOwner(owner);
//       receivers = [...tls];
//     } else if (isDirect) {
//       // Direct mode: send to both TLs and Managers
//       const { tls, managers } = await findTLsAndManagersByOwner(owner);
//       receivers = [...tls, ...managers];
//       approvalStatus = "approved"; // No approval needed in direct mode
//     }

//     // If still no receivers, fall back to role-based logic
//     if (receivers.length === 0) {
//       const { tls, managers } = await findTLsAndManagersByOwner(owner);

//       if (senderRole === "employee") {
//         if (isDirect) {
//           // Employee in direct mode → send to both TLs and Managers
//           receivers = [...tls, ...managers];
//           approvalStatus = "approved";
//         } else {
//           // Default employee behavior → TLs first (needs approval)
//           receivers = [...tls];
//           approvalStatus = "pending";
//         }
//       } else if (senderRole === "team_lead") {
//         if (isDirect) {
//           // Team Lead in direct mode → send to both TLs and Managers
//           receivers = [...tls, ...managers];
//           approvalStatus = "approved";
//         } else {
//           // Default TL behavior → Managers
//           receivers = [...managers];
//         }
//       } else if (senderRole === "manager") {
//         if (isDirect) {
//           // Manager in direct mode → send to both TLs and Managers
//           receivers = [...tls, ...managers];
//           approvalStatus = "approved";
//         } else {
//           // Default Manager behavior → TLs
//           receivers = [...tls];
//         }
//       }
//     }

//     receivers = Array.from(new Set(receivers)).filter(
//       (id) => id !== String(sender)
//     );

//     if (receivers.length === 0) {
//       return res.status(400).json({ error: "No valid receivers found" });
//     }

//     const msg = await AssignmentMessage.create({
//       owner,
//       client,
//       sender,
//       receiver: receivers,
//       subject: subject || "",
//       note: note || "",
//       approvalStatus: approvalStatus || undefined,
//     });

//     const populated = await msg.populate([
//       { path: "owner", select: "_id name companyEmail" },
//       { path: "sender", select: "_id name companyEmail role" },
//       { path: "receiver", select: "_id name companyEmail role" },
//       { path: "client", select: "_id clientName" },
//     ]);

//     res.status(201).json(populated);
//   } catch (e) {
//     console.error(e);
//     res.status(500).json({ error: "Failed to create assignment message" });
//   }
// };


// Updated createMessage function to include Team Lead as receiver
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
//     } = req.body;

//     const owner = ownerBody || req.employee?.owner;
//     const sender = senderBody || req.employee?._id;

//     if (!isObjId(owner) || !isObjId(client) || !isObjId(sender)) {
//       return res.status(400).json({
//         error: "owner, client, and sender are required (ObjectId strings)",
//       });
//     }

//     // Normalize incoming receivers
//     let receivers = [];
//     if (receiverBody) receivers = receivers.concat(normalizeIds(receiverBody));
//     if (receiversBody)
//       receivers = receivers.concat(normalizeIds(receiversBody));
//     receivers = receivers.filter((id) => id !== String(sender));

//     // Fetch sender details
//     const senderDoc = await Employee.findById(sender)
//       .select("_id role supervisor supervisionMode owner")
//       .lean();
//     const senderRole = normalizeRole(senderDoc?.role || "");

//     let approvalStatus;
//     const supervisionMode = String(senderDoc?.supervisionMode || "").toLowerCase();
//     const needsApproval = supervisionMode === "needs_approval";
//     const isDirect = supervisionMode === "direct";

//     // Get client info to find assigned employee
//     const Client = require("../models/ClientInfo"); // Make sure to import Client model
//     const clientDoc = await Client.findById(client)
//       .populate("assignedTo", "_id role")
//       .lean();

//     // Find Team Leads for this owner
//     const { tls } = await findTLsAndManagersByOwner(owner);

//     // Always include Team Leads as receivers for new messages
//     if (tls.length > 0) {
//       receivers = [...receivers, ...tls];
//     }

//     // If client has an assigned employee, include them as receiver
//     if (clientDoc && clientDoc.assignedTo && clientDoc.assignedTo._id) {
//       const assignedEmployeeId = String(clientDoc.assignedTo._id);
//       if (!receivers.includes(assignedEmployeeId) && assignedEmployeeId !== String(sender)) {
//         receivers.push(assignedEmployeeId);
//       }
//     }

//     if (needsApproval) {
//       approvalStatus = "pending";
//       // For needs_approval mode, ensure we only send to TLs initially
//       receivers = [...tls];
//     } else if (isDirect) {
//       // Direct mode: send to both TLs and Managers
//       const { managers } = await findTLsAndManagersByOwner(owner);
//       receivers = [...receivers, ...managers];
//       approvalStatus = "approved"; // No approval needed in direct mode
//     }

//     // If still no receivers, fall back to role-based logic
//     if (receivers.length === 0) {
//       const { tls, managers } = await findTLsAndManagersByOwner(owner);

//       if (senderRole === "employee") {
//         if (isDirect) {
//           // Employee in direct mode → send to both TLs and Managers
//           receivers = [...tls, ...managers];
//           approvalStatus = "approved";
//         } else {
//           // Default employee behavior → TLs first (needs approval)
//           receivers = [...tls];
//           approvalStatus = "pending";
//         }
//       } else if (senderRole === "team_lead") {
//         if (isDirect) {
//           // Team Lead in direct mode → send to both TLs and Managers
//           receivers = [...tls, ...managers];
//           approvalStatus = "approved";
//         } else {
//           // Default TL behavior → Managers
//           receivers = [...managers];
//         }
//       } else if (senderRole === "manager") {
//         if (isDirect) {
//           // Manager in direct mode → send to both TLs and Managers
//           receivers = [...tls, ...managers];
//           approvalStatus = "approved";
//         } else {
//           // Default Manager behavior → TLs
//           receivers = [...tls];
//         }
//       }
//     }

//     // Remove duplicates and exclude sender
//     receivers = Array.from(new Set(receivers)).filter(
//       (id) => id !== String(sender)
//     );

//     if (receivers.length === 0) {
//       return res.status(400).json({ error: "No valid receivers found" });
//     }

//     const msg = await AssignmentMessage.create({
//       owner,
//       client,
//       sender,
//       receiver: receivers,
//       subject: subject || "",
//       note: note || "",
//       approvalStatus: approvalStatus || undefined,
//     });

//     const populated = await msg.populate([
//       { path: "owner", select: "_id name companyEmail" },
//       { path: "sender", select: "_id name companyEmail role" },
//       { path: "receiver", select: "_id name companyEmail role" },
//       { path: "client", select: "_id clientName" },
//     ]);

//     res.status(201).json(populated);
//   } catch (e) {
//     console.error(e);
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
    if (receiversBody) receivers = receivers.concat(normalizeIds(receiversBody));
    receivers = receivers.filter((id) => id !== String(sender));

    const senderDoc = await Employee.findById(sender)
      .select("_id role supervisor supervisionMode owner")
      .lean();
    const senderRole = normalizeRole(senderDoc?.role || "");

    let approvalStatus;
    const supervisionMode = String(senderDoc?.supervisionMode || "").toLowerCase();
    const needsApproval = supervisionMode === "needs_approval";
    const isDirect = supervisionMode === "direct";

    const Client = require("../models/ClientInfo");
    const clientDoc = await Client.findById(client)
      .populate("assignedTo", "_id role")
      .lean();

    const { tls, managers } = await findTLsAndManagersByOwner(owner);

    // ✅ Always include Team Leads
    if (tls.length > 0) {
      receivers = [...receivers, ...tls.map((id) => String(id))];
    }

    // ✅ Always include assignedTo employee if present
    if (clientDoc && clientDoc.assignedTo && clientDoc.assignedTo._id) {
      const assignedEmployeeId = String(clientDoc.assignedTo._id);
      if (!receivers.includes(assignedEmployeeId) && assignedEmployeeId !== String(sender)) {
        receivers.push(assignedEmployeeId);
      }
    }

    // 🔑 Approval status logic
    if (senderRole === "manager") {
      // ✅ Manager messages are always approved
      approvalStatus = "approved";
    } else if (senderRole === "team_lead") {
      // ✅ Team Lead messages → assigned employee + managers
      approvalStatus = "approved";
      const managerIds = managers.map((id) => String(id));
      receivers = [...receivers, ...managerIds];
    } else if (needsApproval) {
      approvalStatus = "pending";
      // For needs_approval → only TLs initially
      receivers = [...tls.map((id) => String(id))];
    } else if (isDirect) {
      approvalStatus = "approved";
      receivers = [...receivers, ...managers.map((id) => String(id))];
    }

    // If still no receivers, apply fallback logic
    if (receivers.length === 0) {
      if (senderRole === "employee") {
        if (isDirect) {
          receivers = [...tls, ...managers];
          approvalStatus = "approved";
        } else {
          receivers = [...tls];
          approvalStatus = "pending";
        }
      } else if (senderRole === "team_lead") {
        receivers = [...managers];
        approvalStatus = "approved";
      } else if (senderRole === "manager") {
        receivers = [...tls];
        approvalStatus = "approved";
      }
    }

    // ✅ Remove duplicates and exclude sender
    receivers = Array.from(new Set(receivers.map((id) => String(id)))).filter(
      (id) => id !== String(sender)
    );

    if (receivers.length === 0) {
      return res.status(400).json({ error: "No valid receivers found" });
    }

    const msg = await AssignmentMessage.create({
      owner,
      client,
      sender,
      receiver: receivers,
      subject: subject || "",
      note: note || "",
      approvalStatus: approvalStatus || undefined,
    });

    const populated = await msg.populate([
      { path: "owner", select: "_id name companyEmail" },
      { path: "sender", select: "_id name companyEmail role" },
      { path: "receiver", select: "_id name companyEmail role" },
      { path: "client", select: "_id clientName assignedTo" },
    ]);

    res.status(201).json(populated);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to create assignment message" });
  }
};


// PATCH /api/assignment-messages/:id/approve
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
    const msg = await AssignmentMessage.findById(id);
    if (!msg) return res.status(404).json({ error: "Message not found" });

    const userRole = normalizeRole(req.employee?.role || "");
    if (userRole !== "team_lead") {
      return res
        .status(403)
        .json({ error: "Only Team Leads can disapprove messages" });
    }

    msg.approvalStatus = "disapproved";
    await msg.save();

    res.json(msg);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to disapprove message" });
  }
};

// GET /api/assignment-messages/:id
exports.getMessage = async function getMessage(req, res) {
  try {
    const msg = await AssignmentMessage.findById(req.params.id).populate([
      { path: "owner", select: "_id name companyEmail" },
      { path: "sender", select: "_id name companyEmail role" },
      { path: "receiver", select: "_id name companyEmail role" },
      { path: "client", select: "_id clientName" },
      { path: "attachments.uploadedBy", select: "_id name companyEmail" },
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
    ]);

    res.json(populated);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to update message" });
  }
};

// DELETE /api/assignment-messages/:id
exports.deleteMessage = async function deleteMessage(req, res) {
  try {
    const msg = await AssignmentMessage.findByIdAndDelete(req.params.id);
    if (!msg) return res.status(404).json({ error: "Not found" });
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
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to delete attachment" });
  }
};

// GET /api/assignment-messages/sent
// Required: client (ObjectId) – only show messages the current user sent to this client
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
      AssignmentMessage.find(q)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
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
