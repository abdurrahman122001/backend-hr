// CRUD for space (Google-Chat) tasks. Realtime: every mutation emits to the
// `space_<chatId>` socket room so all members' Tasks panels stay in sync.
const mongoose = require("mongoose");
const ChatTask = require("../models/ChatTask");

const POPULATE = [
  { path: "assignees", select: "_id name companyEmail photographUrl avatar" },
  { path: "createdBy", select: "_id name companyEmail photographUrl avatar" },
];

const emit = (req, event, chatId, payload) => {
  try {
    const io = req.app.get("io");
    io?.to(`space_${chatId}`).emit(event, { chatId: String(chatId), ...payload });
  } catch (e) {
    /* non-fatal — realtime is best-effort */
  }
};

// Browser-notify each freshly-assigned employee (skipping the actor) on their
// personal `user_<id>` room — the same room mentions/messages use.
const notifyAssignees = (req, task, assigneeList, actorId) => {
  try {
    const io = req.app.get("io");
    if (!io) return;
    const actor = String(actorId);
    const by = req.employee?.name || "Someone";
    (assigneeList || []).forEach((a) => {
      const id = String(a?._id || a);
      if (!id || id === actor) return;
      io.to(`user_${id}`).emit("chat_task_assigned", {
        chatId: String(task.chatId),
        taskId: String(task._id),
        title: task.title,
        assignedByName: by,
      });
    });
  } catch (e) {
    /* non-fatal */
  }
};

exports.getTasks = async (req, res) => {
  try {
    const { chatId } = req.params;
    if (!mongoose.isValidObjectId(chatId))
      return res.status(400).json({ error: "Invalid space id" });
    const tasks = await ChatTask.find({ chatId })
      .sort({ done: 1, createdAt: -1 })
      .populate(POPULATE)
      .lean();
    return res.json({ tasks });
  } catch (e) {
    console.error("getTasks error:", e);
    return res.status(500).json({ error: "Failed to load tasks" });
  }
};

exports.createTask = async (req, res) => {
  try {
    const { chatId } = req.params;
    const { title, details, dueAt, assignees } = req.body;
    if (!mongoose.isValidObjectId(chatId))
      return res.status(400).json({ error: "Invalid space id" });
    if (!title || !title.trim())
      return res.status(400).json({ error: "Title is required" });

    let task = await ChatTask.create({
      chatId,
      owner: req.employee.owner,
      title: title.trim(),
      details: (details || "").trim(),
      dueAt: dueAt ? new Date(dueAt) : null,
      assignees: Array.isArray(assignees)
        ? assignees.filter((a) => mongoose.isValidObjectId(a))
        : [],
      createdBy: req.employee._id,
    });
    task = await task.populate(POPULATE);

    emit(req, "chat_task_created", chatId, { task });
    notifyAssignees(req, task, task.assignees, req.employee._id);
    return res.status(201).json({ task });
  } catch (e) {
    console.error("createTask error:", e);
    return res.status(500).json({ error: "Failed to create task" });
  }
};

exports.updateTask = async (req, res) => {
  try {
    const { taskId } = req.params;
    const task = await ChatTask.findById(taskId);
    if (!task) return res.status(404).json({ error: "Task not found" });

    // Remember who was already assigned so we only notify NEW assignees.
    const prevAssignees = (task.assignees || []).map((a) => String(a));

    const { title, details, dueAt, assignees, done } = req.body;
    if (typeof title === "string" && title.trim()) task.title = title.trim();
    if (typeof details === "string") task.details = details.trim();
    if (dueAt !== undefined) task.dueAt = dueAt ? new Date(dueAt) : null;
    if (Array.isArray(assignees))
      task.assignees = assignees.filter((a) => mongoose.isValidObjectId(a));
    if (typeof done === "boolean") {
      task.done = done;
      task.completedAt = done ? new Date() : null;
    }
    await task.save();
    const populated = await task.populate(POPULATE);

    emit(req, "chat_task_updated", task.chatId, { task: populated });
    if (Array.isArray(assignees)) {
      const newlyAdded = (populated.assignees || []).filter(
        (a) => !prevAssignees.includes(String(a._id)),
      );
      notifyAssignees(req, populated, newlyAdded, req.employee._id);
    }
    return res.json({ task: populated });
  } catch (e) {
    console.error("updateTask error:", e);
    return res.status(500).json({ error: "Failed to update task" });
  }
};

exports.deleteTask = async (req, res) => {
  try {
    const { taskId } = req.params;
    const task = await ChatTask.findByIdAndDelete(taskId);
    if (!task) return res.status(404).json({ error: "Task not found" });
    emit(req, "chat_task_deleted", task.chatId, { taskId });
    return res.json({ success: true });
  } catch (e) {
    console.error("deleteTask error:", e);
    return res.status(500).json({ error: "Failed to delete task" });
  }
};
