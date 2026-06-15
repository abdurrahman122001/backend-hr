// controllers/whatsAppCommentsController.js
const WhatsAppMessage = require("../models/WhatsAppMessage");
const Employee = require("../models/Employees");
const ClientInfo = require("../models/ClientInfo");
const EmployeeHierarchy = require("../models/EmployeeHierarchy");

// Helper to get io instance safely
function getIo(req) {
  try {
    return req.app && req.app.get && req.app.get("io");
  } catch {
    return null;
  }
}

// @desc    Add comment to message
// @route   POST /api/whatsapp-messages/:messageId/comments
// @access  Private
exports.addComment = async (req, res) => {
  try {
    const { messageId } = req.params;
    const { text, replyTo, attachments, mentions } = req.body;
    const employee = req.employee;

    if (!text || text.trim() === "") {
      return res.status(400).json({
        success: false,
        error: "Comment text is required",
      });
    }

    const message = await WhatsAppMessage.findById(messageId);
    if (!message) {
      return res.status(404).json({
        success: false,
        error: "Message not found",
      });
    }

    const employeeFromDb = await Employee.findById(employee._id);
    if (!employeeFromDb) {
      return res.status(404).json({
        success: false,
        error: "Employee not found",
      });
    }

    // Add comment (mentions are stored on the comment)
    const comment = await message.addComment(
      { text: text.trim(), replyTo, attachments, mentions },
      employeeFromDb
    );

    // 🔹 Auto-add mentioned employees as receivers on this WhatsApp message
    if (Array.isArray(mentions) && mentions.length > 0) {
      const mentionedIds = mentions
        .map((m) => m.userId)
        .filter((id) => !!id);

      if (!Array.isArray(message.receiver)) {
        message.receiver = [];
      }

      mentionedIds.forEach((userId) => {
        const exists = message.receiver.some(
          (r) => String(r) === String(userId)
        );
        if (!exists) {
          message.receiver.push(userId);
        }
      });

      await message.save();
    }

    await message.populate("comments.sender", "name email avatar role");
    const newComment =
      message.comments[message.comments.length - 1];

    const io = getIo(req);
    if (io) {
      const payload = {
        comment: newComment,
        messageId,
        commentCount: message.commentCount,
        lastCommentAt: message.lastCommentAt,
        commenters: message.commenters,
      };

      // 1) Realtime update to everyone in the message room (side panel)
      io.to(`message:${messageId}`).emit("comment:added", payload);

      // 2) Broadcast to Client room (for list updates)
      if (message.client) {
        io.to(`client_${message.client}`).emit("comment:added", payload);
      }

      // 3) Broadcast to Group room (for group chat updates)
      if (message.groupId) {
        io.to(`conversation_${message.groupId}`).emit("comment:added", payload);
      }

      // 4) Notify all participants in their user rooms (sender + receivers + approval chain)
      const participants = new Set([
        String(message.sender),
        ...(Array.isArray(message.receiver)
          ? message.receiver.map((r) => String(r))
          : message.receiver ? [String(message.receiver)] : []),
        ...(Array.isArray(message.approvalChain)
          ? message.approvalChain.map((a) => String(a?.approver || a)).filter(Boolean)
          : []),
      ]);

      participants.forEach((userId) => {
        io.to(`employee_${userId}`).emit("comment:added", payload);
      });

      // 5) Mention notifications
      if (mentions && mentions.length > 0) {
        mentions.forEach((mention) => {
          io.to(`user:${mention.userId}`).emit("notification", {
            type: "comment_mention",
            message: `${employeeFromDb.name} mentioned you in a comment`,
            commentId: newComment._id,
            messageId,
            timestamp: new Date(),
          });
        });
      }
    }

    res.status(201).json({
      success: true,
      data: {
        comment: newComment,
        message: {
          commentCount: message.commentCount,
          lastCommentAt: message.lastCommentAt,
          lastCommentBy: message.lastCommentBy,
        },
      },
    });
  } catch (error) {
    console.error("Error adding comment:", error);
    res.status(500).json({
      success: false,
      error: "Server error",
      message: error.message,
    });
  }
};

