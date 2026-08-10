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
    const { Message, Conversation, Space } = require("../models/Chat");
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
      const threadUpdate = {
        parentMessageId: String(parentMessageId),
        conversationId,
        spaceId,
        lastReply: populatedReply,
      };
      target.emit("chat_thread_updated", threadUpdate);

      // The persistent application rail is only in each user's personal
      // socket room. Mirror thread changes there so its aggregate Chat badge
      // updates even when the full Google Chat page is not mounted.
      const audience = spaceId
        ? await Space.findById(spaceId).select("members").lean()
        : await Conversation.findById(conversationId)
            .select("participants")
            .lean();
      const memberIds = spaceId
        ? audience?.members || []
        : audience?.participants || [];
      memberIds.forEach((memberId) => {
        io.to(`user_${String(memberId)}`).emit(
          "chat_thread_updated",
          threadUpdate,
        );
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
    // Deleting a parent removes its subtasks too (one level deep).
    // Their thread parent + title are selected because each one is announced
    // below, exactly like the parent.
    const subtasks = await ChatTask.find({ parentTaskId: taskId }).select(
      "_id title sourceMessageId announcementMessageId"
    );
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

    // The "N tasks created" badge under a source message is derived from the
    // ChatTask rows (see the taskStats aggregation in chatController), and
    // creation announces itself with `message_task_created`. Deletion emitted
    // nothing, so the badge kept its old count until the next refetch. Send the
    // recomputed count rather than a decrement, so the badge can never drift out
    // of step with the panel; 0 hides it entirely on the client.
    const sourceMessageIds = [
      ...new Set(
        [task, ...subtasks]
          .map((t) => t.sourceMessageId && String(t.sourceMessageId))
          .filter(Boolean)
      ),
    ];
    if (sourceMessageIds.length) {
      const remaining = await ChatTask.aggregate([
        {
          $match: {
            sourceMessageId: {
              $in: sourceMessageIds.map((id) => new mongoose.Types.ObjectId(id)),
            },
          },
        },
        {
          $group: {
            _id: "$sourceMessageId",
            taskCount: { $sum: 1 },
            lastTaskCreatedAt: { $max: "$createdAt" },
          },
        },
      ]);
      const statsById = new Map(remaining.map((r) => [String(r._id), r]));
      sourceMessageIds.forEach((messageId) => {
        const stat = statsById.get(messageId);
        emit(req, "message_task_deleted", task.chatId, {
          messageId,
          taskCount: stat?.taskCount || 0,
          lastTaskCreatedAt: stat?.lastTaskCreatedAt || null,
        });
      });
    }

    // Every other lifecycle event — created, assigned, submitted for review,
    // completed, reopened, returned — posts itself into the source message's
    // thread, and the entry's `sender` is what shows WHO did it. Deletion was
    // the one mutation that announced nothing, so a task simply vanished from
    // the panel with no record of who removed it. Posted after the delete
    // succeeds (never announce a deletion that failed); the doc returned by
    // findByIdAndDelete still carries the thread parent and title.
    await postTaskThreadEntry(
      req,
      task,
      `Deleted a task (via Chat)\n${task.title}`
    );
    // A subtask removed along with its parent disappears from its OWN thread
    // just as silently, so announce those too — postTaskThreadEntry is a no-op
    // for any task that has no thread parent.
    for (const s of subtasks) {
      await postTaskThreadEntry(
        req,
        s,
        `Deleted a task (via Chat)\n${s.title}`
      );
    }

    return res.json({ success: true });
  } catch (e) {
    console.error("deleteTask error:", e);
    return res.status(500).json({ error: "Failed to delete task" });
  }
};

/**
 * POST /chat/tasks/from-email
 * Turn an email into a task, from the mail view's message menu.
 *
 * mode "space"    → files it on the CLIENT'S space, resolved automatically from
 *                   the email (ClientInfo.chatSpace). Shared with that space
 *                   like any other space task.
 * mode "personal" → a private to-do with no space at all. It shows up only in
 *                   the task app's Home; nothing else lists it.
 */
