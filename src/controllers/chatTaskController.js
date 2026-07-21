// CRUD for space (Google-Chat) tasks. Realtime: every mutation emits to the
// `space_<chatId>` socket room so all members' Tasks panels stay in sync.
const mongoose = require("mongoose");
const ChatTask = require("../models/ChatTask");
const ChatTaskComment = require("../models/ChatTaskComment");

const POPULATE = [
  { path: "assignees", select: "_id name companyEmail photographUrl avatar" },
  { path: "createdBy", select: "_id name companyEmail photographUrl avatar" },
  { path: "reviewRequestedBy", select: "_id name companyEmail photographUrl avatar" },
];

const emit = (req, event, chatId, payload) => {
  try {
    const io = req.app.get("io");
    // chatId is a space id for space tasks and a conversation id for 1:1 DM
    // tasks. Members join `space_<id>` for spaces and `conversation_<id>` for
    // DMs, so broadcast to both rooms (the irrelevant one is simply empty).
    io
      ?.to(`space_${chatId}`)
      .to(`conversation_${chatId}`)
      .emit(event, { chatId: String(chatId), ...payload });
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

// Post a system-style entry into the task's chat thread. Direct Tasks-panel
// tasks use their generated announcement message as the thread parent.
const postTaskThreadEntry = async (req, task, content) => {
  const parentMessageId =
    task?.sourceMessageId || task?.announcementMessageId;
  if (!parentMessageId) return;
  try {
    const { Message } = require("../models/Chat");
    const ChatThread = require("../models/ChatThread");
    const parentMsg = await Message.findById(parentMessageId).select(
      "conversation space"
    );
    if (!parentMsg) return;
    const threadEntry = await ChatThread.create({
      parentMessageId,
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
      io.to(`thread_${parentMessageId}`).emit(
        "new_chat_thread_reply",
        populatedReply
      );
      const conversationId = String(parentMsg.conversation);
      const spaceId = parentMsg.space ? String(parentMsg.space) : null;
      let target = io.to(`conversation_${conversationId}`);
      if (spaceId) target = target.to(`space_${spaceId}`);
      target.emit("chat_thread_updated", {
        parentMessageId: String(parentMessageId),
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

    // Task created from a message → let the chat put a badge under it
    if (task.sourceMessageId) {
      emit(req, "message_task_created", chatId, {
        messageId: String(task.sourceMessageId),
        taskId: String(task._id),
        createdAt: task.createdAt,
      });

      // Mirror Google Chat: the task creation shows up inside the message's
      // thread ("Created a task (via Chat)"), so the thread chat covers it.
      await postTaskThreadEntry(
        req,
        task,
        `Created a task (via Chat)\n${task.title}`
      );
      // Assigned right at creation → announce that in the thread too
      if (Array.isArray(task.assignees) && task.assignees.length > 0) {
        const names = task.assignees
          .map((a) => `@${a.name || "member"}`)
          .join(", ");
        await postTaskThreadEntry(
          req,
          task,
          `Assigned a task to ${names} (via Chat)`
        );
      }
    } else {
      // Task created straight from the Tasks panel → announce it as a message
      // in the space conversation ("Created a task (via Chat)" + title)
      try {
        const { Conversation, Message, Space } = require("../models/Chat");
        const space = await Space.findById(chatId).select("members");
        const conversation = await Conversation.findOne({ space: chatId });
        if (space && conversation) {
          const receivers = space.members.filter(
            (m) => String(m) !== String(req.employee._id)
          );
          const message = new Message({
            conversation: conversation._id,
            sender: req.employee._id,
            receivers,
            space: chatId,
            content: `Created a task (via Chat)\n${task.title}`,
            messageType: "text",
            isGroupMessage: true,
            readBy: [{ employee: req.employee._id, readAt: new Date() }],
          });
          await message.save();

          // Keep assignment activity attached to this generated conversation
          // message without treating it as a user message converted to a task.
          task.announcementMessageId = message._id;
          await task.save();

          conversation.lastMessage = message._id;
          conversation.updatedAt = new Date();
          if (!conversation.unreadCount) conversation.unreadCount = new Map();
          receivers.forEach((rid) => {
            const cur = conversation.unreadCount.get(String(rid)) || 0;
            conversation.unreadCount.set(String(rid), cur + 1);
          });
          await conversation.save();

          const populatedMessage = await Message.findById(message._id)
            .populate("sender", "name companyEmail avatar photographUrl")
            .populate("space");
          const io = req.app.get("io");
          if (io) {
            // viaTasks lets the creator's own client render it live — clients
            // normally drop their own incoming messages (optimistic-send dedupe)
            const payload = { ...populatedMessage.toObject(), viaTasks: true };
            io.to(`space_${chatId}`).emit("receive_space_message", payload);
            receivers.forEach((rid) =>
              io.to(`user_${String(rid)}`).emit("receive_space_message", payload)
            );
            io.to(`user_${String(req.employee._id)}`).emit(
              "receive_space_message",
              payload
            );
          }

          // Choosing an assignee while drafting creates the task immediately,
          // so cover that POST path as well as later PATCH assignments.
          if (Array.isArray(task.assignees) && task.assignees.length > 0) {
            const names = task.assignees
              .map((a) => `@${a.name || "member"}`)
              .join(", ");
            await postTaskThreadEntry(
              req,
              task,
              `Assigned a task to ${names} (via Chat)`
            );
          }
        }
      } catch (e) {
        console.error("task chat announce error:", e.message);
      }
    }
    // Emit after a direct-panel task has been linked to its announcement so
    // every Tasks panel receives the complete task document.
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
    // Populate assignees so we know the PREVIOUS assignees' names — needed to
    // describe reassignments ("from @X to @Y") and unassignments in the thread.
    const task = await ChatTask.findById(taskId).populate("assignees", "_id name");
    if (!task) return res.status(404).json({ error: "Task not found" });

    // Remember who was already assigned so we only notify NEW assignees and can
    // report who was removed.
    const prevAssigneeObjs = (task.assignees || []).map((a) => ({
      _id: String(a?._id || a),
      name: a?.name,
    }));
    const prevAssignees = prevAssigneeObjs.map((a) => a._id);
    const prevDone = task.done;
    const prevInReview = !!task.inReview;

    const { title, details, dueAt, assignees, done } = req.body;
    if (typeof title === "string" && title.trim()) task.title = title.trim();
    if (typeof details === "string") task.details = details.trim();
    if (dueAt !== undefined) task.dueAt = dueAt ? new Date(dueAt) : null;
    if (Array.isArray(assignees))
      task.assignees = assignees.filter((a) => mongoose.isValidObjectId(a));
    if (typeof done === "boolean") {
      const isCreator = String(task.createdBy) === String(req.employee._id);
      if (done && !isCreator) {
        // An assignee (or any non-creator) completing the task sends it to
        // REVIEW — only the creator's completion actually closes it.
        task.inReview = true;
        task.reviewRequestedBy = req.employee._id;
        task.reviewRequestedAt = new Date();
        task.done = false;
        task.completedAt = null;
      } else {
        // Creator completing (approving a review or closing directly), or
        // anyone un-checking → also clears any pending review.
        task.done = done;
        task.completedAt = done ? new Date() : null;
        task.inReview = false;
        if (!done) {
          task.reviewRequestedBy = null;
          task.reviewRequestedAt = null;
        }
      }
    }
    await task.save();
    const populated = await task.populate(POPULATE);

    emit(req, "chat_task_updated", task.chatId, { task: populated });
    if (Array.isArray(assignees)) {
      const newAssignees = populated.assignees || [];
      const newIds = newAssignees.map((a) => String(a._id));
      const added = newAssignees.filter(
        (a) => !prevAssignees.includes(String(a._id)),
      );
      const removed = prevAssigneeObjs.filter(
        (a) => !newIds.includes(a._id),
      );

      // Notify only the newly added assignees.
      notifyAssignees(req, populated, added, req.employee._id);

      // Announce the assignee change in the source message's thread, Google-Chat
      // style: assign / reassign / unassign.
      const fmt = (list) =>
        list.map((a) => `@${a.name || "member"}`).join(", ");
      let activity = null;
      if (added.length > 0 && removed.length > 0) {
        activity = `Changed task assignee from ${fmt(removed)} to ${fmt(added)} (via Chat)`;
      } else if (added.length > 0) {
        activity = `Assigned a task to ${fmt(added)} (via Chat)`;
      } else if (removed.length > 0) {
        activity = `Unassigned a task from ${fmt(removed)} (via Chat)`;
      }
      if (activity) {
        await postTaskThreadEntry(req, populated, activity);
      }
    }
    // Announce completion / review / reopen in the task's thread, Google-Chat style
    if (populated.inReview && !prevInReview) {
      await postTaskThreadEntry(
        req,
        populated,
        `Submitted a task for review (via Chat)\n${populated.title}`
      );
      // Ping the creator that this task awaits their review
      try {
        const io = req.app.get("io");
        const creatorId = String(
          populated.createdBy?._id || populated.createdBy
        );
        if (io && creatorId !== String(req.employee._id)) {
          io.to(`user_${creatorId}`).emit("chat_task_review_requested", {
            chatId: String(populated.chatId),
            taskId: String(populated._id),
            title: populated.title,
            requestedByName: req.employee?.name || "Someone",
          });
        }
      } catch (e) {
        /* non-fatal */
      }
    } else if (typeof done === "boolean" && populated.done !== prevDone) {
      await postTaskThreadEntry(
        req,
        populated,
        populated.done
          ? `Completed a task (via Chat)\n${populated.title}`
          : `Reopened a task (via Chat)\n${populated.title}`
      );
    } else if (prevInReview && !populated.inReview && !populated.done) {
      await postTaskThreadEntry(
        req,
        populated,
        `Returned a task for changes (via Chat)\n${populated.title}`
      );
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
