const Task = require("../models/Task");
const ClientInfo = require("../models/ClientInfo");
const Employee = require("../models/Employees");
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const multer = require("multer");

const uploadRoot = path.join(__dirname, "..", "uploads");
const taskUploadDir = path.join(uploadRoot, "tasks");
fs.mkdirSync(taskUploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: taskUploadDir,
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || "");
    const name = `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`;
    cb(null, name);
  },
});

const ALLOWED = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // .xlsx
  "application/vnd.ms-excel", // .xls (optional)
]);

const fileFilter = (_req, file, cb) => {
  if (ALLOWED.has(file.mimetype)) return cb(null, true);
  cb(new Error("Only PDF/XLS/XLSX are allowed"));
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB each
});

// ---------- Helpers ----------
async function canTouchTask(req, task) {
  const me = await Employee.findById(req.employee._id).select("_id role owner");
  if (!me || !task) return false;
  const isManagerSameOwner = me.role === "Manager" && String(task.client.owner) === String(me.owner);
  const isAssignee = task.assignedTo && String(task.assignedTo) === String(me._id);
  return isManagerSameOwner || isAssignee;
}

function publicUrl(req, filename) {
  // e.g., http://localhost:4000/uploads/tasks/<filename>
  return `${req.protocol}://${req.get("host")}/uploads/tasks/${filename}`;
}


exports.clientsForManager = async (req, res) => {
  try {
    const me = await Employee.findById(req.employee._id).select("_id role owner");
    if (!me) return res.status(404).json({ error: "Employee not found" });
    if (me.role !== "Manager") return res.status(403).json({ error: "Only Managers allowed" });

    const clients = await ClientInfo.find({ owner: me.owner })
      .select("_id clientName companyLocation industry assignedTo owner")
      .populate("assignedTo", "_id name companyEmail");

    res.json(clients);
  } catch (err) {
    console.error("clientsForManager error:", err);
    res.status(500).json({ error: "Server error" });
  }
};

/**
 * Manager: create task for a client (auto-assign to client's assigned employee)
 * POST /api/tasks
 * body: { clientId, title, description?, priority?, dueDate? }
 */
exports.createTask = async (req, res) => {
  try {
    const me = await Employee.findById(req.employee._id).select("_id role owner");
    if (!me) return res.status(404).json({ error: "Employee not found" });
    if (me.role !== "Manager") return res.status(403).json({ error: "Only Managers can create tasks" });

    const { clientId, title, description, priority, dueDate } = req.body;
    if (!clientId || !title) return res.status(400).json({ error: "clientId and title are required" });

    const client = await ClientInfo.findById(clientId).select("_id owner assignedTo");
    if (!client) return res.status(404).json({ error: "Client not found" });
    if (String(client.owner) !== String(me.owner)) {
      return res.status(403).json({ error: "Client does not belong to your owner" });
    }

    const task = await Task.create({
      owner: client.owner,
      client: client._id,
      createdBy: me._id,
      assignedTo: client.assignedTo || undefined,
      title,
      description: description || "",
      priority: priority || "medium",
      dueDate: dueDate ? new Date(dueDate) : undefined,
    });

    const populated = await Task.findById(task._id)
      .populate("client", "_id clientName")
      .populate("assignedTo", "_id name companyEmail");

    res.status(201).json(populated);
  } catch (err) {
    console.error("createTask error:", err);
    res.status(500).json({ error: "Failed to create task" });
  }
};

/**
 * Get tasks for a specific client
 * - Owner: client must belong to them
 * - Manager: client must belong to their owner
 * - Employee: only if they are assigned to that client
 * GET /api/tasks/client/:clientId
 */
exports.getTasksForClient = async (req, res) => {
  try {
    const me = await Employee.findById(req.employee._id).select("_id role owner");
    if (!me) return res.status(404).json({ error: "Employee not found" });

    const { clientId } = req.params;
    const client = await ClientInfo.findById(clientId).select("_id owner assignedTo");
    if (!client) return res.status(404).json({ error: "Client not found" });

    if (me.role === "Owner") {
      if (String(client.owner) !== String(me._id)) {
        return res.status(403).json({ error: "Forbidden" });
      }
    } else if (me.role === "Manager") {
      if (String(client.owner) !== String(me.owner)) {
        return res.status(403).json({ error: "Forbidden" });
      }
    } else {
      // Employee
      if (!client.assignedTo || String(client.assignedTo) !== String(me._id)) {
        return res.status(403).json({ error: "Forbidden" });
      }
    }

    const tasks = await Task.find({ client: client._id })
      .sort({ createdAt: -1 })
      .populate("assignedTo", "_id name companyEmail")
      .populate("client", "_id clientName");

    res.json(tasks);
  } catch (err) {
    console.error("getTasksForClient error:", err);
    res.status(500).json({ error: "Failed to fetch tasks" });
  }
};

/**
 * Employee: tasks assigned to me (for all my assigned clients)
 * GET /api/tasks/my
 */
exports.getMyTasks = async (req, res) => {
  try {
    const me = await Employee.findById(req.employee._id).select('_id role owner');
    if (!me) return res.status(404).json({ error: 'Employee not found' });

    const query =
      me.role === 'Manager'
        ? { owner: me.owner }                   // all tasks under the manager’s owner
        : { assignedTo: me._id };               // only my tasks

    const tasks = await Task.find(query)
      .sort({ createdAt: -1 })
      .populate('client', '_id clientName')
      .populate('assignedTo', '_id name companyEmail');

    res.json(tasks);
  } catch (err) {
    console.error('getMyTasks error:', err);
    res.status(500).json({ error: 'Server error' });
  }
};

