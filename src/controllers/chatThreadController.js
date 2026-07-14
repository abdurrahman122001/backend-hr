const ChatThread = require("../models/ChatThread");
const { Message, Conversation } = require("../models/Chat");
const Employee = require("../models/Employees");
const mongoose = require("mongoose");
const chatController = require("./chatController");

// Utility
const isObjId = (v) => mongoose.isValidObjectId(v);

// Get IO instance
function getIO(req) {
  return req.app.get("io");
}

/**
 * Utility to group flat reactions into the structure expected by the frontend
 */
function groupReactions(flatReactions) {
  if (!flatReactions || !Array.isArray(flatReactions)) return [];
  
  const groups = {};
  flatReactions.forEach(r => {
    if (!groups[r.emoji]) {
      groups[r.emoji] = {
        emoji: r.emoji,
        users: [],
        count: 0
      };
    }
    // Handle both populated and unpopulated employee field
    const user = r.employee && typeof r.employee === 'object' ? r.employee : { _id: r.employee };
    groups[r.emoji].users.push(user);
    groups[r.emoji].count++;
  });
  
  return Object.values(groups);
}

/**
 * Create a new thread reply
 */
exports.createThreadReply = async (req, res) => {
  try {
    const { parentMessageId, content, messageType = "text", mentions: mentionsRaw, gifUrl } = req.body;
    const sender = req.employee?._id;
    const owner = req.employee?.owner;
    
    // Process uploaded files
    const uploadedAttachments = [];
    if (req.files && req.files.length > 0) {
      uploadedAttachments.push(
        ...req.files.map((file) => ({
          filename: file.filename,
          originalName: file.originalname,
          mimetype: file.mimetype,
          size: file.size,
          url: `${req.protocol}://${req.get("host")}/uploads/chat-attachments/${file.filename}`,
          uploadedBy: sender
        }))
      );
    }

    if (!parentMessageId) {
      return res.status(400).json({ error: "Parent message ID is required" });
    }

    if (!content && uploadedAttachments.length === 0 && messageType !== "audio") {
      return res.status(400).json({ error: "Content or attachments are required" });
    }

    if (!isObjId(parentMessageId)) {
      return res.status(400).json({ error: "Invalid parent message ID" });
    }

    // Verify parent message exists
    const parentMsg = await Message.findById(parentMessageId);
    if (!parentMsg) {
      return res.status(404).json({ error: "Parent message not found" });
    }

    // Process Mentions
    let finalMentions = [];
    if (mentionsRaw) {
      try {
        const parsedMentions = typeof mentionsRaw === 'string' ? JSON.parse(mentionsRaw) : mentionsRaw;
        finalMentions = parsedMentions.map(m => ({
          employee: m.employee || m._id || m.userId,
          mentionText: m.mentionText || m.name,
          mentionedAt: new Date()
        })).filter(m => isObjId(m.employee));
      } catch (e) {
        console.error("Error parsing mentions:", e);
      }
    } else {
      finalMentions = await chatController.processMentions(content, sender);
    }

    // Determine final message type
    let finalMessageType = messageType;
    if (uploadedAttachments.length > 0 && (finalMessageType === "text" || finalMessageType === "file")) {
       const hasImage = uploadedAttachments.some(a => a.mimetype?.startsWith("image/"));
       finalMessageType = hasImage ? "image" : "file";
    }

    const reply = await ChatThread.create({
      parentMessageId,
      owner,
      sender,
      content: content || (finalMessageType === "audio" ? "🎤 Audio message" : "Attachment"),
      messageType: finalMessageType,
      attachments: uploadedAttachments,
      mentions: finalMentions,
      gifUrl
    });

    // Mark as read by sender
    await reply.markAsRead(sender);

    const populatedReply = await ChatThread.findById(reply._id)
      .populate("sender", "name photographUrl avatar companyEmail role")
      .populate("reactions.employee", "name photographUrl avatar")
      .populate("attachments.uploadedBy", "name")
      .lean();

    // Emit via socket
    const io = getIO(req);
    if (io) {
      // Emit to the thread room
      io.to(`thread_${parentMessageId}`).emit("new_chat_thread_reply", populatedReply);
      
      // Also notify participants of the parent conversation/space. Socket.IO
      // treats chained rooms as a union, so sockets in both rooms receive the
      // update only once.
      const conversationId = String(parentMsg.conversation);
      const spaceId = parentMsg.space ? String(parentMsg.space) : null;
      let threadUpdateTarget = io.to(`conversation_${conversationId}`);
      if (spaceId) {
        threadUpdateTarget = threadUpdateTarget.to(`space_${spaceId}`);
      }
      threadUpdateTarget.emit("chat_thread_updated", {
        parentMessageId,
        conversationId,
        spaceId,
        lastReply: populatedReply,
      });

      // Send mention notifications
      if (finalMentions.length > 0) {
        const conversation = await Conversation.findById(parentMsg.conversation);
        if (conversation) {
           chatController.sendMentionNotifications(finalMentions, populatedReply, conversation, req);
        }
      }
    }

    res.status(201).json({
      success: true,
      data: {
        ...populatedReply,
        reactions: groupReactions(populatedReply.reactions)
      },
    });
  } catch (error) {
    console.error("Error creating thread reply:", error);
    res.status(500).json({ error: "Failed to create thread reply" });
  }
};

