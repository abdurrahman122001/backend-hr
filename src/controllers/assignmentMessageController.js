// controllers/assignmentMessageController.js
const AssignmentMessage = require("../models/AssignmentMessage");
const path = require("path");
const mongoose = require("mongoose");

function buildPublicUrl(req, filename) {
  const base =
    process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`;
  return `${base}/uploads/${filename}`;
}

// Accepts strings or ObjectId instances
const isObjId = (v) => mongoose.isValidObjectId(v);

/**
 * GET /api/assignment-messages
 * Query params (new):
 *  - client: ObjectId
 *  - sender: ObjectId
 *  - receiver: ObjectId
 *  - participant: ObjectId (matches either sender or receiver)
 *  - owner: ObjectId (otherwise inferred from middleware: req.employee.owner)
 *
 * Back-compat:
 *  - toEmployee => receiver
 *  - manager    => (ignored for filtering; kept only as create() fallback)
 */
exports.listMessages = async function listMessages(req, res) {
  try {
    const {
      client,
      sender,
      receiver,
      participant,
      owner,
      toEmployee, // legacy => receiver
      limit = 50,
      page = 1,
    } = req.query;

    const q = {};

    // Scope by owner (explicit takes precedence; else infer from middleware)
    if (owner) q.owner = owner;
    else if (req.employee?.owner) q.owner = req.employee.owner;

    if (isObjId(client)) q.client = client;

    const recv = receiver || toEmployee; // back-compat
    if (isObjId(participant)) {
      q.$or = [{ sender: participant }, { receiver: participant }];
    } else {
      if (isObjId(sender)) q.sender = sender;
      if (isObjId(recv)) q.receiver = recv;
    }

    // Guard against overly broad queries
    if (!q.owner && !q.client && !q.sender && !q.receiver && !q.$or) {
      return res.status(400).json({
        error:
          "Provide at least one scope: owner, client, sender, receiver, or participant",
      });
    }

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);

    const [items, total] = await Promise.all([
      AssignmentMessage.find(q)
        .sort({ createdAt: -1 })
        .skip((pageNum - 1) * lim)
        .limit(lim)
        .populate([
          { path: "owner", select: "_id name companyEmail" },
          { path: "sender", select: "_id name companyEmail" },
          { path: "receiver", select: "_id name companyEmail" },
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
    res.status(500).json({ error: "Failed to fetch assignment messages" });
  }
};

/**
 * GET /api/assignment-messages/messages
 * GET /api/assignment-messages/messages/:clientId
 *
 * Kept for compatibility with your routes. Works like listMessages but
 * with slightly different param names:
 *  - clientId | client
 *  - sender | receiver | participant
 *  - owner (inferred from middleware if absent)
 * Back-compat:
 *  - toEmployee => receiver
 */
exports.listMessagesForManager = async function listMessagesForManager(req, res) {
  try {
    const clientId =
      req.params.clientId || req.query.clientId || req.query.client || null;

    const owner = req.query.owner || req.employee?.owner || null;

    const sender = req.query.sender || null;
    const receiver = req.query.receiver || req.query.toEmployee || null; // back-compat
    const participant = req.query.participant || req.query.employee || null;

    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 200);

    const q = {};
    if (owner) q.owner = owner; // accept ObjectId instance or string
    if (isObjId(clientId)) q.client = clientId;

    if (isObjId(participant)) {
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

    const messages = await AssignmentMessage.find(q)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate([
        { path: "owner", select: "_id name companyEmail" },
        { path: "sender", select: "_id name companyEmail" },
        { path: "receiver", select: "_id name companyEmail" },
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

/**
 * POST /api/assignment-messages
 * body (new): { owner, client, sender, receiver, subject?, note? }
 *
 * Back-compat body: { owner, client, toEmployee, manager } -> receiver
 * If sender not provided, falls back to req.employee._id (current employee).
 * If owner not provided, falls back to req.employee.owner (from middleware).
 */
exports.createMessage = async function createMessage(req, res) {
  try {
    const {
      owner: ownerBody,
      client,
      sender: senderBody,
      receiver: receiverBody,
      toEmployee, // legacy
      manager, // legacy fallback only
      subject,
      note,
    } = req.body;

    const owner = ownerBody || req.employee?.owner;
    const sender = senderBody || req.employee?._id;
    const receiver = receiverBody || toEmployee || manager;

    if (!owner || !client || !sender || !receiver) {
      return res.status(400).json({
        error:
          "owner, client, sender and receiver are required (toEmployee/manager accepted as legacy for receiver)",
      });
    }

    const msg = await AssignmentMessage.create({
      owner,
      client,
      sender,
      receiver,
      subject: subject || "",
      note: note || "",
    });

    const populated = await msg.populate([
      { path: "owner", select: "_id name companyEmail" },
      { path: "sender", select: "_id name companyEmail" },
      { path: "receiver", select: "_id name companyEmail" },
      { path: "client", select: "_id clientName" },
    ]);

    res.status(201).json(populated);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to create assignment message" });
  }
};

/**
 * GET /api/assignment-messages/:id
 */
exports.getMessage = async function getMessage(req, res) {
  try {
    const msg = await AssignmentMessage.findById(req.params.id).populate([
      { path: "owner", select: "_id name companyEmail" },
      { path: "sender", select: "_id name companyEmail" },
      { path: "receiver", select: "_id name companyEmail" },
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

/**
 * PATCH /api/assignment-messages/:id
 * body: { subject?, note? }
 */
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
      { path: "sender", select: "_id name companyEmail" },
      { path: "receiver", select: "_id name companyEmail" },
      { path: "client", select: "_id clientName" },
      { path: "attachments.uploadedBy", select: "_id name companyEmail" },
    ]);

    res.json(populated);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to update message" });
  }
};

/**
 * DELETE /api/assignment-messages/:id
 */
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

/**
 * POST /api/assignment-messages/:id/attachments
 * (multer handles files => req.files)
 */
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
      error:
        "Attachment upload failed (only PDF/XLS/XLSX; up to 20MB each)",
    });
  }
};

/**
 * GET /api/assignment-messages/:id/attachments
 */
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

/**
 * DELETE /api/assignment-messages/:id/attachments/:attId
 */
exports.deleteAttachment = async function deleteAttachment(req, res) {
  try {
    const { id, attId } = req.params;
    const msg = await AssignmentMessage.findById(id);
    if (!msg) return res.status(404).json({ error: "Not found" });

    const before = msg.attachments.length;
    msg.attachments = msg.attachments.filter(
      (a) => a._id.toString() !== attId
    );
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
