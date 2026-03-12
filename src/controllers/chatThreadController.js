const ChatThread = require("../models/ChatThread");
const { Message } = require("../models/Chat");
const Employee = require("../models/Employees");
const mongoose = require("mongoose");

// Utility
const isObjId = (v) => mongoose.isValidObjectId(v);

// Get IO instance
function getIO(req) {
  return req.app.get("io");
}

/**
 * Create a new thread reply
 */
exports.createThreadReply = async (req, res) => {
  try {
    const { parentMessageId, content, messageType = "text" } = req.body;
    const sender = req.employee?._id;
    const owner = req.employee?.owner;

    if (!parentMessageId || !content) {
      return res.status(400).json({ error: "Parent message ID and content are required" });
    }

    if (!isObjId(parentMessageId)) {
      return res.status(400).json({ error: "Invalid parent message ID" });
    }

    // Verify parent message exists
    const parentMsg = await Message.findById(parentMessageId);
    if (!parentMsg) {
      return res.status(404).json({ error: "Parent message not found" });
    }

    const reply = await ChatThread.create({
      parentMessageId,
      owner,
      sender,
      content,
      messageType,
    });

    // Mark as read by sender
    await reply.markAsRead(sender);

    const populatedReply = await ChatThread.findById(reply._id)
      .populate("sender", "name photographUrl avatar companyEmail role")
      .populate("reactions.employee", "name photographUrl avatar");

    // Emit via socket
    const io = getIO(req);
    if (io) {
      // Emit to the thread room
      io.to(`thread_${parentMessageId}`).emit("new_chat_thread_reply", populatedReply);
      
      // Also notify participants of the parent conversation
      // This is optional depending on how we want the UI to update the reply count
      io.to(`conversation_${parentMsg.conversation}`).emit("chat_thread_updated", {
        parentMessageId,
        lastReply: populatedReply,
      });
    }

    res.status(201).json({
      success: true,
      data: populatedReply,
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

    res.json({
      success: true,
      data: replies,
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

    // Emit event
    const io = getIO(req);
    if (io) {
      io.to(`thread_${reply.parentMessageId}`).emit("chat_thread_reply_updated", updatedReply);
    }

    res.json({
      success: true,
      data: updatedReply.reactions,
    });
  } catch (error) {
    console.error("Error adding reaction:", error);
    res.status(500).json({ error: "Failed to add reaction" });
  }
};