/**
 * Get all replies for a thread
 */
exports.getThreadReplies = async (req, res) => {
  try {
    const { parentMessageId } = req.params;

    if (!isObjId(parentMessageId)) {
      return res.status(400).json({ error: "Invalid parent message ID" });
    }

    const replies = await ChatThread.find({ parentMessageId, isDeleted: false })
      .sort({ createdAt: 1 })
      .populate("sender", "name photographUrl avatar companyEmail role")
      .populate("reactions.employee", "name photographUrl avatar")
      .populate("attachments.uploadedBy", "name")
      .lean();

    const formattedReplies = replies.map(r => ({
      ...r,
      reactions: groupReactions(r.reactions)
    }));

    res.json({
      success: true,
      data: formattedReplies,
    });
  } catch (error) {
    console.error("Error fetching thread replies:", error);
    res.status(500).json({ error: "Failed to fetch thread replies" });
  }
};

/**
 * Get recently active threads for the current user
 * Returns parent messages that have replies
 */
exports.getRecentActiveThreads = async (req, res) => {
  try {
    const employeeId = req.employee?._id;
    const owner = req.employee?.owner;
    const { conversationId, spaceId } = req.query;

    // 1. Find all threads where the user is a participant or has access via owner
    // For simplicity, we'll find all unique parentMessageIds in ChatThread for this owner
    
    let matchQuery = { 
      owner: new mongoose.Types.ObjectId(owner), 
      isDeleted: false 
    };

    const activeThreadsAggregation = [
      { $match: matchQuery },
      {
        $group: {
          _id: "$parentMessageId",
          replyCount: { $sum: 1 },
          lastReplyAt: { $max: "$createdAt" },
        },
      },
      {
        $lookup: {
          from: "messages",
          localField: "_id",
          foreignField: "_id",
          as: "parentMessage"
        }
      },
      { $unwind: "$parentMessage" }
    ];

    // Filter by conversation or space if provided
    if (conversationId && isObjId(conversationId)) {
      activeThreadsAggregation.push({
        $match: { "parentMessage.conversation": new mongoose.Types.ObjectId(conversationId) }
      });
    } else if (spaceId && isObjId(spaceId)) {
      activeThreadsAggregation.push({
        $match: { "parentMessage.space": new mongoose.Types.ObjectId(spaceId) }
      });
    }

    activeThreadsAggregation.push(
      { $sort: { lastReplyAt: -1 } },
      { $limit: 20 }
    );

    const activeThreads = await ChatThread.aggregate(activeThreadsAggregation);

    if (activeThreads.length === 0) {
      return res.json({ success: true, data: [] });
    }

    // 2. Populate parent message sender details (since aggregate lookup doesn't populate nested fields easily)
    const populatedThreads = await Promise.all(
      activeThreads.map(async (thread) => {
        const parentMessage = await Message.findById(thread._id)
          .populate("sender", "name photographUrl avatar")
          .populate("reactions.users", "name photographUrl avatar")
          .lean();
        
        if (!parentMessage) return null;

        return {
          parentMessage,
          replyCount: thread.replyCount,
          lastReplyAt: thread.lastReplyAt,
        };
      })
    );

    res.json({
      success: true,
      data: populatedThreads.filter(Boolean),
    });
  } catch (error) {
    console.error("Error fetching recent active threads:", error);
    res.status(500).json({ error: "Failed to fetch active threads" });
  }
};

