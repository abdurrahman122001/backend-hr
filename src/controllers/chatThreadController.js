const ChatThread = require("../models/ChatThread");
const { Message, Conversation, Space } = require("../models/Chat");
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

    // A new participation or mention resumes following for those employees.
    const resumedFollowerIds = [
      sender,
      ...finalMentions.map((mention) => mention.employee),
    ].filter(Boolean);
    if (resumedFollowerIds.length > 0) {
      await Message.updateOne(
        { _id: parentMessageId },
        { $pull: { threadUnfollowers: { $in: resumedFollowerIds } } }
      );
    }

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
    const { conversationId, spaceId, home } = req.query;
    const employeeObjectId = new mongoose.Types.ObjectId(employeeId);

    // 1. Find all threads where the user is a participant or has access via owner
    // For simplicity, we'll find all unique parentMessageIds in ChatThread for this owner
    
    let matchQuery = { 
      owner: new mongoose.Types.ObjectId(owner), 
      isDeleted: false 
    };

    const activeThreadsAggregation = [
      { $match: matchQuery },
      { $sort: { createdAt: -1 } },
      {
        $group: {
          _id: "$parentMessageId",
          replyCount: { $sum: 1 },
          lastReplyAt: { $first: "$createdAt" },
          latestReplyId: { $first: "$_id" },
          participantIds: { $addToSet: "$sender" },
          replyMentionIds: { $push: "$mentions.employee" },
          unreadCount: {
            $sum: {
              $cond: [
                {
                  $in: [
                    employeeObjectId,
                    { $ifNull: ["$readBy.employee", []] },
                  ],
                },
                0,
                1,
              ],
            },
          },
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

    activeThreadsAggregation.push({ $sort: { lastReplyAt: -1 } });

    const activeThreads = await ChatThread.aggregate(activeThreadsAggregation);

    if (activeThreads.length === 0) {
      return res.json({ success: true, data: [] });
    }

    const allNotificationSpaces = await Space.find({
      members: employeeObjectId,
      notificationSettings: {
        $elemMatch: { employee: employeeObjectId, level: "all" },
      },
    }).select("_id").lean();
    const allNotificationSpaceIds = new Set(
      allNotificationSpaces.map((space) => String(space._id))
    );

    // 2. Populate parent and latest reply details, then apply Home eligibility.
    const populatedThreads = await Promise.all(
      activeThreads.map(async (thread) => {
        const [parentMessage, latestReply] = await Promise.all([
          Message.findById(thread._id)
            .populate("sender", "name photographUrl avatar")
            .populate("reactions.users", "name photographUrl avatar")
            .lean(),
          ChatThread.findById(thread.latestReplyId)
            .populate("sender", "name photographUrl avatar companyEmail role")
            .lean(),
        ]);
        
        if (!parentMessage || !latestReply) return null;

        const isExplicitlyUnfollowed = (parentMessage.threadUnfollowers || [])
          .some((id) => String(id) === String(employeeId));
        const isManuallyFollowed = (parentMessage.threadFollowers || [])
          .some((entry) => String(entry.employee) === String(employeeId));
        const startedByUser = String(parentMessage.sender?._id || parentMessage.sender) === String(employeeId);
        const participated = (thread.participantIds || [])
          .some((id) => String(id) === String(employeeId));
        const mentionedInParent = (parentMessage.mentions || [])
          .some((mention) => String(mention.employee) === String(employeeId));
        const mentionedInReplies = (thread.replyMentionIds || [])
          .flat()
          .some((id) => String(id) === String(employeeId));
        const followsAllSpaceThreads = parentMessage.space
          ? allNotificationSpaceIds.has(String(parentMessage.space))
          : false;
        const isFollowing = !isExplicitlyUnfollowed && (
          isManuallyFollowed ||
          startedByUser ||
          participated ||
          mentionedInParent ||
          mentionedInReplies ||
          followsAllSpaceThreads
        );

        if (home === "true" && !isFollowing) return null;

        return {
          parentMessage,
          latestReply,
          replyCount: thread.replyCount,
          lastReplyAt: thread.lastReplyAt,
          unreadCount: thread.unreadCount,
          isFollowing,
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

const canAccessThread = async (parentMessage, employeeId) => {
  if (parentMessage.space) {
    return Boolean(await Space.exists({
      _id: parentMessage.space,
      members: employeeId,
    }));
  }
  return Boolean(await Conversation.exists({
    _id: parentMessage.conversation,
    participants: employeeId,
  }));
};

exports.getThreadFollowStatus = async (req, res) => {
  try {
    const { parentMessageId } = req.params;
    const employeeId = req.employee?._id;
    if (!isObjId(parentMessageId)) {
      return res.status(400).json({ error: "Invalid parent message ID" });
    }

    const parentMessage = await Message.findById(parentMessageId)
      .select("conversation space sender mentions threadFollowers threadUnfollowers")
      .lean();
    if (!parentMessage || !(await canAccessThread(parentMessage, employeeId))) {
      return res.status(404).json({ error: "Thread not found" });
    }

    const explicitlyUnfollowed = (parentMessage.threadUnfollowers || [])
      .some((id) => String(id) === String(employeeId));
    const manuallyFollowed = (parentMessage.threadFollowers || [])
      .some((entry) => String(entry.employee) === String(employeeId));
    const started = String(parentMessage.sender) === String(employeeId);
    const participated = Boolean(await ChatThread.exists({
      parentMessageId,
      sender: employeeId,
      isDeleted: false,
    }));
    const mentionedInParent = (parentMessage.mentions || [])
      .some((mention) => String(mention.employee) === String(employeeId));
    const mentionedInReply = Boolean(await ChatThread.exists({
      parentMessageId,
      "mentions.employee": employeeId,
      isDeleted: false,
    }));
    let followsAllSpaceThreads = false;
    if (parentMessage.space) {
      followsAllSpaceThreads = Boolean(await Space.exists({
        _id: parentMessage.space,
        notificationSettings: {
          $elemMatch: { employee: employeeId, level: "all" },
        },
      }));
    }

    const isFollowing = !explicitlyUnfollowed && (
      manuallyFollowed || started || participated || mentionedInParent ||
      mentionedInReply || followsAllSpaceThreads
    );
    res.json({ success: true, isFollowing });
  } catch (error) {
    console.error("Error fetching thread follow status:", error);
    res.status(500).json({ error: "Failed to fetch thread follow status" });
  }
};

exports.setThreadFollowStatus = async (req, res) => {
  try {
    const { parentMessageId } = req.params;
    const employeeId = req.employee?._id;
    const follow = req.body?.follow === true;
    if (!isObjId(parentMessageId)) {
      return res.status(400).json({ error: "Invalid parent message ID" });
    }

    const parentMessage = await Message.findById(parentMessageId)
      .select("conversation space")
      .lean();
    if (!parentMessage || !(await canAccessThread(parentMessage, employeeId))) {
      return res.status(404).json({ error: "Thread not found" });
    }

    if (follow) {
      await Message.updateOne(
        { _id: parentMessageId },
        {
          $pull: {
            threadUnfollowers: employeeId,
            threadFollowers: { employee: employeeId },
          },
        }
      );
      await Message.updateOne(
        { _id: parentMessageId },
        { $push: { threadFollowers: { employee: employeeId, followedAt: new Date() } } }
      );
    } else {
      await Message.updateOne(
        { _id: parentMessageId },
        {
          $pull: { threadFollowers: { employee: employeeId } },
          $addToSet: { threadUnfollowers: employeeId },
        }
      );
    }

    res.json({ success: true, isFollowing: follow });
  } catch (error) {
    console.error("Error updating thread follow status:", error);
    res.status(500).json({ error: "Failed to update thread follow status" });
  }
};

/**
 * Mark every reply in one thread as read for the current employee.
 */
exports.markThreadAsRead = async (req, res) => {
  try {
    const { parentMessageId } = req.params;
    const employeeId = req.employee?._id;
    const owner = req.employee?.owner;

    if (!isObjId(parentMessageId)) {
      return res.status(400).json({ error: "Invalid parent message ID" });
    }

    await ChatThread.updateMany(
      {
        parentMessageId: new mongoose.Types.ObjectId(parentMessageId),
        owner: new mongoose.Types.ObjectId(owner),
        isDeleted: false,
        "readBy.employee": { $ne: employeeId },
      },
      {
        $push: {
          readBy: {
            employee: employeeId,
            readAt: new Date(),
          },
        },
      }
    );

    res.json({ success: true });
  } catch (error) {
    console.error("Error marking thread as read:", error);
    res.status(500).json({ error: "Failed to mark thread as read" });
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
