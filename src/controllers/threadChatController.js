const ThreadChatMessage = require("../models/ThreadChatMessage");
const AssignmentMessage = require("../models/AssignmentMessage");
const Employee = require("../models/Employees");
const mongoose = require("mongoose");
const path = require("path");

// Utility functions
const isObjId = (v) => mongoose.isValidObjectId(v);
const oid = (v) => mongoose.isValidObjectId(v) ? new mongoose.Types.ObjectId(v) : null;

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
  const participantFilter = {
    $or: [
      { sender: me },
      { receiver: me },
      { receiver: { $in: [me] } }
    ]
  };

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
      .populate("client");

    if (!populatedMessage) return;

    // Get all participants in this thread
    const participants = await ThreadChatMessage.getThreadParticipants(populatedMessage.threadId);
    
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
      if (Array.isArray(receiver)) {
        receivers = receiver.filter(id => isObjId(id)).map(String);
      } else if (isObjId(receiver)) {
        receivers = [String(receiver)];
      }
    }

    // If no receivers specified, get from thread
    if (receivers.length === 0) {
      // Get participants from thread
      const threadMessages = await AssignmentMessage.find({ threadId })
        .select('sender receiver')
        .limit(10);

      const threadParticipants = new Set();
      
      threadMessages.forEach(msg => {
        if (msg.sender && String(msg.sender) !== String(sender)) {
          threadParticipants.add(String(msg.sender));
        }
        
        if (msg.receiver && Array.isArray(msg.receiver)) {
          msg.receiver.forEach(rec => {
            if (String(rec) !== String(sender)) {
              threadParticipants.add(String(rec));
            }
          });
        }
      });

      receivers = Array.from(threadParticipants);
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
      content: content.trim(),
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
      { path: "sender", select: "_id name companyEmail role avatar" },
      { path: "receiver", select: "_id name companyEmail role" },
      { path: "client", select: "_id clientName" },
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

// Get messages for a thread
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
          { path: "sender", select: "_id name companyEmail role avatar" },
          { path: "receiver", select: "_id name companyEmail role" },
          { path: "client", select: "_id clientName" },
          { path: "replyTo", select: "_id content sender createdAt" },
          { path: "replyTo.sender", select: "_id name companyEmail" },
          { path: "attachments.uploadedBy", select: "_id name companyEmail" },
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
    }

    // Format response
    const formattedMessages = messages.map(msg => ({
      ...msg,
      isMe: msg.sender._id.toString() === currentUser.toString(),
      isRead: msg.readBy.some(read => read.employee.toString() === currentUser.toString()),
      readCount: msg.readBy.length,
      reactionCount: msg.reactions.length
    })).reverse(); // Reverse to show oldest first for display

    res.json({
      success: true,
      data: formattedMessages,
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
        participants: await ThreadChatMessage.getThreadParticipants(threadId)
      }
    });

  } catch (e) {
    console.error("❌ Error in getThreadMessages:", e);
    res.status(500).json({ error: "Failed to fetch thread messages" });
  }
};

// Get thread info
exports.getThreadInfo = async function (req, res) {
  try {
    const { threadId } = req.params;

    if (!threadId) {
      return res.status(400).json({ error: "Thread ID is required" });
    }

    // Get thread from AssignmentMessage
    const thread = await AssignmentMessage.findOne({ threadId })
      .populate([
        { path: "owner", select: "_id name companyEmail" },
        { path: "sender", select: "_id name companyEmail role" },
        { path: "receiver", select: "_id name companyEmail role" },
        { path: "client", select: "_id clientName" },
      ]);

    if (!thread) {
      return res.status(404).json({ error: "Thread not found" });
    }

    // Get participants from chat messages
    const participants = await ThreadChatMessage.getThreadParticipants(threadId);

    // Get latest message
    const latestMessage = await ThreadChatMessage.findOne({ threadId, isDeleted: false })
      .sort({ createdAt: -1 })
      .populate("sender", "_id name companyEmail")
      .lean();

    // Get unread count for current user
    const currentUser = req.employee._id;
    const unreadCount = await ThreadChatMessage.countDocuments({
      threadId,
      isDeleted: false,
      'readBy.employee': { $ne: currentUser },
      $or: [
        { sender: currentUser },
        { receiver: currentUser },
        { receiver: { $in: [currentUser] } }
      ]
    });

    // Get total message count
    const totalMessages = await ThreadChatMessage.countDocuments({
      threadId,
      isDeleted: false
    });

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
          approvalStatus: thread.approvalStatus
        },
        participants,
        latestMessage,
        stats: {
          totalMessages,
          unreadCount,
          participantCount: participants.length
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
    await message.edit(content.trim(), currentUser);

    // Populate updated message
    const populated = await ThreadChatMessage.findById(message._id)
      .populate([
        { path: "sender", select: "_id name companyEmail role avatar" },
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
        { path: "sender", select: "_id name companyEmail role avatar" },
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

// Get thread participants
exports.getThreadParticipants = async function (req, res) {
  try {
    const { threadId } = req.params;

    if (!threadId) {
      return res.status(400).json({ error: "Thread ID is required" });
    }

    const participants = await ThreadChatMessage.getThreadParticipants(threadId);

    // Get employee details
    const employeeDetails = await Employee.find(
      { _id: { $in: participants } },
      "_id name companyEmail role avatar"
    );

    res.json({
      success: true,
      data: employeeDetails,
      count: employeeDetails.length
    });

  } catch (e) {
    console.error("❌ Error in getThreadParticipants:", e);
    res.status(500).json({ error: "Failed to fetch participants" });
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
        'readBy.employee': { $ne: currentUser },
        $or: [
          { sender: currentUser },
          { receiver: currentUser },
          { receiver: { $in: [currentUser] } }
        ],
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
        userId: currentUser,
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
          { path: "sender", select: "_id name companyEmail role avatar" },
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