/**
 * Update a task (status/priority/dueDate/title/description)
 * - Manager (same owner) OR assigned employee can update
 * PATCH /api/tasks/:taskId
 */
exports.updateTask = async (req, res) => {
  try {
    const me = await Employee.findById(req.employee._id).select("_id role owner");
    if (!me) return res.status(404).json({ error: "Employee not found" });

    const task = await Task.findById(req.params.taskId)
      .populate("client", "owner assignedTo");

    if (!task) return res.status(404).json({ error: "Task not found" });

    const isManagerSameOwner =
      me.role === "Manager" && String(task.client.owner) === String(me.owner);
    const isAssignee = task.assignedTo && String(task.assignedTo) === String(me._id);
    if (!isManagerSameOwner && !isAssignee) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const allowed = ["status", "priority", "dueDate", "title", "description", "assignedTo", "completed"];
    allowed.forEach((k) => {
      if (k in req.body) {
        if (k === "dueDate" && req.body[k]) {
          task[k] = new Date(req.body[k]);
        } else if (k === "assignedTo") {
          task[k] = req.body[k] || undefined;
        } else {
          task[k] = req.body[k];
        }
      }
    });

    await task.save();

    const populated = await Task.findById(task._id)
      .populate("client", "_id clientName")
      .populate("assignedTo", "_id name companyEmail");

    res.json(populated);
  } catch (err) {
    console.error("updateTask error:", err);
    res.status(500).json({ error: "Failed to update task" });
  }
};

/**
 * Delete task – Manager (same owner) only
 * DELETE /api/tasks/:taskId
 */
exports.deleteTask = async (req, res) => {
  try {
    const me = await Employee.findById(req.employee._id).select("_id role owner");
    if (!me) return res.status(404).json({ error: "Employee not found" });

    const task = await Task.findById(req.params.taskId).populate("client", "owner");
    if (!task) return res.status(404).json({ error: "Task not found" });

    if (!(me.role === "Manager" && String(task.client.owner) === String(me.owner))) {
      return res.status(403).json({ error: "Forbidden" });
    }

    await Task.deleteOne({ _id: task._id });
    res.json({ success: true });
  } catch (err) {
    console.error("deleteTask error:", err);
    res.status(500).json({ error: "Failed to delete task" });
  }
};
exports.listAttachments = async (req, res) => {
  try {
    const task = await Task.findById(req.params.taskId)
      .populate("client", "owner")
      .populate("attachments.uploadedBy", "_id name companyEmail");

    if (!task) return res.status(404).json({ error: "Task not found" });
    if (!(await canTouchTask(req, task))) return res.status(403).json({ error: "Forbidden" });

    res.json(task.attachments || []);
  } catch (err) {
    console.error("listAttachments error:", err);
    res.status(500).json({ error: "Failed to fetch attachments" });
  }
};

// ---------------- NEW: upload attachments (multi) ----------------
exports.uploadAttachments = [
  upload.array("files", 10), // field name must be "files"
  async (req, res) => {
    try {
      const task = await Task.findById(req.params.taskId).populate("client", "owner");
      if (!task) return res.status(404).json({ error: "Task not found" });
      if (!(await canTouchTask(req, task))) return res.status(403).json({ error: "Forbidden" });

      const files = req.files || [];
      if (!files.length) return res.status(400).json({ error: "No files uploaded" });

      const toAdd = files.map((f) => ({
        _id: new mongoose.Types.ObjectId(),
        filename: f.filename,
        originalName: f.originalname,
        mimetype: f.mimetype,
        size: f.size,
        url: publicUrl(req, f.filename),
        uploadedBy: req.employee._id,
        uploadedAt: new Date(),
      }));

      task.attachments.push(...toAdd);
      await task.save();

      // return the whole list (with latest)
      const populated = await Task.findById(task._id).populate("attachments.uploadedBy", "_id name companyEmail");
      res.status(201).json(populated.attachments || []);
    } catch (err) {
      console.error("uploadAttachments error:", err);
      res.status(500).json({ error: err.message || "Failed to upload" });
    }
  },
];

// ---------------- NEW: delete one attachment ----------------
exports.deleteAttachment = async (req, res) => {
  try {
    const { taskId, attachmentId } = req.params;
    const task = await Task.findById(taskId).populate("client", "owner");
    if (!task) return res.status(404).json({ error: "Task not found" });
    if (!(await canTouchTask(req, task))) return res.status(403).json({ error: "Forbidden" });

    const att = task.attachments.id(attachmentId);
    if (!att) return res.status(404).json({ error: "Attachment not found" });

    // remove file from disk
    const filePath = path.join(taskUploadDir, att.filename);
    if (fs.existsSync(filePath)) {
      try { fs.unlinkSync(filePath); } catch (e) { console.warn("unlink error", e.message); }
    }

    // pull subdoc and save
    att.deleteOne();
    await task.save();

    res.json({ success: true });
  } catch (err) {
    console.error("deleteAttachment error:", err);
    res.status(500).json({ error: "Failed to delete attachment" });
  }
};