exports.createTaskFromEmail = async (req, res) => {
  try {
    const { messageId, mode, title, details, dueAt, assignees } = req.body || {};
    if (!mongoose.isValidObjectId(messageId))
      return res.status(400).json({ error: "Invalid email id" });
    if (!["space", "personal"].includes(String(mode)))
      return res.status(400).json({ error: "mode must be space or personal" });

    const AssignmentMessage = require("../models/AssignmentMessage");
    const ClientInfo = require("../models/ClientInfo");

    const owner = req.employee.owner;
    // Owner-scoped on purpose: an email id from another company must not be
    // readable through this endpoint, let alone turned into one of its tasks.
    const email = await AssignmentMessage.findOne({ _id: messageId, owner })
      .select("_id subject note client threadId")
      .lean();
    if (!email) return res.status(404).json({ error: "Email not found" });

    // The subject is the obvious title; an untitled mail still needs one.
    const resolvedTitle =
      (title && String(title).trim()) ||
      (email.subject && String(email.subject).trim()) ||
      "Task from email";

    const base = {
      owner,
      title: resolvedTitle.slice(0, 300),
      details: String(details || "").trim(),
      dueAt: dueAt ? new Date(dueAt) : null,
      createdBy: req.employee._id,
      sourceEmailId: email._id,
      sourceEmailThreadId: email.threadId || "",
    };

    if (mode === "personal") {
      // Assigned to its creator: Home lists "my work", and a personal task that
      // is nobody's work would never appear there.
      let task = await ChatTask.create({
        ...base,
        isPersonal: true,
        assignees: [req.employee._id],
      });
      task = await task.populate(POPULATE);
      return res.json({ task, mode: "personal" });
    }

    // --- space mode ---
    const clientId =
      email.client && typeof email.client === "object"
        ? email.client._id
        : email.client;
    if (!clientId) {
      return res.status(400).json({
        error:
          "This email is internal — it has no client, so there is no space to file the task in.",
      });
    }

    const client = await ClientInfo.findOne({ _id: clientId, owner })
      .select("_id clientName chatSpace")
      .lean();
    if (!client?.chatSpace) {
      return res.status(400).json({
        error:
          "This client has no space yet, so the task has nowhere to go. Create the client's space first.",
      });
    }

    // Whoever the dialog picked; falling back to the creator so a task is
    // never left belonging to nobody (Home lists "my work" by assignee).
    const chosen = (Array.isArray(assignees) ? assignees : [])
      .filter((a) => mongoose.isValidObjectId(a))
      .map(String);

    let task = await ChatTask.create({
      ...base,
      chatId: client.chatSpace,
      assignees: chosen.length ? chosen : [req.employee._id],
    });
    task = await task.populate(POPULATE);
    notifyAssignees(req, task, task.assignees, req.employee._id);

    // Same room the Tasks side-panel listens on, so it appears without a reload.
    emit(req, "chat_task_created", client.chatSpace, { task });

    return res.json({ task, mode: "space", spaceId: String(client.chatSpace) });
  } catch (e) {
    console.error("createTaskFromEmail error:", e);
    return res.status(500).json({ error: "Failed to create task" });
  }
};

/**
 * GET /chat/tasks/personal
 * The caller's own personal tasks. Home is the only screen that calls this —
 * space listings query by chatId and therefore never see these.
 */
exports.getPersonalTasks = async (req, res) => {
  try {
    const tasks = await ChatTask.find({
      owner: req.employee.owner,
      isPersonal: true,
      createdBy: req.employee._id,
    })
      .sort({ done: 1, createdAt: -1 })
      .populate(POPULATE)
      .lean();
    return res.json({ tasks });
  } catch (e) {
    console.error("getPersonalTasks error:", e);
    return res.status(500).json({ error: "Failed to load personal tasks" });
  }
};

/**
 * GET /chat/tasks/from-email/:messageId/options
 * What the "Create task" dialog needs before it can offer anything: the
 * default title, whether this email has a client space to file a task in, and
 * who can be assigned there.
 */
exports.getEmailTaskOptions = async (req, res) => {
  try {
    const { messageId } = req.params;
    if (!mongoose.isValidObjectId(messageId))
      return res.status(400).json({ error: "Invalid email id" });

    const AssignmentMessage = require("../models/AssignmentMessage");
    const ClientInfo = require("../models/ClientInfo");
    const { Space } = require("../models/Chat");

    const owner = req.employee.owner;
    const email = await AssignmentMessage.findOne({ _id: messageId, owner })
      .select("_id subject client")
      .lean();
    if (!email) return res.status(404).json({ error: "Email not found" });

    const clientId =
      email.client && typeof email.client === "object"
        ? email.client._id
        : email.client;

    const result = {
      defaultTitle: (email.subject || "").trim() || "Task from email",
      hasClient: !!clientId,
      clientName: "",
      spaceId: null,
      spaceName: "",
      // Assignable people = the client space's own members. Empty for personal
      // tasks, which are always the creator's own.
      members: [],
    };

    if (clientId) {
      const client = await ClientInfo.findOne({ _id: clientId, owner })
        .select("_id clientName chatSpace")
        .lean();
      result.clientName = client?.clientName || "";
      if (client?.chatSpace) {
        const space = await Space.findById(client.chatSpace)
          .select("_id name members")
          .populate({
            path: "members",
            select: "_id name companyEmail photographUrl",
          })
          .lean();
        if (space) {
          result.spaceId = String(space._id);
          result.spaceName = space.name || "";
          result.members = (space.members || []).filter(Boolean).map((m) => ({
            _id: String(m._id),
            name: m.name || "",
            companyEmail: m.companyEmail || "",
            photographUrl: m.photographUrl || "",
          }));
        }
      }
    }

    return res.json(result);
  } catch (e) {
    console.error("getEmailTaskOptions error:", e);
    return res.status(500).json({ error: "Failed to load task options" });
  }
};
