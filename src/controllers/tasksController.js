// controllers/tasksController.js
const Task = require("../models/Task");
const ClientInfo = require("../models/ClientInfo");
const Employee = require("../models/Employees");
const AssignmentMessage = require("../models/AssignmentMessage"); // ⟵ NEW
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
  "application/vnd.ms-excel", // .xls
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

/* ---------------- Helpers ---------------- */
const roleStr = (r) => String(r || "").trim().toLowerCase();
const isManagerLike = (role) => {
  const r = roleStr(role);
  return r === "manager" || r === "team lead" || r === "team_lead" || r === "teamlead";
};
const isTeamLead = (role) => {
  const r = roleStr(role);
  return r === "team lead" || r === "team_lead" || r === "teamlead";
};

const idEq = (a, b) => String(a || "") === String(b || "");

async function canTouchTask(req, task) {
  const me = await Employee.findById(req.employee._id).select("_id role owner");
  if (!me || !task) return false;

  const taskOwnerId = task.owner || task?.client?.owner;
  const managerScopeOk = isManagerLike(me.role) && idEq(taskOwnerId, me.owner);

  const assignedId = task.assignedTo
    ? task.assignedTo._id
      ? String(task.assignedTo._id)
      : String(task.assignedTo)
    : null;
  const isAssignee = assignedId && idEq(assignedId, me._id);

  return !!(managerScopeOk || isAssignee);
}

function publicUrl(req, filename) {
  return `${req.protocol}://${req.get("host")}/uploads/tasks/${filename}`;
}

async function findOneByRole(ownerId, roleRegex) {
  return Employee.findOne({ owner: ownerId, role: roleRegex }).select("_id name companyEmail");
}

async function notify(ownerId, clientId, senderId, receiverId, subject, note) {
  try {
    if (!receiverId) return;
    await AssignmentMessage.create({
      owner: ownerId,
      client: clientId,
      sender: senderId,
      receiver: receiverId,
      subject: subject || "",
      note: note || "",
    });
  } catch (e) {
    console.warn("notify() failed:", e.message);
  }
}

/* ---------------- Controllers ---------------- */

