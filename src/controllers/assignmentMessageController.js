// controllers/assignmentMessage.controller.js
const AssignmentMessage = require("../models/AssignmentMessage");
const path = require("path");

function buildPublicUrl(req, filename) {
  // Example: http://localhost:4000/uploads/<filename>
  const base = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`;
  return `${base}/uploads/${filename}`;
}

/**
 * GET /api/assignment-messages
 * Query params:
 *  - client: ObjectId
 *  - toEmployee: ObjectId
 *  - manager: ObjectId
 *  - owner: ObjectId
 *  - limit, page
 * Role-aware defaults:
 *  - If employee token includes ownerId/managerId/sub etc., we auto-scope results unless owner role
 */
exports.listMessages = async function listMessages(req, res) {
  try {
    const {
      client,
      toEmployee,
      manager,
      owner,
      limit = 50,
      page = 1,
    } = req.query;

    const q = {};

    // Role-awareness: if owner provided in token, scope by it unless explicit owner is passed
    if (owner) q.owner = owner;
    else if (req.auth?.ownerId) q.owner = req.auth.ownerId;

    if (client) q.client = client;
    if (toEmployee) q.toEmployee = toEmployee;

    // If manager is explicitly requested use it, otherwise if token has a managerId use that
    if (manager) q.manager = manager;
    else if (req.auth?.managerId) q.manager = req.auth.managerId;

    // Basic access guard: must at least match one of these scoping fields
    if (!q.owner && !q.manager && !q.toEmployee && !q.client) {
      return res.status(400).json({ error: "Provide at least one scope: owner/manager/toEmployee/client" });
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
          { path: "manager", select: "_id name companyEmail" },
          { path: "toEmployee", select: "_id name companyEmail" },
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
 * POST /api/assignment-messages
 * body: { owner, manager, client, toEmployee, subject, note }
 */
exports.createMessage = async function createMessage(req, res) {
  try {
    const { owner, manager, client, toEmployee, subject, note } = req.body;

    if (!owner || !manager || !client || !toEmployee) {
      return res.status(400).json({ error: "owner, manager, client, toEmployee are required" });
    }

    const msg = await AssignmentMessage.create({
      owner,
      manager,
      client,
      toEmployee,
      subject: subject || "",
      note: note || "",
    });

    const populated = await msg.populate([
      { path: "owner", select: "_id name companyEmail" },
      { path: "manager", select: "_id name companyEmail" },
      { path: "toEmployee", select: "_id name companyEmail" },
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
    const msg = await AssignmentMessage.findById(req.params.id)
      .populate([
        { path: "owner", select: "_id name companyEmail" },
        { path: "manager", select: "_id name companyEmail" },
        { path: "toEmployee", select: "_id name companyEmail" },
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
      { path: "manager", select: "_id name companyEmail" },
      { path: "toEmployee", select: "_id name companyEmail" },
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
      uploadedBy: req.auth?.sub || req.employee?._id || undefined,
    }));

    msg.attachments.push(...files);
    await msg.save();

    const populated = await msg.populate([{ path: "attachments.uploadedBy", select: "_id name companyEmail" }]);
    res.status(201).json(populated.attachments);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Attachment upload failed (only PDF/XLS/XLSX; up to 20MB each)" });
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
    msg.attachments = msg.attachments.filter((a) => a._id.toString() !== attId);
    const after = msg.attachments.length;

    if (before === after) return res.status(404).json({ error: "Attachment not found" });

    await msg.save();
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to delete attachment" });
  }
};
