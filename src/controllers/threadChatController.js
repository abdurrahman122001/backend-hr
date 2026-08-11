const ThreadChatMessage = require("../models/ThreadChatMessage");
const AssignmentMessage = require("../models/AssignmentMessage");
const Employee = require("../models/Employees");
const ClientInfo = require("../models/ClientInfo");
const mongoose = require("mongoose");
const path = require("path");

// Utility functions
const isObjId = (v) => mongoose.isValidObjectId(v);
const oid = (v) => mongoose.isValidObjectId(v) ? new mongoose.Types.ObjectId(v) : null;

function buildIdVariants(value) {
  const variants = [];
  const seen = new Set();

  const pushValue = (candidate) => {
    if (candidate == null) return;
    const str = String(candidate);
    if (!seen.has(str)) {
      seen.add(str);
      variants.push(candidate);
      variants.push(str);
    }
    if (isObjId(str)) {
      const objectId = oid(str);
      const objectIdStr = objectId ? String(objectId) : null;
      if (objectIdStr && !seen.has(objectIdStr)) {
        seen.add(objectIdStr);
        variants.push(objectId);
      }
    }
  };

  if (Array.isArray(value)) {
    value.forEach(pushValue);
  } else {
    pushValue(value);
  }

  return variants;
}

function buildRecipientMatch(userId) {
  const variants = buildIdVariants(userId);
  return {
    $or: [
      { receiver: { $in: variants } },
    ],
  };
}

function buildParticipantMatch(userId) {
  const variants = buildIdVariants(userId);
  return {
    $or: [
      { sender: { $in: variants } },
      { receiver: { $in: variants } },
    ],
  };
}

function normalizeReceiverIds(receiver) {
  if (!receiver) return [];
  const values = Array.isArray(receiver) ? receiver : [receiver];

  return values
    .map((id) => {
      if (!id) return null;
      const idStr = String(id);
      if (isObjId(id) || isObjId(idStr)) {
        return oid(idStr);
      }
      return null;
    })
    .filter(Boolean);
}