// @desc    Get comments for a message
// @route   GET /api/whatsapp-messages/:messageId/comments
// @access  Private
exports.getComments = async (req, res) => {
  try {
    const { messageId } = req.params;
    const {
      page = 1,
      limit = 50,
      sortBy = "createdAt",
      sortOrder = "desc",
      includeReplies = true,
    } = req.query;

    const message = await WhatsAppMessage.findById(messageId)
      .populate({
        path: "comments.sender",
        select: "name email avatar role",
      })
      .populate({
        path: "comments.mentions.userId",
        select: "name email",
      });

    if (!message) {
      return res.status(404).json({
        success: false,
        error: "Message not found",
      });
    }

    let comments = message.comments || [];

    const sortDirection = sortOrder === "asc" ? 1 : -1;
    comments.sort((a, b) => {
      if (sortBy === "createdAt") {
        return (
          (new Date(b.createdAt) - new Date(a.createdAt)) *
          sortDirection
        );
      }
      return 0;
    });

    const organizedComments = includeReplies
      ? message.getOrganizedComments()
      : comments.filter((comment) => !comment.replyTo);

    const startIndex = (page - 1) * limit;
    const endIndex = page * limit;
    const paginatedComments = organizedComments.slice(
      startIndex,
      endIndex
    );

    res.json({
      success: true,
      data: {
        comments: paginatedComments,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: organizedComments.length,
          totalPages: Math.ceil(organizedComments.length / limit),
        },
        stats: {
          commentCount: message.commentCount || 0,
          lastCommentAt: message.lastCommentAt,
          uniqueCommenters: message.commenters
            ? message.commenters.length
            : 0,
        },
      },
    });
  } catch (error) {
    console.error("Error fetching comments:", error);
    res.status(500).json({
      success: false,
      error: "Server error",
    });
  }
};

// @desc    Get the users that can be mentioned in a comment for this message.
//          Hierarchy-based: only the client's assigned employee(s), their
//          seniors up the chain, and the CRM/managers — NOT every employee.
// @route   GET /api/whatsapp-messages/:messageId/mentionable
// @access  Private
exports.getMentionableUsers = async (req, res) => {
  try {
    const { messageId } = req.params;

    const message = await WhatsAppMessage.findById(messageId)
      .select("client owner")
      .lean();

    if (!message) {
      return res
        .status(404)
        .json({ success: false, error: "Message not found" });
    }

    const ownerId = message.owner;
    const ids = new Set(); // collected employee ids (as strings)

    // 1. Assigned employee(s) of the client — "him"
    let assignedIds = [];
    if (message.client) {
      const client = await ClientInfo.findById(message.client)
        .select("assignedTo")
        .lean();
      assignedIds = (client?.assignedTo || []).map((id) => String(id));
    }
    assignedIds.forEach((id) => ids.add(id));

    // 2. The seniors of each assigned employee — walk up the hierarchy chain
    for (const empId of assignedIds) {
      let current = empId;
      const visited = new Set();
      for (let i = 0; i < 10; i++) {
        if (visited.has(current)) break;
        visited.add(current);
        const link = await EmployeeHierarchy.findOne({
          owner: ownerId,
          junior: current,
        })
          .select("senior")
          .sort({ hierarchyLevel: -1 })
          .lean();
        if (!link || !link.senior) break;
        const seniorId = String(link.senior);
        ids.add(seniorId);
        current = seniorId;
      }
    }

    // 3. CRM / managers for this organization
    const managers = await Employee.find({
      owner: ownerId,
      $or: [{ role: /manager/i }, { role: /crm/i }],
    })
      .select("_id")
      .lean();
    managers.forEach((m) => ids.add(String(m._id)));

    // Exclude the requesting user — you can't mention yourself
    if (req.employee?._id) ids.delete(String(req.employee._id));

    const employees = await Employee.find({
      _id: { $in: Array.from(ids) },
    })
      .select("name companyEmail email role designation photographUrl avatar")
      .lean();

    res.json({ success: true, employees });
  } catch (error) {
    console.error("Error fetching mentionable users:", error);
    res.status(500).json({ success: false, error: "Server error" });
  }
};

// @desc    Edit a comment
// @route   PUT /api/whatsapp-messages/:messageId/comments/:commentId
// @access  Private
exports.editComment = async (req, res) => {
  try {
    const { messageId, commentId } = req.params;
    const { text, attachments, mentions } = req.body;
    const employee = req.employee;

    if (!text || text.trim() === "") {
      return res.status(400).json({
        success: false,
        error: "Comment text is required",
      });
    }

    const message = await WhatsAppMessage.findById(messageId);
    if (!message) {
      return res.status(404).json({
        success: false,
        error: "Message not found",
      });
    }

    const employeeFromDb = await Employee.findById(employee._id);
    if (!employeeFromDb) {
      return res.status(404).json({
        success: false,
        error: "Employee not found",
      });
    }

    const updatedComment = await message.editComment(
      commentId,
      {
        text: text.trim(),
        attachments,
        mentions,
      },
      employeeFromDb
    );

    await message.populate(
      "comments.sender",
      "name email avatar role"
    );

    const io = getIo(req);
    if (io) {
      const payload = {
        comment: updatedComment,
        messageId,
      };

      io.to(`message:${messageId}`).emit("comment:updated", payload);

      if (message.client) {
        io.to(`client_${message.client}`).emit("comment:updated", payload);
      }

      if (message.groupId) {
        io.to(`conversation_${message.groupId}`).emit(
          "comment:updated",
          payload
        );
      }
    }

    res.json({
      success: true,
      data: updatedComment,
    });
  } catch (error) {
    console.error("Error editing comment:", error);
    res.status(error.message.includes("Not authorized") ? 403 : 500).json({
      success: false,
      error: error.message,
    });
  }
};