/**
 * Edit a thread reply
 */
exports.editThreadReply = async (req, res) => {
  try {
    const { id } = req.params;
    const { content } = req.body;
    const senderId = req.employee?._id;

    if (!content) {
      return res.status(400).json({ error: "Content is required" });
    }

    const reply = await ChatThread.findById(id);
    if (!reply) {
      return res.status(404).json({ error: "Reply not found" });
    }

    if (reply.sender.toString() !== senderId.toString()) {
      return res.status(403).json({ error: "Unauthorized to edit this reply" });
    }

    await reply.edit(content, senderId);

    const updatedReply = await ChatThread.findById(id)
      .populate("sender", "name photographUrl avatar companyEmail role")
      .populate("reactions.employee", "name photographUrl avatar");

    // Emit update event
    const io = getIO(req);
    if (io) {
      io.to(`thread_${reply.parentMessageId}`).emit("chat_thread_reply_updated", updatedReply);
    }

    res.json({
      success: true,
      data: updatedReply,
    });
  } catch (error) {
    console.error("Error editing thread reply:", error);
    res.status(500).json({ error: "Failed to edit thread reply" });
  }
};

/**
 * Delete a thread reply (soft delete)
 */
exports.deleteThreadReply = async (req, res) => {
  try {
    const { id } = req.params;
    const employeeId = req.employee?._id;

    const reply = await ChatThread.findById(id);
    if (!reply) {
      return res.status(404).json({ error: "Reply not found" });
    }

    if (reply.sender.toString() !== employeeId.toString()) {
      return res.status(403).json({ error: "Unauthorized to delete this reply" });
    }

    reply.isDeleted = true;
    reply.deletedBy = employeeId;
    reply.deletedAt = new Date();
    await reply.save();

    // Emit delete event
    const io = getIO(req);
    if (io) {
      io.to(`thread_${reply.parentMessageId}`).emit("chat_thread_reply_deleted", {
        replyId: id,
        parentMessageId: reply.parentMessageId,
      });
    }

    res.json({
      success: true,
      message: "Reply deleted successfully",
    });
  } catch (error) {
    console.error("Error deleting thread reply:", error);
    res.status(500).json({ error: "Failed to delete thread reply" });
  }
};

/**
 * Add reaction to a reply
 */
exports.addReactionToReply = async (req, res) => {
  try {
    const { id } = req.params;
    const { emoji } = req.body;
    const employeeId = req.employee?._id;

    if (!emoji) {
      return res.status(400).json({ error: "Emoji is required" });
    }

    const reply = await ChatThread.findById(id);
    if (!reply) {
      return res.status(404).json({ error: "Reply not found" });
    }

    await reply.addReaction(employeeId, emoji);

    const updatedReply = await ChatThread.findById(id)
      .populate("reactions.employee", "name photographUrl avatar");

    const groupedReactions = groupReactions(updatedReply.reactions);

    // Emit event
    const io = getIO(req);
    if (io) {
      io.to(`thread_${reply.parentMessageId}`).emit("chat_thread_reply_updated", {
        ...updatedReply.toObject(),
        reactions: groupedReactions
      });
    }

    res.json({
      success: true,
      message: "Reaction updated successfully",
      reactions: groupedReactions,
    });
  } catch (error) {
    console.error("Error adding reaction:", error);
    res.status(500).json({ success: false, error: "Failed to add reaction" });
  }
};

/**
 * Get reactions for a thread reply
 */
exports.getThreadReplyReactions = async (req, res) => {
  try {
    const { id } = req.params;

    if (!isObjId(id)) {
      return res.status(400).json({ success: false, error: "Invalid reply ID" });
    }

    const reply = await ChatThread.findById(id)
      .populate("reactions.employee", "name companyEmail avatar photographUrl")
      .select("reactions");

    if (!reply) {
      return res.status(404).json({ success: false, error: "Reply not found" });
    }

    res.json({
      success: true,
      reactions: groupReactions(reply.reactions) || [],
    });
  } catch (error) {
    console.error("Error fetching reactions:", error);
    res.status(500).json({ success: false, error: "Failed to fetch reactions" });
  }
};