function buildPublicUrl(req, filename) {
  const base = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`;
  return `${base}/upload/${filename}`;
}

// Get IO instance
function getIO(req) {
  return req.app.get("io");
}

// Apply visibility rules
async function applyVisibility(q, req) {
  if (!req.employee?._id) {
    return { _id: null };
  }

  const me = oid(String(req.employee._id));
  if (!me) {
    return { _id: null };
  }

  const ownerId = req.employee?.owner ? oid(req.employee.owner) : null;

  // Base filter: user must be participant
  const participantFilter = buildParticipantMatch(me);

  const visibilityQuery = {
    $and: [participantFilter]
  };

  // Add owner filter if available
  if (ownerId) {
    visibilityQuery.$and.push({ owner: ownerId });
  }

  // Add threadId if present
  if (q.threadId) {
    visibilityQuery.$and.push({ threadId: q.threadId });
  }

  // Apply other filters
  if (q.isDeleted !== undefined) {
    visibilityQuery.$and.push({ isDeleted: q.isDeleted });
  }

  return visibilityQuery;
}

// Emit to thread participants
async function emitToThreadParticipants(io, message, eventName = "new_thread_chat_message") {
  try {
    const populatedMessage = await ThreadChatMessage.findById(message._id)
      .populate("owner")
      .populate("sender")
      .populate("receiver")
      .populate("client")
      .populate({ path: "assignmentMessageId", select: "subject" });

    if (!populatedMessage) return;

    // Get all participants in this thread, including assignment and client-based participants
    const participants = await getImmediateThreadParticipants(populatedMessage.threadId);

    // Also add current message participants
    const currentParticipants = new Set();

    // Add sender
    const senderId = String(
      typeof populatedMessage.sender === "string"
        ? populatedMessage.sender
        : populatedMessage.sender?._id
    );
    if (senderId && senderId !== 'undefined') {
      currentParticipants.add(senderId);
    }

    // Add receivers
    if (Array.isArray(populatedMessage.receiver)) {
      populatedMessage.receiver.forEach((receiver) => {
        const receiverId = String(
          typeof receiver === "string" ? receiver : receiver?._id
        );
        if (receiverId && receiverId !== 'undefined') {
          currentParticipants.add(receiverId);
        }
      });
    }

    // Combine all participants
    const allParticipants = new Set([...participants, ...currentParticipants]);

    // Emit to all participants
    allParticipants.forEach((participantId) => {
      if (participantId) {
        io.to(`employee_${participantId}`).emit(eventName, populatedMessage);
        io.to(`thread_${populatedMessage.threadId}_${participantId}`).emit(eventName, populatedMessage);
      }
    });

    // Also emit to thread room
    io.to(`thread_${populatedMessage.threadId}`).emit(eventName, populatedMessage);

  } catch (error) {
    console.error("❌ Error in emitToThreadParticipants:", error);
    throw error;
  }
}

// NEW: Get immediate thread participants with assignment message context
async function getImmediateThreadParticipants(threadId) {
  try {
    // First, get the main assignment message to get initial participants
    const assignmentMessage = await AssignmentMessage.findOne({ threadId })
      .populate([
        { path: "sender", select: "_id name companyEmail role photographUrl" },
        { path: "receiver", select: "_id name companyEmail role photographUrl" },
        { path: "client", select: "_id clientName legalBusinessName dba" }
      ]);

    if (!assignmentMessage) {
      return [];
    }

    // Collect participants from assignment message
    const participants = new Map();

    // Add sender
    if (assignmentMessage.sender) {
      const sender = assignmentMessage.sender;
      if (sender._id) {
        participants.set(sender._id.toString(), {
          _id: sender._id,
          name: sender.name,
          companyEmail: sender.companyEmail,
          role: sender.role,
          photographUrl: sender.photographUrl,
          isFromAssignment: true
        });
      }
    }

    // Add receivers
    if (Array.isArray(assignmentMessage.receiver)) {
      assignmentMessage.receiver.forEach(receiver => {
        if (receiver && receiver._id) {
          participants.set(receiver._id.toString(), {
            _id: receiver._id,
            name: receiver.name,
            companyEmail: receiver.companyEmail,
            role: receiver.role,
            photographUrl: receiver.photographUrl,
            isFromAssignment: true
          });
        }
      });
    }

    // Also get participants from chat messages (if any)
    const chatParticipants = await ThreadChatMessage.getThreadParticipants(threadId);

    if (chatParticipants.length > 0) {
      const employeeDetails = await Employee.find(
        { _id: { $in: chatParticipants } },
        "_id name companyEmail role photographUrl"
      );

      employeeDetails.forEach(emp => {
        if (!participants.has(emp._id.toString())) {
          participants.set(emp._id.toString(), {
            _id: emp._id,
            name: emp.name,
            companyEmail: emp.companyEmail,
            role: emp.role,
            photographUrl: emp.photographUrl,
            isFromChat: true
          });
        }
      });
    }

    // Include assigned and supervised employees from the client, if available.
    if (assignmentMessage.client) {
      const client = await ClientInfo.findById(assignmentMessage.client)
        .select("assignedTo supervisedBy")
        .populate([
          { path: "assignedTo", select: "_id name companyEmail role photographUrl" },
          { path: "supervisedBy", select: "_id name companyEmail role photographUrl" },
        ]);

      if (client) {
        const addEmployee = (emp) => {
          if (emp && emp._id && !participants.has(emp._id.toString())) {
            participants.set(emp._id.toString(), {
              _id: emp._id,
              name: emp.name,
              companyEmail: emp.companyEmail,
              role: emp.role,
              photographUrl: emp.photographUrl,
              isFromClientAssignment: true
            });
          }
        };

        if (Array.isArray(client.assignedTo)) {
          client.assignedTo.forEach(addEmployee);
        }

        if (Array.isArray(client.supervisedBy)) {
          client.supervisedBy.forEach(addEmployee);
        }
      }
    }

    return Array.from(participants.values());

  } catch (error) {
    console.error("❌ Error in getImmediateThreadParticipants:", error);
    return [];
  }
}

// Create a new thread chat message
exports.createThreadChatMessage = async function (req, res) {
  try {
    const { threadId, content, receiver, replyTo, messageType = "text" } = req.body;

    // Validate required fields
    if (!threadId) {
      return res.status(400).json({ error: "Thread ID is required" });
    }

    if (!content || content.trim() === "") {
      return res.status(400).json({ error: "Message content is required" });
    }

    const sender = req.employee?._id;
    const owner = req.employee?.owner;

    if (!isObjId(sender) || !isObjId(owner)) {
      return res.status(400).json({ error: "Valid sender and owner are required" });
    }

    // Check if thread exists (via AssignmentMessage)
    const threadExists = await AssignmentMessage.findOne({ threadId });
    if (!threadExists) {
      return res.status(404).json({ error: "Thread not found" });
    }

    // Process receivers
    let receivers = [];
    if (receiver) {
      const rawReceivers = Array.isArray(receiver) ? receiver : [receiver];
      receivers = normalizeReceiverIds(rawReceivers);
    }

    // If no receivers specified, use the thread's immediate participants.
    if (receivers.length === 0) {
      const participants = await getImmediateThreadParticipants(threadId);
      receivers = participants
        .map((participant) => String(participant._id))
        .filter((participantId) => participantId && participantId !== String(sender));
    }

    // Remove sender from receivers
    receivers = receivers.filter(id => id !== String(sender));

    // Validate at least one receiver
    if (receivers.length === 0) {
      return res.status(400).json({ error: "At least one receiver is required" });
    }

    // Check if replyTo exists
    if (replyTo && isObjId(replyTo)) {
      const replyMessage = await ThreadChatMessage.findById(replyTo);
      if (!replyMessage) {
        return res.status(404).json({ error: "Reply message not found" });
      }
    }

    // Create message
    const messageData = {
      threadId,
      owner,
      sender,
      receiver: receivers,
      content: content,
      messageType,
      isFormatted: content.includes('<') && content.includes('>'),
      replyTo: replyTo || undefined,
      client: threadExists.client || undefined,
      assignmentMessageId: threadExists._id
    };

    const message = await ThreadChatMessage.create(messageData);

    // Mark as read by sender
    await message.markAsRead(sender);

    // Populate message
    const populated = await message.populate([
      { path: "owner", select: "_id name companyEmail" },
      { path: "sender", select: "_id name companyEmail role photographUrl" },
      { path: "receiver", select: "_id name companyEmail role" },
      { path: "client", select: "_id clientName legalBusinessName dba" },
      { path: "replyTo", select: "_id content sender" },
      { path: "replyTo.sender", select: "_id name companyEmail" },
    ]);

    // Emit real-time event
    const io = getIO(req);
    if (io) {
      await emitToThreadParticipants(io, message, "new_thread_chat_message");
    }

    res.status(201).json({
      success: true,
      message: "Message sent successfully",
      data: populated
    });

  } catch (e) {
    console.error("❌ Error in createThreadChatMessage:", e);
    if (e.name === "ValidationError") {
      return res.status(400).json({
        error: "Validation failed",
        details: Object.values(e.errors).map(err => err.message)
      });
    }
    res.status(500).json({ error: "Failed to send message" });
  }
};

// Get messages for a thread (UPDATED with immediate participants)
exports.getThreadMessages = async function (req, res) {
  try {
    const { threadId } = req.params;
    const { limit = 50, page = 1, before, after } = req.query;

    if (!threadId) {
      return res.status(400).json({ error: "Thread ID is required" });
    }

    // Verify thread exists and user has access
    const thread = await AssignmentMessage.findOne({ threadId });
    if (!thread) {
      return res.status(404).json({ error: "Thread not found" });
    }

    // Get immediate participants first
    const participants = await getImmediateThreadParticipants(threadId);

    // Build query
    const q = {
      threadId,
      isDeleted: false
    };

    // Apply date filters
    if (before) {
      const beforeDate = new Date(before);
      if (!isNaN(beforeDate)) {
        q.createdAt = { $lt: beforeDate };
      }
    }

    if (after) {
      const afterDate = new Date(after);
      if (!isNaN(afterDate)) {
        q.createdAt = q.createdAt || {};
        q.createdAt.$gt = afterDate;
      }
    }

    // Apply visibility
    const qFinal = await applyVisibility(q, req);

    // Pagination
    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);

    // Get messages
    const [messages, total] = await Promise.all([
      ThreadChatMessage.find(qFinal)
        .sort({ createdAt: -1 }) // Newest first
        .skip((pageNum - 1) * lim)
        .limit(lim)
        .populate([
          { path: "owner", select: "_id name companyEmail" },
          { path: "sender", select: "_id name companyEmail role photographUrl" },
          { path: "receiver", select: "_id name companyEmail role" },
          { path: "client", select: "_id clientName legalBusinessName dba" },
          { path: "replyTo", select: "_id content sender createdAt" },
          { path: "replyTo.sender", select: "_id name companyEmail" },
          { path: "attachments.uploadedBy", select: "_id name companyEmail" },
          { path: "reactions.employee", select: "_id name companyEmail" },
        ])
        .lean(),
      ThreadChatMessage.countDocuments(qFinal)
    ]);

    // Mark messages as read for current user
    const currentUser = req.employee._id;
    const unreadMessages = messages.filter(msg =>
      !msg.readBy.some(read => read.employee.toString() === currentUser.toString())
    );

    if (unreadMessages.length > 0) {
      await ThreadChatMessage.updateMany(
        { _id: { $in: unreadMessages.map(msg => msg._id) } },
        { $push: { readBy: { employee: currentUser, readAt: new Date() } } }
      );

      // Opening a thread is a read — drop this user's rail badge right away
      // instead of waiting for the next poll.
      const io = getIO(req);
      if (io) {
        io.to(`employee_${currentUser}`).emit("thread_chat_read", {
          threadId,
          userId: String(currentUser),
          timestamp: new Date()
        });
      }
    }

    // `messages` is a .lean() snapshot taken BEFORE the updateMany above, so
    // the rows we just marked read still look unread in it. Report them as read
    // — otherwise the panel loads showing an unread count for messages the
    // server already considers read, and only self-corrects by firing one
    // mark-read request per message.
    const justMarkedRead = new Set(unreadMessages.map(msg => String(msg._id)));

    // Format response
    const formattedMessages = messages.map(msg => {
      const readNow = justMarkedRead.has(String(msg._id));
      return {
        ...msg,
        // sender populates to null if that employee was deleted — reading
        // ._id off it blew up the whole thread load with a 500.
        isMe: String(msg.sender?._id || msg.sender || "") === String(currentUser),
        isRead:
          readNow ||
          msg.readBy.some(read => read.employee.toString() === currentUser.toString()),
        readCount: msg.readBy.length + (readNow ? 1 : 0),
        reactionCount: msg.reactions.length
      };
    }).reverse(); // Reverse to show oldest first for display

    res.json({
      success: true,
      data: formattedMessages,
      participants: participants, // Send participants immediately
      pagination: {
        total,
        page: pageNum,
        pages: Math.ceil(total / lim),
        limit: lim,
        hasMore: total > pageNum * lim
      },
      threadInfo: {
        threadId,
        subject: thread.subject,
        client: thread.client,
        assignmentMessageId: thread._id
      }
    });

  } catch (e) {
    console.error("❌ Error in getThreadMessages:", e);
    res.status(500).json({ error: "Failed to fetch thread messages" });
  }
};

// Get thread info (OPTIMIZED for immediate response)
exports.getThreadInfo = async function (req, res) {
  try {
    const { threadId } = req.params;

    if (!threadId) {
      return res.status(400).json({ error: "Thread ID is required" });
    }

    // A thread is named after the mail that STARTED it, so this must be the
    // oldest message — never "whichever one the query plan hands back first".
    // Unsorted, this rode on the `threadId_1` index happening to return
    // insertion order; the moment the planner picked `threadId_1_createdAt_-1`
    // instead it would have flipped to the newest message and silently
    // re-titled every thread in this panel.
    const thread = await AssignmentMessage.findOne({ threadId })
      .sort({ createdAt: 1 })
      .populate([
        { path: "owner", select: "_id name companyEmail" },
        { path: "sender", select: "_id name companyEmail role photographUrl" },
        { path: "receiver", select: "_id name companyEmail role photographUrl" },
        { path: "client", select: "_id clientName legalBusinessName dba" },
      ]);

    if (!thread) {
      return res.status(404).json({ error: "Thread not found" });
    }

    const uniqueParticipants = await getImmediateThreadParticipants(threadId);

    // Get latest message if exists
    let latestMessage = null;
    try {
      latestMessage = await ThreadChatMessage.findOne({ threadId, isDeleted: false })
        .sort({ createdAt: -1 })
        .populate("sender", "_id name companyEmail")
        .lean();
    } catch (error) {
      console.log("No chat messages yet");
    }

    // Get unread count for current user
    const currentUser = req.employee._id;
    let unreadCount = 0;
    try {
      unreadCount = await ThreadChatMessage.countDocuments({
        threadId,
        isDeleted: false,
        'readBy.employee': { $ne: currentUser },
        $or: [
          { sender: currentUser },
          { receiver: currentUser },
          { receiver: { $in: [currentUser] } }
        ]
      });
    } catch (error) {
      console.log("Error counting unread messages:", error);
    }

    // Get total message count
    let totalMessages = 0;
    try {
      totalMessages = await ThreadChatMessage.countDocuments({
        threadId,
        isDeleted: false
      });
    } catch (error) {
      console.log("Error counting messages:", error);
    }

    res.json({
      success: true,
      data: {
        threadId,
        subject: thread.subject,
        client: thread.client,
        assignmentMessage: {
          id: thread._id,
          subject: thread.subject,
          note: thread.note,
          status: thread.status,
          approvalStatus: thread.approvalStatus,
          sender: thread.sender,
          receiver: thread.receiver
        },
        participants: uniqueParticipants, // Send immediate participants
        latestMessage,
        stats: {
          totalMessages,
          unreadCount,
          participantCount: uniqueParticipants.length
        },
        createdAt: thread.createdAt,
        updatedAt: thread.updatedAt
      }
    });

  } catch (e) {
    console.error("❌ Error in getThreadInfo:", e);
    res.status(500).json({ error: "Failed to fetch thread info" });
  }
};

// NEW: Get thread participants immediately (separate endpoint)
exports.getThreadParticipantsImmediate = async function (req, res) {
  try {
    const { threadId } = req.params;

    if (!threadId) {
      return res.status(400).json({ error: "Thread ID is required" });
    }

    const participants = await getImmediateThreadParticipants(threadId);

    res.json({
      success: true,
      data: participants,
      count: participants.length
    });

  } catch (e) {
    console.error("❌ Error in getThreadParticipantsImmediate:", e);
    res.status(500).json({ error: "Failed to fetch participants" });
  }
};

// Get thread participants (original, for backward compatibility)
exports.getThreadParticipants = async function (req, res) {
  try {
    const { threadId } = req.params;

    if (!threadId) {
      return res.status(400).json({ error: "Thread ID is required" });
    }

    const participants = await getImmediateThreadParticipants(threadId);

    res.json({
      success: true,
      data: participants,
      count: participants.length
    });

  } catch (e) {
    console.error("❌ Error in getThreadParticipants:", e);
    res.status(500).json({ error: "Failed to fetch participants" });
  }
};

// Edit a message
exports.editMessage = async function (req, res) {
  try {
    const { id } = req.params;
    const { content } = req.body;
    const currentUser = req.employee._id;

    if (!isObjId(id)) {
      return res.status(400).json({ error: "Invalid message ID" });
    }

    if (!content || content.trim() === "") {
      return res.status(400).json({ error: "Content is required" });
    }

    const message = await ThreadChatMessage.findById(id);
    if (!message) {
      return res.status(404).json({ error: "Message not found" });
    }

    // Check permissions - only sender can edit
    if (String(message.sender) !== String(currentUser)) {
      return res.status(403).json({ error: "You can only edit your own messages" });
    }

    // Check if message is too old (e.g., 15 minutes)
    const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000);
    if (message.createdAt < fifteenMinutesAgo) {
      return res.status(400).json({ error: "Message is too old to edit" });
    }

    // Edit message
    await message.edit(content, currentUser);

    // Populate updated message
    const populated = await ThreadChatMessage.findById(message._id)
      .populate([
        { path: "sender", select: "_id name companyEmail role photographUrl" },
        { path: "editHistory.editedBy", select: "_id name companyEmail" }
      ]);

    // Emit update event
    const io = getIO(req);
    if (io) {
      io.to(`thread_${message.threadId}`).emit("thread_chat_message_updated", {
        message: populated,
        action: "edited",
        timestamp: new Date()
      });
    }

    res.json({
      success: true,
      message: "Message edited successfully",
      data: populated
    });

  } catch (e) {
    console.error("❌ Error in editMessage:", e);
    res.status(500).json({ error: "Failed to edit message" });
  }
};

// Delete a message (soft delete)
exports.deleteMessage = async function (req, res) {
  try {
    const { id } = req.params;
    const currentUser = req.employee._id;

    if (!isObjId(id)) {
      return res.status(400).json({ error: "Invalid message ID" });
    }

    const message = await ThreadChatMessage.findById(id);
    if (!message) {
      return res.status(404).json({ error: "Message not found" });
    }

    // Check permissions - only sender can delete
    if (String(message.sender) !== String(currentUser)) {
      return res.status(403).json({ error: "You can only delete your own messages" });
    }

    // Soft delete
    message.isDeleted = true;
    message.deletedBy = currentUser;
    message.deletedAt = new Date();
    await message.save();

    // Emit delete event
    const io = getIO(req);
    if (io) {
      io.to(`thread_${message.threadId}`).emit("thread_chat_message_deleted", {
        messageId: id,
        threadId: message.threadId,
        deletedBy: currentUser,
        timestamp: new Date()
      });
    }

    res.json({
      success: true,
      message: "Message deleted successfully"
    });

  } catch (e) {
    console.error("❌ Error in deleteMessage:", e);
    res.status(500).json({ error: "Failed to delete message" });
  }
};

// Add reaction to message
exports.addReaction = async function (req, res) {
  try {
    const { id } = req.params;
    const { emoji } = req.body;
    const currentUser = req.employee._id;

    if (!isObjId(id)) {
      return res.status(400).json({ error: "Invalid message ID" });
    }

    if (!emoji) {
      return res.status(400).json({ error: "Emoji is required" });
    }

    const message = await ThreadChatMessage.findById(id);
    if (!message) {
      return res.status(404).json({ error: "Message not found" });
    }

    // Add reaction
    await message.addReaction(currentUser, emoji);

    // Populate message with reactions
    const populated = await ThreadChatMessage.findById(message._id)
      .populate("reactions.employee", "_id name companyEmail");

    // Emit reaction event
    const io = getIO(req);
    if (io) {
      io.to(`thread_${message.threadId}`).emit("thread_chat_message_reacted", {
        messageId: id,
        threadId: message.threadId,
        reactions: populated.reactions,
        timestamp: new Date()
      });
    }

    res.json({
      success: true,
      message: "Reaction added",
      data: {
        reactions: populated.reactions
      }
    });

  } catch (e) {
    console.error("❌ Error in addReaction:", e);
    res.status(500).json({ error: "Failed to add reaction" });
  }
};

// Remove reaction from message
exports.removeReaction = async function (req, res) {
  try {
    const { id } = req.params;
    const currentUser = req.employee._id;

    if (!isObjId(id)) {
      return res.status(400).json({ error: "Invalid message ID" });
    }

    const message = await ThreadChatMessage.findById(id);
    if (!message) {
      return res.status(404).json({ error: "Message not found" });
    }

    // Remove reaction
    await message.removeReaction(currentUser);

    // Populate message with reactions
    const populated = await ThreadChatMessage.findById(message._id)
      .populate("reactions.employee", "_id name companyEmail");

    // Emit reaction event
    const io = getIO(req);
    if (io) {
      io.to(`thread_${message.threadId}`).emit("thread_chat_message_reacted", {
        messageId: id,
        threadId: message.threadId,
        reactions: populated.reactions,
        timestamp: new Date()
      });
    }

    res.json({
      success: true,
      message: "Reaction removed",
      data: {
        reactions: populated.reactions
      }
    });

  } catch (e) {
    console.error("❌ Error in removeReaction:", e);
    res.status(500).json({ error: "Failed to remove reaction" });
  }
};

// Upload attachments
exports.uploadAttachments = async function (req, res) {
  try {
    const { threadId } = req.params;
    const currentUser = req.employee._id;

    if (!threadId) {
      return res.status(400).json({ error: "Thread ID is required" });
    }

    const files = req.files || [];
    if (files.length === 0) {
      return res.status(400).json({ error: "No files uploaded" });
    }

    // Check thread access
    const thread = await AssignmentMessage.findOne({ threadId });
    if (!thread) {
      return res.status(404).json({ error: "Thread not found" });
    }

    // Create attachment messages
    const attachmentMessages = [];

    for (const file of files) {
      const messageData = {
        threadId,
        owner: req.employee.owner,
        sender: currentUser,
        receiver: [thread.sender, ...thread.receiver].filter(id =>
          id && String(id) !== String(currentUser)
        ),
        content: `Shared file: ${file.originalname}`,
        messageType: "file",
        attachments: [{
          filename: path.basename(file.filename),
          originalName: file.originalname,
          mimetype: file.mimetype,
          size: file.size,
          url: buildPublicUrl(req, file.filename),
          uploadedAt: new Date(),
          uploadedBy: currentUser,
        }]
      };

      const message = await ThreadChatMessage.create(messageData);
      await message.markAsRead(currentUser);

      const populated = await message.populate([
        { path: "sender", select: "_id name companyEmail role photographUrl" },
        { path: "attachments.uploadedBy", select: "_id name companyEmail" }
      ]);

      attachmentMessages.push(populated);

      // Emit event for each file
      const io = getIO(req);
      if (io) {
        await emitToThreadParticipants(io, message, "new_thread_chat_message");
      }
    }

    res.status(201).json({
      success: true,
      message: `${files.length} file(s) uploaded successfully`,
      data: attachmentMessages
    });

  } catch (e) {
    console.error("❌ Error in uploadAttachments:", e);
    res.status(500).json({ error: "Failed to upload attachments" });
  }
};

// Mark thread as read
exports.markThreadAsRead = async function (req, res) {
  try {
    const { threadId } = req.params;
    const currentUser = req.employee._id;

    if (!threadId) {
      return res.status(400).json({ error: "Thread ID is required" });
    }

    // Mark all unread messages in thread as read
    const result = await ThreadChatMessage.updateMany(
      {
        threadId,
        'readBy.employee': { $nin: buildIdVariants(currentUser) },
        ...buildParticipantMatch(currentUser),
        isDeleted: false
      },
      {
        $push: {
          readBy: {
            employee: currentUser,
            readAt: new Date()
          }
        }
      }
    );

    // Emit read status update
    const io = getIO(req);
    if (io) {
      io.to(`thread_${threadId}`).emit("thread_marked_as_read", {
        threadId,
        userId: String(currentUser),
        timestamp: new Date()
      });
      // Also tell this user's other tabs/rails: they aren't necessarily joined
      // to the thread room, but their unread badge still has to drop.
      io.to(`employee_${currentUser}`).emit("thread_chat_read", {
        threadId,
        userId: String(currentUser),
        timestamp: new Date()
      });
    }

    res.json({
      success: true,
      message: `Marked ${result.modifiedCount} messages as read`
    });

  } catch (e) {
    console.error("❌ Error in markThreadAsRead:", e);
    res.status(500).json({ error: "Failed to mark thread as read" });
  }
};

// Mark a SINGLE message as read.
//
// ThreadSideChat has always called this (POST /messages/:id/read) whenever a
// message is read while the panel is already open — a reply arriving while you
// sit in the thread, or the open-panel sweep over unseen messages. The route
// never existed, so every one of those calls 404'd. Worse, the rejection
// happened *before* the optimistic `isRead: true` local update, so the read
// registered nowhere at all and the badge only ever cleared by re-opening the
// thread (which goes through markThreadAsRead instead).
exports.markMessageAsRead = async function (req, res) {
  try {
    const { id } = req.params;
    const currentUser = req.employee._id;

    if (!isObjId(id)) {
      return res.status(400).json({ error: "Invalid message ID" });
    }

    const message = await ThreadChatMessage.findById(id);
    if (!message) {
      return res.status(404).json({ error: "Message not found" });
    }

    // Only a participant of the message may mark it read.
    const isParticipant =
      String(message.sender) === String(currentUser) ||
      (message.receiver || []).some((r) => String(r) === String(currentUser));
    if (!isParticipant) {
      return res
        .status(403)
        .json({ error: "You are not a participant of this message" });
    }

    // No-op when already read, so repeat calls can't duplicate readBy entries.
    await message.markAsRead(currentUser);

    // Plain strings, NOT raw ObjectIds: socket.io serializes an ObjectId as a
    // binary blob, and the client compares `r.employee === currentUserId`. Emit
    // the Mongoose subdocs as-is and the receiver's own read stops matching, so
    // the message pops back to unread.
    const readBy = (message.readBy || []).map((r) => ({
      employee: String(r.employee),
      readAt: r.readAt,
    }));

    const io = getIO(req);
    if (io) {
      // Shape matches ThreadSideChat's handleMessageReadEvent.
      io.to(`thread_${message.threadId}`).emit("message_read", {
        threadId: message.threadId,
        messageId: String(message._id),
        readBy,
      });
      // And drop this user's rail badge on their other tabs.
      io.to(`employee_${currentUser}`).emit("thread_chat_read", {
        threadId: message.threadId,
        userId: String(currentUser),
        timestamp: new Date(),
      });
    }

    res.json({
      success: true,
      message: "Message marked as read",
      data: { messageId: String(message._id), readBy },
    });
  } catch (e) {
    console.error("❌ Error in markMessageAsRead:", e);
    res.status(500).json({ error: "Failed to mark message as read" });
  }
};

// Search in thread
exports.searchInThread = async function (req, res) {
  try {
    const { threadId } = req.params;
    const { q: searchTerm, limit = 20, page = 1 } = req.query;

    if (!threadId) {
      return res.status(400).json({ error: "Thread ID is required" });
    }

    if (!searchTerm || searchTerm.trim() === "") {
      return res.status(400).json({ error: "Search term is required" });
    }

    // Build search query
    const searchQuery = {
      threadId,
      isDeleted: false,
      $or: [
        { content: { $regex: searchTerm, $options: "i" } },
        { "attachments.originalName": { $regex: searchTerm, $options: "i" } }
      ]
    };

    // Apply visibility
    const qFinal = await applyVisibility(searchQuery, req);

    // Pagination
    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const lim = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);

    // Search
    const [results, total] = await Promise.all([
      ThreadChatMessage.find(qFinal)
        .sort({ createdAt: -1 })
        .skip((pageNum - 1) * lim)
        .limit(lim)
        .populate([
          { path: "sender", select: "_id name companyEmail role photographUrl" },
          { path: "attachments.uploadedBy", select: "_id name companyEmail" }
        ])
        .lean(),
      ThreadChatMessage.countDocuments(qFinal)
    ]);

    res.json({
      success: true,
      data: results,
      pagination: {
        total,
        page: pageNum,
        pages: Math.ceil(total / lim),
        limit: lim,
        searchTerm
      }
    });

  } catch (e) {
    console.error("❌ Error in searchInThread:", e);
    res.status(500).json({ error: "Failed to search in thread" });
  }
};

// Get thread statistics
exports.getThreadStats = async function (req, res) {
  try {
    const { threadId } = req.params;
    const currentUser = req.employee._id;

    if (!threadId) {
      return res.status(400).json({ error: "Thread ID is required" });
    }

    const stats = await ThreadChatMessage.aggregate([
      {
        $match: {
          threadId,
          isDeleted: false
        }
      },
      {
        $facet: {
          totalMessages: [{ $count: "count" }],
          messagesByDay: [
            {
              $group: {
                _id: {
                  $dateToString: { format: "%Y-%m-%d", date: "$createdAt" }
                },
                count: { $sum: 1 }
              }
            },
            { $sort: { _id: 1 } }
          ],
          messagesByUser: [
            {
              $group: {
                _id: "$sender",
                count: { $sum: 1 }
              }
            },
            { $sort: { count: -1 } }
          ],
          unreadCount: [
            {
              $match: {
                'readBy.employee': { $ne: oid(currentUser) },
                $or: [
                  { sender: oid(currentUser) },
                  { receiver: oid(currentUser) },
                  { receiver: { $in: [oid(currentUser)] } }
                ]
              }
            },
            { $count: "count" }
          ],
          withAttachments: [
            {
              $match: {
                attachments: { $exists: true, $ne: [] }
              }
            },
            { $count: "count" }
          ]
        }
      }
    ]);

    res.json({
      success: true,
      data: {
        totalMessages: stats[0]?.totalMessages[0]?.count || 0,
        messagesByDay: stats[0]?.messagesByDay || [],
        messagesByUser: stats[0]?.messagesByUser || [],
        unreadCount: stats[0]?.unreadCount[0]?.count || 0,
        withAttachments: stats[0]?.withAttachments[0]?.count || 0
      }
    });

  } catch (e) {
    console.error("❌ Error in getThreadStats:", e);
    res.status(500).json({ error: "Failed to get thread statistics" });
  }
};

// NEW: Get unread count for a thread
exports.getUnreadCount = async function (req, res) {
  try {
    const { threadId } = req.params;
    const currentUser = req.employee._id;

    if (!threadId) {
      return res.status(400).json({ error: "Thread ID is required" });
    }

    const unreadCount = await ThreadChatMessage.countDocuments({
      threadId,
      isDeleted: false,
      'readBy.employee': { $nin: buildIdVariants(currentUser) },
      ...buildParticipantMatch(currentUser)
    });

    res.json({
      success: true,
      unreadCount
    });

  } catch (e) {
    console.error("❌ Error in getUnreadCount:", e);
    res.status(500).json({ error: "Failed to fetch unread count" });
  }
};

// Bulk unread counts for many threads at once — used by the email list to show
// a red dot on the thread-chat icon without one request per row. One indexed
// aggregation (threadId is indexed) keyed by thread.
exports.getUnreadCountsBulk = async function (req, res) {
  try {
    const currentUser = req.employee._id;
    const { threadIds } = req.body || {};
    if (!Array.isArray(threadIds) || threadIds.length === 0) {
      return res.json({ success: true, counts: {} });
    }

    const variants = buildIdVariants(currentUser);
    const rows = await ThreadChatMessage.aggregate([
      {
        $match: {
          threadId: { $in: threadIds.map(String) },
          isDeleted: false,
          // Only messages from someone else, that the current user hasn't read,
          // and that were actually addressed TO this user — otherwise a comment
          // between two other people on a thread would wrongly badge everyone.
          sender: { $nin: variants },
          "readBy.employee": { $nin: variants },
          receiver: { $in: variants },
        },
      },
      { $group: { _id: "$threadId", count: { $sum: 1 } } },
    ]);

    const counts = {};
    rows.forEach((r) => {
      counts[String(r._id)] = r.count;
    });

    res.json({ success: true, counts });
  } catch (e) {
    console.error("❌ Error in getUnreadCountsBulk:", e);
    res.status(500).json({ error: "Failed to fetch unread counts" });
  }
};

// Global thread-chat unread count for the SendQuery rail badge.
//
// Deliberately mirrors normal chat's /chat/conversations/unread/count: the
// number is THREADS that have at least one unread message, not the raw message
// total — 20 unread messages in one thread contribute 1, exactly like a chat
// conversation with 20 unread messages does.
exports.getAllThreadsUnreadCount = async function (req, res) {
  try {
    const currentUser = oid(String(req.employee._id));
    if (!currentUser) {
      return res.json({ success: true, data: { unreadCount: 0 } });
    }

    // Same three rules as getUnreadCountsBulk: the message is from someone
    // else, this user hasn't read it, and it was actually addressed to them —
    // otherwise a comment between two other people would badge everyone.
    const variants = buildIdVariants(currentUser);
    const match = {
      isDeleted: false,
      sender: { $nin: variants },
      "readBy.employee": { $nin: variants },
      receiver: { $in: variants },
    };

    // Org scope, so the badge can never leak across owners.
    const ownerId = req.employee?.owner ? oid(String(req.employee.owner)) : null;
    if (ownerId) match.owner = ownerId;

    const rows = await ThreadChatMessage.aggregate([
      { $match: match },
      { $group: { _id: "$threadId" } },
      { $count: "unreadThreads" },
    ]);

    res.json({
      success: true,
      data: { unreadCount: rows[0]?.unreadThreads || 0 },
    });
  } catch (e) {
    console.error("❌ Error in getAllThreadsUnreadCount:", e);
    res.status(500).json({ error: "Failed to fetch thread chat unread count" });
  }
};