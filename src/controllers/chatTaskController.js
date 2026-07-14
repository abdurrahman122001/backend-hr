// CRUD for space (Google-Chat) tasks. Realtime: every mutation emits to the
// `space_<chatId>` socket room so all members' Tasks panels stay in sync.
const mongoose = require("mongoose");
const ChatTask = require("../models/ChatTask");
const ChatTaskComment = require("../models/ChatTaskComment");

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

// Post a system-style entry into the source message's thread ("Created a
// task…", "Assigned a task to…"). No-op for tasks not created from a message.
const postTaskThreadEntry = async (req, task, content) => {
  if (!task?.sourceMessageId) return;
  try {
    const { Message } = require("../models/Chat");
    const ChatThread = require("../models/ChatThread");
    const parentMsg = await Message.findById(task.sourceMessageId).select(
      "conversation space"
    );
    if (!parentMsg) return;
    const threadEntry = await ChatThread.create({
      parentMessageId: task.sourceMessageId,
      owner: req.employee.owner,
      sender: req.employee._id,
      content,
      messageType: "text",
      readBy: [{ employee: req.employee._id, readAt: new Date() }],
    });
    const populatedReply = await ChatThread.findById(threadEntry._id)
      .populate("sender", "name photographUrl avatar companyEmail role")
      .lean();
    const io = req.app.get("io");
    if (io) {
      io.to(`thread_${task.sourceMessageId}`).emit(
        "new_chat_thread_reply",
        populatedReply
      );
      const conversationId = String(parentMsg.conversation);
      const spaceId = parentMsg.space ? String(parentMsg.space) : null;
      let target = io.to(`conversation_${conversationId}`);
      if (spaceId) target = target.to(`space_${spaceId}`);
      target.emit("chat_thread_updated", {
        parentMessageId: String(task.sourceMessageId),
        conversationId,
        spaceId,
        lastReply: populatedReply,
      });
    }
  } catch (e) {
    console.error("task thread entry error:", e.message);
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
    const { title, details, dueAt, assignees, sourceMessageId, parentTaskId } = req.body;
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
      sourceMessageId: mongoose.isValidObjectId(sourceMessageId)
        ? sourceMessageId
        : null,
      parentTaskId: mongoose.isValidObjectId(parentTaskId) ? parentTaskId : null,
    });
    task = await task.populate(POPULATE);

    emit(req, "chat_task_created", chatId, { task });
    // Task created from a message → let the chat put a badge under it
    if (task.sourceMessageId) {
      emit(req, "message_task_created", chatId, {
        messageId: String(task.sourceMessageId),
        taskId: String(task._id),
        createdAt: task.createdAt,
      });

      // Mirror Google Chat: the task creation shows up inside the message's
      // thread ("Created a task (via Tasks)"), so the thread chat covers it.
      await postTaskThreadEntry(
        req,
        task,
        `Created a task (via Tasks)\n${task.title}`
      );
      // Assigned right at creation → announce that in the thread too
      if (Array.isArray(task.assignees) && task.assignees.length > 0) {
        const names = task.assignees
          .map((a) => `@${a.name || "member"}`)
          .join(", ");
        await postTaskThreadEntry(
          req,
          task,
          `Assigned a task to ${names} (via Tasks)`
        );
      }
    }
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
      // Announce (re)assignment in the source message's thread, Google-Chat style
      if (newlyAdded.length > 0) {
        const names = newlyAdded.map((a) => `@${a.name || "member"}`).join(", ");
        await postTaskThreadEntry(
          req,
          populated,
          `Assigned a task to ${names} (via Tasks)`
        );
      }
    }
    return res.json({ task: populated });
  } catch (e) {
    console.error("updateTask error:", e);
    return res.status(500).json({ error: "Failed to update task" });
  }
};

// ── Task comments (thread chat on a task) ──────────────────────────────────
exports.getTaskComments = async (req, res) => {
  try {
    const { taskId } = req.params;
    if (!mongoose.isValidObjectId(taskId))
      return res.status(400).json({ error: "Invalid task id" });
    const comments = await ChatTaskComment.find({ taskId })
      .sort({ createdAt: 1 })
      .populate({ path: "sender", select: "_id name companyEmail photographUrl avatar" })
      .lean();
    return res.json({ comments });
  } catch (e) {
    console.error("getTaskComments error:", e);
    return res.status(500).json({ error: "Failed to load comments" });
  }
};

exports.addTaskComment = async (req, res) => {
  try {
    const { taskId } = req.params;
    const { content } = req.body;
    if (!mongoose.isValidObjectId(taskId))
      return res.status(400).json({ error: "Invalid task id" });
    if (!content || !content.trim())
      return res.status(400).json({ error: "Content is required" });
    const task = await ChatTask.findById(taskId);
    if (!task) return res.status(404).json({ error: "Task not found" });

    let comment = await ChatTaskComment.create({
      taskId,
      chatId: task.chatId,
      sender: req.employee._id,
      content: content.trim(),
    });
    comment = await comment.populate({
      path: "sender",
      select: "_id name companyEmail photographUrl avatar",
    });

    emit(req, "chat_task_comment_added", task.chatId, {
      taskId: String(taskId),
      comment,
    });
    return res.status(201).json({ comment });
  } catch (e) {
    console.error("addTaskComment error:", e);
    return res.status(500).json({ error: "Failed to add comment" });
  }
};

exports.deleteTask = async (req, res) => {
  try {
    const { taskId } = req.params;
    const task = await ChatTask.findByIdAndDelete(taskId);
    if (!task) return res.status(404).json({ error: "Task not found" });
    emit(req, "chat_task_deleted", task.chatId, { taskId });
    // Deleting a parent removes its subtasks too (one level deep)
    const subtasks = await ChatTask.find({ parentTaskId: taskId }).select("_id");
    if (subtasks.length) {
      await ChatTask.deleteMany({ parentTaskId: taskId });
      subtasks.forEach((s) =>
        emit(req, "chat_task_deleted", task.chatId, { taskId: String(s._id) })
      );
    }
    // Comments go with their tasks
    await ChatTaskComment.deleteMany({
      taskId: { $in: [taskId, ...subtasks.map((s) => s._id)] },
    });
    return res.json({ success: true });
  } catch (e) {
    console.error("deleteTask error:", e);
    return res.status(500).json({ error: "Failed to delete task" });
  }
};