exports.clientsForManager = async (req, res) => {
  try {
    const me = await Employee.findById(req.employee._id).select("_id role owner");
    if (!me) return res.status(404).json({ error: "Employee not found" });
    if (!isManagerLike(me.role)) {
      return res.status(403).json({ error: "Only Managers and Team Leads allowed" });
    }

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
 * Manager/Team Lead: create task for a client (auto-assign to client's assigned employee)
 * POST /api/tasks
 * body: { clientId, title, description?, priority?, dueDate? }
 */
exports.createTask = async (req, res) => {
  try {
    const me = await Employee.findById(req.employee._id).select("_id role owner");
    if (!me) return res.status(404).json({ error: "Employee not found" });
    if (!isManagerLike(me.role)) {
      return res.status(403).json({ error: "Only Managers/Team Leads can create tasks" });
    }

    const { clientId, title, description, priority, dueDate } = req.body;
    if (!clientId || !title)
      return res.status(400).json({ error: "clientId and title are required" });

    const client = await ClientInfo.findById(clientId).select("_id owner assignedTo clientName");
    if (!client) return res.status(404).json({ error: "Client not found" });
    if (!idEq(client.owner, me.owner)) {
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
      status: "todo",
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
 * - Manager/Team Lead: client must belong to their owner
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

    if (roleStr(me.role) === "owner") {
      if (!idEq(client.owner, me._id)) return res.status(403).json({ error: "Forbidden" });
    } else if (isManagerLike(me.role)) {
      if (!idEq(client.owner, me.owner)) return res.status(403).json({ error: "Forbidden" });
    } else {
      if (!client.assignedTo || !idEq(client.assignedTo, me._id)) {
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
 * GET /api/tasks/my
 * Manager/Team Lead: all tasks under their owner
 * Employee: only tasks assigned to them
 */
exports.getMyTasks = async (req, res) => {
  try {
    const me = await Employee.findById(req.employee._id).select("_id role owner");
    if (!me) return res.status(404).json({ error: "Employee not found" });

    const query = isManagerLike(me.role) ? { owner: me.owner } : { assignedTo: me._id };

    const tasks = await Task.find(query)
      .sort({ createdAt: -1 })
      .populate("client", "_id clientName")
      .populate("assignedTo", "_id name companyEmail");

    res.json(tasks);
  } catch (err) {
    console.error("getMyTasks error:", err);
    res.status(500).json({ error: "Server error" });
  }
};

/**
 * PATCH /api/tasks/:taskId
 * body: { status?, priority?, dueDate?, title?, description?, assignedTo?, completed? }
 *
 * Review workflow:
 * - If an **employee/assignee** requests status=done:
 *      we set status => "pending_review"
 *      and notify Team Lead (or Manager fallback): "Task ready for review"
 * - If a **Team Lead** sets status=done from pending_review:
 *      we set status => "done"
 *      and notify Manager: "Task approved & done"
 * - Managers can set status to done directly (no extra notify).
 */
exports.updateTask = async (req, res) => {
  try {
    const me = await Employee.findById(req.employee._id).select("_id role owner name companyEmail");
    if (!me) return res.status(404).json({ error: "Employee not found" });

    const task = await Task.findById(req.params.taskId)
      .populate("client", "owner clientName")
      .populate("assignedTo", "_id name companyEmail");
    if (!task) return res.status(404).json({ error: "Task not found" });

    const managerScopeOk = isManagerLike(me.role) && idEq(task.client.owner, me.owner);
    const assignedId = task.assignedTo
      ? task.assignedTo._id
        ? String(task.assignedTo._id)
        : String(task.assignedTo)
      : null;
    const isAssignee = assignedId && idEq(assignedId, me._id);

    if (!managerScopeOk && !isAssignee) {
      return res.status(403).json({ error: "Forbidden" });
    }

    // Apply non-status fields first
    const allowed = [
      "priority",
      "dueDate",
      "title",
      "description",
      "assignedTo",
      "completed",
    ];
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

    const ownerId = task.owner || task.client.owner;
    const clientId = task.client?._id || task.client;

    // Handle STATUS with the review workflow
    if ("status" in req.body) {
      const requested = String(req.body.status || "").toLowerCase();
      const prevStatus = String(task.status || "").toLowerCase();

      if (requested === "done") {
        if (!managerScopeOk) {
          // Assignee marked as done -> gate to pending_review and notify Team Lead
          task.status = "pending_review";
          await task.save();

          // Notify TL (fallback Manager)
          const teamLead = await findOneByRole(ownerId, /team\s*lead/i);
          const manager = await findOneByRole(ownerId, /^manager$/i);

          const receiverId = (teamLead?._id && String(teamLead._id) !== String(me._id))
            ? teamLead._id
            : manager?._id;

          await notify(
            ownerId,
            clientId,
            me._id,
            receiverId,
            `Task ready for review: ${task.title}`,
            `The assignee (${me.name || me.companyEmail || me._id}) marked "${task.title}" as done. Please review.`
          );

          const populated = await Task.findById(task._id)
            .populate("client", "_id clientName")
            .populate("assignedTo", "_id name companyEmail");
          return res.json(populated);
        } else {
          // Manager/Team Lead approval to actual DONE
          task.status = "done";
          await task.save();

          // If Team Lead approved from pending_review -> notify Manager
          if (isTeamLead(me.role) && prevStatus === "pending_review") {
            const manager = await findOneByRole(ownerId, /^manager$/i);
            await notify(
              ownerId,
              clientId,
              me._id,
              manager?._id,
              `Task approved & done: ${task.title}`,
              `Team Lead approved "${task.title}". Marked as done.`
            );
          }

          const populated = await Task.findById(task._id)
            .populate("client", "_id clientName")
            .populate("assignedTo", "_id name companyEmail");
          return res.json(populated);
        }
      } else {
        // Any other status (todo/in_progress/blocked/pending_review etc.)
        task.status = requested;
      }
    }

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
 * DELETE /api/tasks/:taskId
 * Manager/Team Lead (same owner) only
 */
exports.deleteTask = async (req, res) => {
  try {
    const me = await Employee.findById(req.employee._id).select("_id role owner");
    if (!me) return res.status(404).json({ error: "Employee not found" });

    const task = await Task.findById(req.params.taskId).populate("client", "owner");
    if (!task) return res.status(404).json({ error: "Task not found" });

    if (!(isManagerLike(me.role) && idEq(task.client.owner, me.owner))) {
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

// Upload attachments (multi)
exports.uploadAttachments = [
  upload.array("files", 10),
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

      const populated = await Task.findById(task._id).populate(
        "attachments.uploadedBy",
        "_id name companyEmail"
      );
      res.status(201).json(populated.attachments || []);
    } catch (err) {
      console.error("uploadAttachments error:", err);
      res.status(500).json({ error: err.message || "Failed to upload" });
    }
  },
];

// Delete one attachment
exports.deleteAttachment = async (req, res) => {
  try {
    const { taskId, attachmentId } = req.params;
    const task = await Task.findById(taskId).populate("client", "owner");
    if (!task) return res.status(404).json({ error: "Task not found" });
    if (!(await canTouchTask(req, task))) return res.status(403).json({ error: "Forbidden" });

    const att = task.attachments.id(attachmentId);
    if (!att) return res.status(404).json({ error: "Attachment not found" });

    const filePath = path.join(taskUploadDir, att.filename);
    if (fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
      } catch (e) {
        console.warn("unlink error", e.message);
      }
    }

    att.deleteOne();
    await task.save();

    res.json({ success: true });
  } catch (err) {
    console.error("deleteAttachment error:", err);
    res.status(500).json({ error: "Failed to delete attachment" });
  }
};
