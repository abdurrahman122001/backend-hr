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
  if (["teamlead", "team_lead", "team-lead", "lead"].includes(r)) return "team_lead";
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
  if (!isObjId(ownerId)) return { tls: [], managers: [] };

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

  return {
    tls: tls.map((x) => String(x._id)),
    managers: managers.map((x) => String(x._id)),
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
exports.listMessagesForManager = async function listMessagesForManager(req, res) {
  try {
    const clientId =
      req.params.clientId || req.query.clientId || req.query.client || null;

    const owner = req.query.owner || req.employee?.owner || null;

    const sender = req.query.sender || null;
    const receiver = req.query.receiver || req.query.toEmployee || null;
    const participant = req.query.participant || req.query.employee || null;
    const betweenRaw = req.query.between;

    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 200);

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

// POST /api/assignment-messages
// Request body:
//   owner, client, sender
//   receiver  (array)  OR receivers (array)  // either name is accepted
//   subject, note
// Behavior:
//   - If sender's role is Employee **and** no receivers provided, the server
//     will automatically include all Team Leads + Managers for the same owner.
//   - Duplicates and the sender's own id are removed.
exports.createMessage = async function createMessage(req, res) {
  try {
    const {
      owner: ownerBody,
      client,
      sender: senderBody,
      receiver: receiverBody,  // array (preferred)
      receivers: receiversBody, // array (legacy alias)
      subject,
      note,
    } = req.body;

    const owner  = ownerBody || req.employee?.owner;
    const sender = senderBody || req.employee?._id;

    if (!isObjId(owner) || !isObjId(client) || !isObjId(sender)) {
      return res.status(400).json({
        error: "owner, client, and sender are required (ObjectId strings)",
      });
    }

    // normalize incoming receivers (accept both 'receiver' and 'receivers')
    let receivers = [];
    if (Array.isArray(receiverBody)) receivers = normalizeIds(receiverBody);
    if (Array.isArray(receiversBody)) receivers = receivers.concat(normalizeIds(receiversBody));

    // remove self if present
    receivers = receivers.filter((id) => id !== String(sender));

    // if sender is employee AND receivers empty → auto include all TLs & Managers for the owner
    const senderDoc = await Employee.findById(sender).select("_id role").lean();
    const senderRole = normalizeRole(senderDoc?.role || "");
    if (senderRole === "employee" && receivers.length === 0) {
      const { tls, managers } = await findTLsAndManagersByOwner(owner);
      receivers = [...tls, ...managers].filter((id) => id !== String(sender));
    }

    // final validation
    receivers = Array.from(new Set(receivers)); // dedupe
    if (receivers.length === 0) {
      return res.status(400).json({
        error:
          "At least one receiver is required. Provide receiver(s) array or let the server auto-include TL and Manager by ensuring sender is an Employee.",
      });
    }

    // Create single message document with receiver array
    const msg = await AssignmentMessage.create({
      owner,
      client,
      sender,
      receiver: receivers,
      subject: subject || "",
      note: note || "",
    });

    const populated = await msg.populate([
      { path: "owner", select: "_id name companyEmail" },
      { path: "sender", select: "_id name companyEmail role" },
      { path: "receiver", select: "_id name companyEmail role" }, // array
      { path: "client", select: "_id clientName" },
    ]);

    res.status(201).json(populated);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to create assignment message" });
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