// @desc    Delete a comment
// @route   DELETE /api/whatsapp-messages/:messageId/comments/:commentId
// @access  Private
exports.deleteComment = async (req, res) => {
  try {
    const { messageId, commentId } = req.params;
    const employee = req.employee;

    const message = await WhatsAppMessage.findById(messageId);
    if (!message) {
      return res.status(404).json({
        success: false,
        error: "Message not found",
      });
    }

    const employeeFromDb = await Employee.findById(employee._id);
    if (!employeeFromDb) {
      return res.status(404).json({
        success: false,
        error: "Employee not found",
      });
    }

    await message.deleteComment(commentId, employeeFromDb);

    const io = getIo(req);
    if (io) {
      const payload = {
        commentId,
        messageId,
        commentCount: message.commentCount,
        lastCommentAt: message.lastCommentAt,
        commenters: message.commenters,
      };

      io.to(`message:${messageId}`).emit("comment:deleted", payload);

      if (message.client) {
        io.to(`client_${message.client}`).emit("comment:deleted", payload);
      }

      if (message.groupId) {
        io.to(`conversation_${message.groupId}`).emit("comment:deleted", payload);
      }
    }

    res.json({
      success: true,
      data: {
        message: "Comment deleted successfully",
        commentCount: message.commentCount,
      },
    });
  } catch (error) {
    console.error("Error deleting comment:", error);
    res.status(error.message.includes("Not authorized") ? 403 : 500).json({
      success: false,
      error: error.message,
    });
  }
};

// @desc    Add reaction to comment
// @route   POST /api/whatsapp-messages/:messageId/comments/:commentId/reactions
// @access  Private
exports.addReaction = async (req, res) => {
  try {
    const { messageId, commentId } = req.params;
    const { emoji } = req.body;
    const employee = req.employee;

    if (!emoji) {
      return res.status(400).json({
        success: false,
        error: "Emoji is required",
      });
    }

    const message = await WhatsAppMessage.findById(messageId);
    if (!message) {
      return res.status(404).json({
        success: false,
        error: "Message not found",
      });
    }

    const employeeFromDb = await Employee.findById(employee._id);
    if (!employeeFromDb) {
      return res.status(404).json({
        success: false,
        error: "Employee not found",
      });
    }

    const reactions = await message.addReactionToComment(
      commentId,
      emoji,
      employeeFromDb
    );

    const io = getIo(req);
    if (io) {
      io.to(`message:${messageId}`).emit("comment:reaction", {
        commentId,
        userId: employeeFromDb._id,
        emoji,
        reactions,
        messageId,
      });
    }

    res.json({
      success: true,
      data: { reactions },
    });
  } catch (error) {
    console.error("Error adding reaction:", error);
    res.status(500).json({
      success: false,
      error: "Server error",
    });
  }
};

// @desc    Get comment statistics
// @route   GET /api/whatsapp-messages/:messageId/comments/stats
// @access  Private
exports.getCommentStats = async (req, res) => {
  try {
    const { messageId } = req.params;

    const message = await WhatsAppMessage.findById(messageId)
      .select(
        "commentCount lastCommentAt commenters lastCommentBy comments"
      )
      .populate("lastCommentBy", "name email avatar")
      .populate("commenters", "name email avatar");

    if (!message) {
      return res.status(404).json({
        success: false,
        error: "Message not found",
      });
    }

    const commentsByDay = {};
    (message.comments || []).forEach((comment) => {
      const date = comment.createdAt.toISOString().split("T")[0];
      commentsByDay[date] = (commentsByDay[date] || 0) + 1;
    });

    const statsPayload = {
      commentCount: message.commentCount || 0,
      lastCommentAt: message.lastCommentAt,
      lastCommentBy: message.lastCommentBy,
      commenters: message.commenters || [],
      activity: commentsByDay,
      topCommenters: (message.commenters || []).slice(0, 5),
    };

    // Optional realtime push of stats (if you want live dashboards)
    const io = getIo(req);
    if (io) {
      io.to(`message:${messageId}`).emit("comment:stats", {
        messageId,
        stats: statsPayload,
      });
    }

    res.json({
      success: true,
      data: statsPayload,
    });
  } catch (error) {
    console.error("Error getting comment stats:", error);
    res.status(500).json({
      success: false,
      error: "Server error",
    });
  }
};