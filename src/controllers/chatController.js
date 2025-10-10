const express = require("express");
const { Conversation, Message, Space } = require("../models/Chat");
const Employee = require("../models/Employees");
const mongoose = require("mongoose");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

// ✅ Configure multer for file uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadDir = "uploads/chat-attachments/";
    // Create uploads directory if it doesn't exist
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    // Generate unique filename with timestamp
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(
      null,
      file.fieldname + "-" + uniqueSuffix + path.extname(file.originalname)
    );
  },
});

// File filter for allowed types
const fileFilter = (req, file, cb) => {
  const allowedMimes = [
    "image/jpeg",
    "image/jpg",
    "image/png",
    "image/gif",
    "image/webp",
    "image/svg+xml",
    "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "text/csv",
    "text/plain",
  ];

  if (allowedMimes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(
      new Error(
        `Invalid file type: ${file.mimetype}. Allowed types: images, PDF, Word, Excel, CSV, text files.`
      ),
      false
    );
  }
};

// ✅ Create and export upload middleware
const upload = multer({
  storage: storage,
  fileFilter: fileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
  },
});

exports.upload = upload; // ✅ Export upload middleware

// Upload file endpoint
exports.uploadFile = async (req, res) => {
  try {
    // Use multer middleware to handle file upload
    upload.single("file")(req, res, async function (err) {
      if (err) {
        return res.status(400).json({
          success: false,
          error: err.message,
        });
      }

      if (!req.file) {
        return res.status(400).json({
          success: false,
          error: "No file uploaded",
        });
      }

      // ✅ Create file object with proper full URL
      const fileData = {
        filename: req.file.filename,
        originalName: req.file.originalname,
        mimetype: req.file.mimetype,
        size: req.file.size,
        url: `${req.protocol}://${req.get("host")}/uploads/chat-attachments/${
          req.file.filename
        }`, // Full URL
        uploadedAt: new Date(),
      };

      console.log("✅ File uploaded with URL:", fileData.url);

      res.json({
        success: true,
        message: "File uploaded successfully",
        file: fileData,
      });
    });
  } catch (error) {
    console.error("Upload file error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to upload file",
    });
  }
};

// Upload multiple files endpoint
exports.uploadFiles = async (req, res) => {
  try {
    upload.array("files", 10)(req, res, async function (err) {
      if (err) {
        return res.status(400).json({
          success: false,
          error: err.message,
        });
      }

      if (!req.files || req.files.length === 0) {
        return res.status(400).json({
          success: false,
          error: "No files uploaded",
        });
      }

      const uploadedFiles = req.files.map((file) => ({
        filename: file.filename,
        originalName: file.originalname,
        mimetype: file.mimetype,
        size: file.size,
        url: `${req.protocol}://${req.get("host")}/uploads/chat-attachments/${
          file.filename
        }`,
        uploadedAt: new Date(),
      }));

      res.json({
        success: true,
        message: `${uploadedFiles.length} files uploaded successfully`,
        files: uploadedFiles,
      });
    });
  } catch (error) {
    console.error("Upload files error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to upload files",
    });
  }
};

// ✅ UPDATE THIS: getConversations function to include photographUrl
exports.getConversations = async (req, res) => {
  try {
    // Get direct conversations - UPDATED to include photographUrl
    const conversations = await Conversation.find({
      participants: req.employee._id,
      isGroup: false,
    })
      .populate("participants", "name companyEmail avatar photographUrl") // ✅ Added photographUrl
      .populate("lastMessage")
      .sort({ updatedAt: -1 });

    // Get group conversations - UPDATED to include photographUrl
    const groupConversations = await Conversation.find({
      participants: req.employee._id,
      isGroup: true,
    })
      .populate("participants", "name companyEmail avatar photographUrl") // ✅ Added photographUrl
      .populate("lastMessage")
      .populate("admins", "name companyEmail avatar photographUrl") // ✅ Added photographUrl
      .sort({ updatedAt: -1 });

    // Get spaces - UPDATED to include photographUrl
    const spaces = await Space.find({
      members: req.employee._id,
    })
      .populate("createdBy", "name companyEmail avatar photographUrl") // ✅ Added photographUrl
      .populate("admins", "name companyEmail avatar photographUrl") // ✅ Added photographUrl
      .populate("members", "name companyEmail avatar photographUrl") // ✅ Added photographUrl
      .sort({ updatedAt: -1 });

    res.json({
      success: true,
      conversations: conversations.map((conv) => ({
        _id: conv._id,
        participants: conv.participants.filter(
          (p) => p._id.toString() !== req.employee._id.toString()
        ),
        lastMessage: conv.lastMessage,
        unreadCount: conv.unreadCount.get(req.employee._id.toString()) || 0,
        updatedAt: conv.updatedAt,
        type: "dm",
      })),
      groups: groupConversations.map((conv) => ({
        _id: conv._id,
        participants: conv.participants,
        lastMessage: conv.lastMessage,
        unreadCount: conv.unreadCount.get(req.employee._id.toString()) || 0,
        updatedAt: conv.updatedAt,
        groupName: conv.groupName,
        groupDescription: conv.groupDescription,
        groupAvatar: conv.groupAvatar,
        admins: conv.admins,
        type: "group",
      })),
      spaces: spaces.map((space) => ({
        _id: space._id,
        name: space.name,
        description: space.description,
        avatar: space.avatar,
        createdBy: space.createdBy,
        admins: space.admins,
        members: space.members,
        isPrivate: space.isPrivate,
        memberCount: space.members.length,
        type: "space",
      })),
    });
  } catch (error) {
    console.error("Get conversations error:", error);
    res
      .status(500)
      .json({ success: false, error: "Failed to fetch conversations" });
  }
};
exports.getMessages = async (req, res) => {
  try {
    const { conversationId } = req.params;
    const { page = 1, limit = 50 } = req.query;

    console.log("🔍 Fetching messages for conversation:", conversationId);

    // Validate conversation ID
    if (!mongoose.Types.ObjectId.isValid(conversationId)) {
      return res
        .status(400)
        .json({ success: false, error: "Invalid conversation ID" });
    }

    // Check if user is participant in this conversation
    const conversation = await Conversation.findOne({
      _id: conversationId,
      participants: req.employee._id,
    }).populate("participants", "name companyEmail avatar");

    if (!conversation) {
      return res.status(404).json({
        success: false,
        error: "Conversation not found or access denied",
      });
    }

    // Query messages by conversation ID
    const messages = await Message.find({
      conversation: conversationId,
    })
      .populate("sender", "name companyEmail avatar")
      .populate("receiver", "name companyEmail avatar")
      .populate("receivers", "name companyEmail avatar")
      .populate("space")
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    console.log(`📨 Found ${messages.length} messages`);

    // Mark messages as read
    const unreadMessages = messages.filter((msg) => {
      if (msg.isGroupMessage || msg.space) {
        return !msg.readBy.some(
          (read) => read.employee.toString() === req.employee._id.toString()
        );
      } else {
        return (
          !msg.read &&
          msg.receiver &&
          msg.receiver._id.toString() === req.employee._id.toString()
        );
      }
    });

    if (unreadMessages.length > 0) {
      console.log(`📖 Marking ${unreadMessages.length} messages as read`);

      if (conversation.isGroup || conversation.space) {
        await Message.updateMany(
          {
            _id: { $in: unreadMessages.map((m) => m._id) },
          },
          {
            $addToSet: {
              readBy: {
                employee: req.employee._id,
                readAt: new Date(),
              },
            },
          }
        );
      } else {
        await Message.updateMany(
          {
            _id: { $in: unreadMessages.map((m) => m._id) },
            read: false,
          },
          {
            read: true,
            readAt: new Date(),
          }
        );
      }

      // Update conversation unread count
      conversation.unreadCount.set(req.employee._id.toString(), 0);
      await conversation.save();

      // ✅ UPDATED: Use socket event that matches frontend
      const io = req.app.get("io");
      if (io) {
        const otherParticipants = conversation.participants
          .filter((p) => p._id.toString() !== req.employee._id.toString())
          .map((p) => p._id.toString());

        otherParticipants.forEach((participantId) => {
          io.to(`conversation_${conversationId}`).emit("messages_read", {
            conversationId,
            userId: req.employee._id,
            messageIds: unreadMessages.map((m) => m._id),
            readAt: new Date(),
          });
        });
      }
    }

    res.json({
      success: true,
      messages: messages.reverse(),
      hasMore: messages.length === limit,
      participant: conversation.participants.find(
        (p) => p._id.toString() !== req.employee._id.toString()
      ),
    });
  } catch (error) {
    console.error("Get messages error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch messages",
      details: error.message,
    });
  }
};

exports.startConversation = async (req, res) => {
  try {
    const { participantId } = req.body;

    if (!participantId) {
      return res
        .status(400)
        .json({ success: false, error: "Participant ID is required" });
    }

    // Validate participant ID
    if (!mongoose.Types.ObjectId.isValid(participantId)) {
      return res
        .status(400)
        .json({ success: false, error: "Invalid participant ID" });
    }

    // Check if conversation already exists
    let conversation = await Conversation.findOne({
      participants: { $all: [req.employee._id, participantId] },
    })
      .populate("participants", "name companyEmail avatar")
      .populate("lastMessage");

    if (!conversation) {
      // Create new conversation with unreadCount map
      conversation = new Conversation({
        participants: [req.employee._id, participantId],
        unreadCount: new Map([
          [req.employee._id.toString(), 0],
          [participantId, 0],
        ]),
      });
      await conversation.save();

      // Populate after save
      conversation = await Conversation.findById(conversation._id)
        .populate("participants", "name companyEmail avatar")
        .populate("lastMessage");

      // ✅ UPDATED: Use consistent socket events
      const io = req.app.get("io");
      if (io) {
        [req.employee._id.toString(), participantId].forEach((userId) => {
          io.to(`user_${userId}`).emit("conversation_created", {
            conversation: {
              _id: conversation._id,
              participants: conversation.participants,
              unreadCount: conversation.unreadCount.get(userId) || 0,
              updatedAt: conversation.updatedAt,
              lastMessage: conversation.lastMessage,
            },
          });
        });
      }
    }

    res.json({
      success: true,
      conversation: {
        _id: conversation._id,
        participants: conversation.participants.filter(
          (p) => p._id.toString() !== req.employee._id.toString()
        ),
        lastMessage: conversation.lastMessage,
        unreadCount:
          conversation.unreadCount.get(req.employee._id.toString()) || 0,
        updatedAt: conversation.updatedAt,
      },
    });
  } catch (error) {
    console.error("Start conversation error:", error);
    res
      .status(500)
      .json({ success: false, error: "Failed to start conversation" });
  }
};

exports.sendMessage = async (req, res) => {
  try {
    const { conversationId } = req.params;
    const { content, messageType = "text" } = req.body; // Remove attachments from body

    console.log("📨 Send message request:", {
      conversationId,
      content,
      messageType,
      files: req.files ? req.files.length : 0,
    });

    // ✅ Process uploaded files
    const uploadedAttachments = [];
    if (req.files && req.files.length > 0) {
      uploadedAttachments.push(
        ...req.files.map((file) => ({
          filename: file.filename,
          originalName: file.originalname,
          mimetype: file.mimetype,
          size: file.size,
          url: `${req.protocol}://${req.get("host")}/uploads/chat-attachments/${
            file.filename
          }`,
        }))
      );
    }

    // ✅ UPDATED: Allow empty content if there are attachments
    if (!content?.trim() && uploadedAttachments.length === 0) {
      return res.status(400).json({
        success: false,
        error: "Message content or attachments are required",
      });
    }

    // Validate conversation ID
    if (!mongoose.Types.ObjectId.isValid(conversationId)) {
      return res
        .status(400)
        .json({ success: false, error: "Invalid conversation ID" });
    }

    const conversation = await Conversation.findOne({
      _id: conversationId,
      participants: req.employee._id,
    }).populate("participants", "name companyEmail avatar");

    if (!conversation) {
      return res
        .status(404)
        .json({ success: false, error: "Conversation not found" });
    }

    // Check if this is a group conversation
    const isGroup = conversation.isGroup || conversation.space;

    // ✅ FIXED: Enhanced message type detection for images, GIFs, and files
    let finalMessageType = messageType;

    if (uploadedAttachments.length > 0) {
      const hasGif = uploadedAttachments.some(
        (attachment) =>
          attachment.mimetype === "image/gif" ||
          attachment.url.includes(".gif") ||
          (attachment.originalName &&
            attachment.originalName.toLowerCase().endsWith(".gif"))
      );

      const hasImage = uploadedAttachments.some(
        (attachment) =>
          attachment.mimetype.startsWith("image/") &&
          attachment.mimetype !== "image/gif"
      );

      // If it's a GIF URL from GIPHY, preserve the GIF type
      const isGiphyUrl =
        content &&
        (content.includes("giphy.com") ||
          content.includes("media.giphy.com") ||
          content.includes("media1.giphy.com") ||
          content.includes("media2.giphy.com") ||
          content.includes("media3.giphy.com") ||
          content.includes("media4.giphy.com"));

      if (hasGif || isGiphyUrl) {
        finalMessageType = "gif";
      } else if (hasImage) {
        finalMessageType = "image";
      } else {
        finalMessageType = "file";
      }
    }

    console.log("📨 Message Type Detection:", {
      finalMessageType,
      attachments: uploadedAttachments.map((a) => ({
        mimetype: a.mimetype,
        filename: a.filename,
        url: a.url,
      })),
    });

    // Prepare message data
    const messageData = {
      conversation: conversationId,
      sender: req.employee._id,
      content: content?.trim() || "", // ✅ Allow empty content
      messageType: finalMessageType, // ✅ Use the properly determined type
      attachments: uploadedAttachments,
      isGroupMessage: isGroup,
      readBy: [
        {
          employee: req.employee._id,
          readAt: new Date(),
        },
      ],
    };

    // Handle receiver based on conversation type
    if (!isGroup) {
      const receiver = conversation.participants.find(
        (p) => p._id.toString() !== req.employee._id.toString()
      );

      if (!receiver) {
        return res.status(400).json({
          success: false,
          error: "Could not find receiver for direct message",
        });
      }

      messageData.receiver = receiver._id;
      messageData.read = false;
    } else {
      const receivers = conversation.participants
        .filter((p) => p._id.toString() !== req.employee._id.toString())
        .map((p) => p._id);
      messageData.receivers = receivers;
      messageData.space = conversation.space;
    }

    // Create new message
    const message = new Message(messageData);
    await message.save();

    // Update conversation
    conversation.lastMessage = message._id;
    conversation.updatedAt = new Date();

    // Update unread counts
    if (!isGroup) {
      const receiver = conversation.participants.find(
        (p) => p._id.toString() !== req.employee._id.toString()
      );
      if (receiver) {
        const currentCount =
          conversation.unreadCount.get(receiver._id.toString()) || 0;
        conversation.unreadCount.set(receiver._id.toString(), currentCount + 1);
      }
    } else {
      conversation.participants.forEach((participant) => {
        if (participant._id.toString() !== req.employee._id.toString()) {
          const currentCount =
            conversation.unreadCount.get(participant._id.toString()) || 0;
          conversation.unreadCount.set(
            participant._id.toString(),
            currentCount + 1
          );
        }
      });
    }

    await conversation.save();

    // Populate and return
    const populatedMessage = await Message.findById(message._id)
      .populate("sender", "name companyEmail avatar")
      .populate("receiver", "name companyEmail avatar")
      .populate("receivers", "name companyEmail avatar")
      .populate("conversation")
      .populate("space");

    // ✅ CRITICAL FIX: Use io.to() for broadcasting
    const io = req.app.get("io");
    if (io) {
      // Broadcast to ALL users in the conversation room
      io.to(`conversation_${conversationId}`).emit(
        "receive_message",
        populatedMessage
      );

      console.log(`✅ Message broadcasted to conversation_${conversationId}`);
    }

    res.json({
      success: true,
      message: populatedMessage,
    });
  } catch (error) {
    console.error("Send message error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to send message",
      details: error.message,
    });
  }
};

exports.sendDirectMessage = async (req, res) => {
  try {
    const { participantId, content, messageType = "text" } = req.body;

    // ✅ Process uploaded files
    const uploadedAttachments = [];
    if (req.files && req.files.length > 0) {
      uploadedAttachments.push(
        ...req.files.map((file) => ({
          filename: file.filename,
          originalName: file.originalname,
          mimetype: file.mimetype,
          size: file.size,
          url: `${req.protocol}://${req.get("host")}/uploads/chat-attachments/${
            file.filename
          }`,
        }))
      );
    }

    if (!participantId) {
      return res.status(400).json({
        success: false,
        error: "Participant ID is required",
      });
    }

    if (!content && uploadedAttachments.length === 0) {
      return res.status(400).json({
        success: false,
        error: "Message content or attachments are required",
      });
    }

    // Find or create conversation
    let conversation = await Conversation.findOne({
      participants: { $all: [req.employee._id, participantId] },
      isGroup: false,
    });

    if (!conversation) {
      conversation = new Conversation({
        participants: [req.employee._id, participantId],
        unreadCount: new Map([
          [req.employee._id.toString(), 0],
          [participantId, 0],
        ]),
      });
      await conversation.save();
    }

    // ✅ FIX: Enhanced message type detection for direct messages
    let finalMessageType = messageType;

    if (uploadedAttachments.length > 0) {
      const hasGif = uploadedAttachments.some(
        (attachment) =>
          attachment.mimetype === "image/gif" ||
          attachment.url.includes(".gif") ||
          (attachment.originalName &&
            attachment.originalName.toLowerCase().endsWith(".gif"))
      );

      const hasImage = uploadedAttachments.some(
        (attachment) =>
          attachment.mimetype.startsWith("image/") &&
          attachment.mimetype !== "image/gif"
      );

      const isGiphyUrl =
        content &&
        (content.includes("giphy.com") ||
          content.includes("media.giphy.com") ||
          content.includes("media1.giphy.com") ||
          content.includes("media2.giphy.com") ||
          content.includes("media3.giphy.com") ||
          content.includes("media4.giphy.com"));

      if (hasGif || isGiphyUrl) {
        finalMessageType = "gif";
      } else if (hasImage) {
        finalMessageType = "image";
      } else {
        finalMessageType = "file";
      }
    }

    // Create message
    const receiver = conversation.participants.find(
      (p) => p.toString() !== req.employee._id.toString()
    );

    const message = new Message({
      conversation: conversation._id,
      sender: req.employee._id,
      receiver: receiver,
      content: content?.trim(),
      messageType: finalMessageType, // ✅ Use the properly determined type
      attachments: uploadedAttachments,
      read: false,
    });

    await message.save();

    // Update conversation
    conversation.lastMessage = message._id;
    conversation.updatedAt = new Date();

    // Increment unread count for receiver
    const currentCount = conversation.unreadCount.get(receiver.toString()) || 0;
    conversation.unreadCount.set(receiver.toString(), currentCount + 1);

    await conversation.save();

    // Populate message
    const populatedMessage = await Message.findById(message._id)
      .populate("sender", "name companyEmail avatar")
      .populate("receiver", "name companyEmail avatar");

    // ✅ UPDATED: Use compatible socket events
    const io = req.app.get("io");
    if (io) {
      io.to(`conversation_${conversation._id}`).emit(
        "receive_message",
        populatedMessage
      );
      io.to(`user_${req.employee._id}`).emit("message_sent", {
        success: true,
        message: populatedMessage,
      });

      console.log(`✅ Direct message sent via socket`);
    }

    res.json({
      success: true,
      message: populatedMessage,
      conversation: {
        _id: conversation._id,
        participants: [receiver],
        lastMessage: populatedMessage,
        unreadCount:
          conversation.unreadCount.get(req.employee._id.toString()) || 0,
        updatedAt: conversation.updatedAt,
      },
    });
  } catch (error) {
    console.error("Send direct message error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to send direct message",
      details: error.message,
    });
  }
};

exports.markAsRead = async (req, res) => {
  try {
    const { conversationId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(conversationId)) {
      return res
        .status(400)
        .json({ success: false, error: "Invalid conversation ID" });
    }

    const conversation = await Conversation.findOne({
      _id: conversationId,
      participants: req.employee._id,
    });

    if (!conversation) {
      return res
        .status(404)
        .json({ success: false, error: "Conversation not found" });
    }

    const otherParticipant = conversation.participants.find(
      (p) => p.toString() !== req.employee._id.toString()
    );

    if (!otherParticipant) {
      return res
        .status(400)
        .json({ success: false, error: "Other participant not found" });
    }

    // Mark all unread messages from this conversation as read
    const updateResult = await Message.updateMany(
      {
        conversation: conversationId,
        receiver: req.employee._id,
        sender: otherParticipant,
        read: false,
      },
      {
        read: true,
        readAt: new Date(),
      }
    );

    // Reset unread count for current user
    conversation.unreadCount.set(req.employee._id.toString(), 0);
    await conversation.save();

    // ✅ UPDATED: Use socket event that matches frontend
    const io = req.app.get("io");
    if (io) {
      io.to(`conversation_${conversationId}`).emit("messages_read", {
        conversationId,
        userId: req.employee._id,
        messageIds: [], // You might want to track specific message IDs
        readAt: new Date(),
      });

      console.log(`✅ Read receipts sent for conversation: ${conversationId}`);
    }

    res.json({
      success: true,
      message: "Messages marked as read",
      updatedCount: updateResult.modifiedCount,
    });
  } catch (error) {
    console.error("Mark as read error:", error);
    res
      .status(500)
      .json({ success: false, error: "Failed to mark messages as read" });
  }
};

// Mark conversation as unread
exports.markAsUnread = async (req, res) => {
  try {
    const { conversationId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(conversationId)) {
      return res
        .status(400)
        .json({ success: false, error: "Invalid conversation ID" });
    }

    const conversation = await Conversation.findOne({
      _id: conversationId,
      participants: req.employee._id,
    });

    if (!conversation) {
      return res
        .status(404)
        .json({ success: false, error: "Conversation not found" });
    }

    // Get the last message to set as unread
    const lastMessage = await Message.findOne({
      conversation: conversationId,
    }).sort({ createdAt: -1 });

    if (lastMessage) {
      // For direct messages
      if (!conversation.isGroup && !conversation.space) {
        await Message.updateOne(
          { _id: lastMessage._id },
          {
            read: false,
            readAt: null,
            $pull: { readBy: { employee: req.employee._id } },
          }
        );
      } else {
        // For group/space messages
        await Message.updateOne(
          { _id: lastMessage._id },
          {
            $pull: { readBy: { employee: req.employee._id } },
          }
        );
      }

      // Set unread count to 1 (simulating one unread message)
      conversation.unreadCount.set(req.employee._id.toString(), 1);
      await conversation.save();
    }

    // Emit socket event
    const io = req.app.get("io");
    if (io) {
      io.to(`conversation_${conversationId}`).emit(
        "conversation_marked_unread",
        {
          conversationId,
          userId: req.employee._id,
          unreadCount: 1,
        }
      );
    }

    res.json({
      success: true,
      message: "Conversation marked as unread",
      unreadCount: 1,
    });
  } catch (error) {
    console.error("Mark as unread error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to mark conversation as unread",
    });
  }
};

// Get conversation by participant - UPDATED WITH SOCKET
exports.getConversationByParticipant = async (req, res) => {
  try {
    const { participantId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(participantId)) {
      return res
        .status(400)
        .json({ success: false, error: "Invalid participant ID" });
    }

    const conversation = await Conversation.findOne({
      participants: { $all: [req.employee._id, participantId] },
    })
      .populate("participants", "name companyEmail avatar")
      .populate("lastMessage");

    if (!conversation) {
      return res
        .status(404)
        .json({ success: false, error: "Conversation not found" });
    }

    // ✅ EMIT SOCKET EVENT FOR CONVERSATION ACCESS (for typing indicators, etc.)
    const io = req.app.get("io");
    if (io) {
      io.to(`employee_${participantId}`).emit("conversation_accessed", {
        conversationId: conversation._id,
        accessedBy: req.employee._id,
        accessedAt: new Date(),
      });
    }

    res.json({
      success: true,
      conversation: {
        _id: conversation._id,
        participants: conversation.participants.filter(
          (p) => p._id.toString() !== req.employee._id.toString()
        ),
        lastMessage: conversation.lastMessage,
        unreadCount:
          conversation.unreadCount.get(req.employee._id.toString()) || 0,
        updatedAt: conversation.updatedAt,
      },
    });
  } catch (error) {
    console.error("Get conversation by participant error:", error);
    res
      .status(500)
      .json({ success: false, error: "Failed to fetch conversation" });
  }
};

// Create new space/group - UPDATED WITH SOCKET
exports.createSpace = async (req, res) => {
  try {
    const { name, description, avatar, memberIds, isPrivate, settings } =
      req.body;

    if (!name) {
      return res
        .status(400)
        .json({ success: false, error: "Space name is required" });
    }

    // Create space
    const space = new Space({
      name,
      description,
      avatar,
      createdBy: req.employee._id,
      admins: [req.employee._id],
      members: [req.employee._id, ...(memberIds || [])],
      isPrivate: isPrivate || false,
      settings: settings || {},
    });

    await space.save();

    // Create group conversation
    const conversation = new Conversation({
      participants: space.members,
      isGroup: true,
      groupName: space.name,
      groupDescription: space.description,
      groupAvatar: space.avatar,
      admins: [req.employee._id],
      unreadCount: new Map(),
    });

    await conversation.save();

    // Populate data
    const populatedSpace = await Space.findById(space._id)
      .populate("createdBy", "name companyEmail avatar")
      .populate("admins", "name companyEmail avatar")
      .populate("members", "name companyEmail avatar");

    const populatedConversation = await Conversation.findById(conversation._id)
      .populate("participants", "name companyEmail avatar")
      .populate("admins", "name companyEmail avatar");

    // ✅ EMIT SOCKET EVENT FOR NEW SPACE CREATION
    const io = req.app.get("io");
    if (io) {
      // Notify all members about the new space
      space.members.forEach((memberId) => {
        io.to(`employee_${memberId.toString()}`).emit("space_created", {
          space: populatedSpace,
          conversation: populatedConversation,
          createdBy: req.employee._id,
        });
      });

      console.log(
        `✅ Space creation notified to ${space.members.length} members`
      );
    }

    res.json({
      success: true,
      space: populatedSpace,
      conversation: populatedConversation,
    });
  } catch (error) {
    console.error("Create space error:", error);
    res.status(500).json({ success: false, error: "Failed to create space" });
  }
};

// ✅ GET SPACE MEMBERS (optimized + schema-aligned)
exports.getSpaceMembers = async (req, res) => {
  try {
    const { spaceId } = req.params;

    // Validate spaceId
    if (!mongoose.Types.ObjectId.isValid(spaceId)) {
      return res.status(400).json({
        success: false,
        error: "Invalid space ID",
      });
    }

    // ✅ Fetch space efficiently with minimal populate
    const space = await Space.findById(spaceId)
      .populate([
        { path: "createdBy", select: "name companyEmail avatar photographUrl" },
        { path: "admins", select: "name companyEmail avatar photographUrl" },
        {
          path: "members",
          select:
            "name companyEmail avatar photographUrl department position isOnline",
        },
      ])
      .lean();

    if (!space) {
      return res.status(404).json({
        success: false,
        error: "Space not found",
      });
    }

    // ✅ Check access
    const isMember = space.members?.some(
      (m) => m._id.toString() === req.employee._id.toString()
    );
    if (!isMember) {
      return res.status(403).json({
        success: false,
        error: "Access denied. You are not a member of this space.",
      });
    }

    // ✅ Precompute role sets
    const ownerId = space.createdBy?._id?.toString();
    const adminIds = new Set(space.admins?.map((a) => a._id.toString()) || []);

    // ✅ Build formatted member list
    const members = space.members.map((member) => {
      const memberId = member._id.toString();
      const isOwner = memberId === ownerId;
      const isAdmin = adminIds.has(memberId);

      return {
        id: member._id,
        _id: member._id,
        name: member.name,
        email: member.companyEmail || member.email,
        role: isOwner ? "Owner" : isAdmin ? "Admin" : "Member",
        avatarUrl: member.photographUrl || member.avatar || null,
        department: member.department || "N/A",
        position: member.position || "N/A",
        isOnline: member.isOnline ?? false,
        statusColor: member.isOnline ? "#34a853" : "#9e9e9e",
      };
    });

    // ✅ Sort by role
    const sortedMembers = members.sort((a, b) => {
      const order = { Owner: 0, Admin: 1, Member: 2 };
      return order[a.role] - order[b.role];
    });

    // ✅ Final response
    res.json({
      success: true,
      space: {
        _id: space._id,
        name: space.name,
        description: space.description,
        avatar: space.avatar,
        createdBy: space.createdBy,
        totalMembers: members.length,
        isPrivate: space.isPrivate,
        settings: space.settings,
      },
      members: sortedMembers,
    });
  } catch (error) {
    console.error("❌ getSpaceMembers error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch space members",
      details: error.message,
    });
  }
};

// Add members to space - UPDATED WITH SOCKET
exports.addSpaceMembers = async (req, res) => {
  try {
    const { spaceId } = req.params;
    const { memberIds } = req.body;

    if (!memberIds || !Array.isArray(memberIds)) {
      return res
        .status(400)
        .json({ success: false, error: "Member IDs are required" });
    }

    const space = await Space.findOne({
      _id: spaceId,
      $or: [{ createdBy: req.employee._id }, { admins: req.employee._id }],
    });

    if (!space) {
      return res.status(404).json({
        success: false,
        error: "Space not found or insufficient permissions",
      });
    }

    // Add new members
    const newMembers = memberIds.filter(
      (id) =>
        !space.members.some((memberId) => memberId.toString() === id.toString())
    );
    space.members.push(...newMembers);
    await space.save();

    // Update conversation participants
    await Conversation.findOneAndUpdate(
      { _id: spaceId, isGroup: true },
      { $addToSet: { participants: { $each: newMembers } } }
    );

    const populatedSpace = await Space.findById(space._id).populate(
      "members",
      "name companyEmail avatar"
    );

    // ✅ EMIT SOCKET EVENT FOR NEW MEMBERS
    const io = req.app.get("io");
    if (io) {
      // Notify new members they were added
      newMembers.forEach((memberId) => {
        io.to(`employee_${memberId}`).emit("added_to_space", {
          space: populatedSpace,
          addedBy: req.employee._id,
          addedAt: new Date(),
        });
      });

      // Notify existing members about new members
      io.to(`space_${spaceId}`).emit("space_members_updated", {
        spaceId,
        newMembers,
        updatedBy: req.employee._id,
        updatedAt: new Date(),
      });

      console.log(`✅ ${newMembers.length} new members notified`);
    }

    res.json({
      success: true,
      space: populatedSpace,
      addedMembers: newMembers.length,
    });
  } catch (error) {
    console.error("Add space members error:", error);
    res.status(500).json({ success: false, error: "Failed to add members" });
  }
};

exports.sendSpaceMessage = async (req, res) => {
  try {
    const { spaceId } = req.params;
    const { content, messageType = "text" } = req.body;

    // ✅ Process uploaded files
    const uploadedAttachments = [];
    if (req.files && req.files.length > 0) {
      uploadedAttachments.push(
        ...req.files.map((file) => ({
          filename: file.filename,
          originalName: file.originalname,
          mimetype: file.mimetype,
          size: file.size,
          url: `${req.protocol}://${req.get("host")}/uploads/chat-attachments/${
            file.filename
          }`,
        }))
      );
    }

    if (!content && uploadedAttachments.length === 0) {
      return res.status(400).json({
        success: false,
        error: "Message content or attachments are required",
      });
    }

    // First, get the space with populated members
    const space = await Space.findOne({
      _id: spaceId,
      members: req.employee._id,
    }).populate("members", "_id name companyEmail avatar");

    if (!space) {
      return res
        .status(404)
        .json({ success: false, error: "Space not found or access denied" });
    }

    // Check message permissions
    if (
      space.settings.messagePermissions === "admins_only" &&
      !space.admins.includes(req.employee._id)
    ) {
      return res.status(403).json({
        success: false,
        error: "Only admins can send messages in this space",
      });
    }

    // Find or create conversation for this space
    let conversation = await Conversation.findOne({ space: spaceId }).populate(
      "participants",
      "_id"
    );

    if (!conversation) {
      conversation = new Conversation({
        participants: space.members.map((m) => m._id),
        isGroup: true,
        space: spaceId,
        groupName: space.name,
        groupDescription: space.description,
        groupAvatar: space.avatar,
        admins: space.admins,
        unreadCount: new Map(),
      });
      await conversation.save();

      conversation = await Conversation.findById(conversation._id).populate(
        "participants",
        "_id"
      );
    }

    // ✅ FIX: Enhanced message type detection for space messages
    let finalMessageType = messageType;

    if (uploadedAttachments.length > 0) {
      const hasGif = uploadedAttachments.some(
        (attachment) =>
          attachment.mimetype === "image/gif" ||
          attachment.url.includes(".gif") ||
          (attachment.originalName &&
            attachment.originalName.toLowerCase().endsWith(".gif"))
      );

      const hasImage = uploadedAttachments.some(
        (attachment) =>
          attachment.mimetype.startsWith("image/") &&
          attachment.mimetype !== "image/gif"
      );

      const isGiphyUrl =
        content &&
        (content.includes("giphy.com") ||
          content.includes("media.giphy.com") ||
          content.includes("media1.giphy.com") ||
          content.includes("media2.giphy.com") ||
          content.includes("media3.giphy.com") ||
          content.includes("media4.giphy.com"));

      if (hasGif || isGiphyUrl) {
        finalMessageType = "gif";
      } else if (hasImage) {
        finalMessageType = "image";
      } else {
        finalMessageType = "file";
      }
    }

    // Get receivers (all members except sender)
    const receivers = space.members
      .filter((member) => member._id.toString() !== req.employee._id.toString())
      .map((member) => member._id);

    console.log("📨 Space Message Details:", {
      spaceId,
      totalMembers: space.members.length,
      sender: req.employee._id,
      receiversCount: receivers.length,
      messageType: finalMessageType, // ✅ Log the determined message type
      attachments: uploadedAttachments.length,
    });

    // Create message with multiple receivers
    const message = new Message({
      conversation: conversation._id,
      sender: req.employee._id,
      receivers: receivers,
      space: spaceId,
      content: content?.trim(),
      messageType: finalMessageType, // ✅ Use the properly determined type
      attachments: uploadedAttachments,
      isGroupMessage: true,
      readBy: [
        {
          employee: req.employee._id,
          readAt: new Date(),
        },
      ],
    });

    await message.save();

    // Update conversation
    conversation.lastMessage = message._id;
    conversation.updatedAt = new Date();

    // Initialize unreadCount map if it doesn't exist
    if (!conversation.unreadCount) {
      conversation.unreadCount = new Map();
    }

    // Increment unread count for all receivers
    receivers.forEach((receiverId) => {
      const currentCount =
        conversation.unreadCount.get(receiverId.toString()) || 0;
      conversation.unreadCount.set(receiverId.toString(), currentCount + 1);
    });

    await conversation.save();

    // Populate message for response
    const populatedMessage = await Message.findById(message._id)
      .populate("sender", "name companyEmail avatar")
      .populate("receivers", "name companyEmail avatar")
      .populate("space")
      .populate("conversation");

    // ✅ CRITICAL FIX: Use io.to() for broadcasting
    const io = req.app.get("io");
    if (io) {
      // Broadcast to ALL users in the space room
      io.to(`space_${spaceId}`).emit("receive_space_message", populatedMessage);

      console.log(`✅ Space message broadcasted to space_${spaceId}`);
    }

    res.json({
      success: true,
      message: populatedMessage,
    });
  } catch (error) {
    console.error("Send space message error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to send message",
      details: error.message,
    });
  }
};
// ✅ REMOVE MEMBER FROM SPACE
exports.removeSpaceMember = async (req, res) => {
  try {
    const { spaceId, memberId } = req.params;

    if (
      !mongoose.Types.ObjectId.isValid(spaceId) ||
      !mongoose.Types.ObjectId.isValid(memberId)
    ) {
      return res.status(400).json({
        success: false,
        error: "Invalid space ID or member ID",
      });
    }

    // Find space and verify permissions
    const space = await Space.findById(spaceId)
      .populate("createdBy", "name companyEmail avatar")
      .populate("admins", "name companyEmail avatar")
      .populate("members", "name companyEmail avatar");

    if (!space) {
      return res.status(404).json({
        success: false,
        error: "Space not found",
      });
    }

    // Check if user has permission to remove members
    const isAdminOrOwner =
      space.createdBy._id.toString() === req.employee._id.toString() ||
      space.admins.some(
        (admin) => admin._id.toString() === req.employee._id.toString()
      );

    if (!isAdminOrOwner) {
      return res.status(403).json({
        success: false,
        error: "Only space owners and admins can remove members",
      });
    }

    // Prevent owner from being removed
    if (space.createdBy._id.toString() === memberId) {
      return res.status(400).json({
        success: false,
        error: "Space owner cannot be removed",
      });
    }

    // Check if member exists in space
    const memberExists = space.members.some(
      (member) => member._id.toString() === memberId
    );

    if (!memberExists) {
      return res.status(404).json({
        success: false,
        error: "Member not found in this space",
      });
    }

    // Remove member from space
    space.members = space.members.filter(
      (member) => member._id.toString() !== memberId
    );

    // Remove from admins if they were an admin
    space.admins = space.admins.filter(
      (admin) => admin._id.toString() !== memberId
    );

    await space.save();

    // Remove from conversation participants if exists
    const conversation = await Conversation.findOne({ space: spaceId });
    if (conversation) {
      conversation.participants = conversation.participants.filter(
        (participant) => participant.toString() !== memberId
      );
      await conversation.save();
    }

    // ✅ EMIT SOCKET EVENT FOR MEMBER REMOVAL
    const io = req.app.get("io");
    if (io) {
      // Notify the removed member
      io.to(`employee_${memberId}`).emit("removed_from_space", {
        space: {
          _id: space._id,
          name: space.name,
        },
        removedBy: {
          _id: req.employee._id,
          name: req.employee.name,
        },
        removedAt: new Date(),
      });

      // Notify other space members
      io.to(`space_${spaceId}`).emit("space_members_updated", {
        spaceId,
        removedMemberId: memberId,
        updatedBy: {
          _id: req.employee._id,
          name: req.employee.name,
        },
        updatedAt: new Date(),
        action: "member_removed",
      });

      console.log(`✅ Member ${memberId} removed from space ${spaceId}`);
    }

    res.json({
      success: true,
      message: "Member removed successfully",
      removedMemberId: memberId,
      totalMembers: space.members.length,
    });
  } catch (error) {
    console.error("Remove space member error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to remove member from space",
      details: error.message,
    });
  }
};

// ✅ UPDATE MEMBER ROLE (Promote/Demote)
exports.updateMemberRole = async (req, res) => {
  try {
    const { spaceId, memberId } = req.params;
    const { role } = req.body; // 'admin' or 'member'

    if (
      !mongoose.Types.ObjectId.isValid(spaceId) ||
      !mongoose.Types.ObjectId.isValid(memberId)
    ) {
      return res.status(400).json({
        success: false,
        error: "Invalid space ID or member ID",
      });
    }

    if (!["admin", "member"].includes(role)) {
      return res.status(400).json({
        success: false,
        error: "Role must be either 'admin' or 'member'",
      });
    }

    // Find space and verify permissions
    const space = await Space.findById(spaceId)
      .populate("createdBy", "name companyEmail avatar")
      .populate("admins", "name companyEmail avatar")
      .populate("members", "name companyEmail avatar");

    if (!space) {
      return res.status(404).json({
        success: false,
        error: "Space not found",
      });
    }

    // Only owner can update roles
    if (space.createdBy._id.toString() !== req.employee._id.toString()) {
      return res.status(403).json({
        success: false,
        error: "Only space owner can update member roles",
      });
    }

    // Cannot change owner's role
    if (space.createdBy._id.toString() === memberId) {
      return res.status(400).json({
        success: false,
        error: "Cannot change owner's role",
      });
    }

    // Check if member exists in space
    const memberExists = space.members.some(
      (member) => member._id.toString() === memberId
    );

    if (!memberExists) {
      return res.status(404).json({
        success: false,
        error: "Member not found in this space",
      });
    }

    const isCurrentlyAdmin = space.admins.some(
      (admin) => admin._id.toString() === memberId
    );

    if (role === "admin" && !isCurrentlyAdmin) {
      // Promote to admin
      space.admins.push(memberId);
    } else if (role === "member" && isCurrentlyAdmin) {
      // Demote to member
      space.admins = space.admins.filter(
        (admin) => admin._id.toString() !== memberId
      );
    }

    await space.save();

    // ✅ EMIT SOCKET EVENT FOR ROLE UPDATE
    const io = req.app.get("io");
    if (io) {
      io.to(`space_${spaceId}`).emit("space_members_updated", {
        spaceId,
        memberId,
        newRole: role,
        updatedBy: {
          _id: req.employee._id,
          name: req.employee.name,
        },
        updatedAt: new Date(),
        action: "role_updated",
      });

      console.log(
        `✅ Member ${memberId} role updated to ${role} in space ${spaceId}`
      );
    }

    res.json({
      success: true,
      message: `Member role updated to ${role} successfully`,
      memberId,
      newRole: role,
    });
  } catch (error) {
    console.error("Update member role error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to update member role",
      details: error.message,
    });
  }
};
// ✅ GET SPACE DETAILS
// ✅ GET SPACE DETAILS (from conversation schema)
exports.getSpaceDetails = async (req, res) => {
  try {
    const { spaceId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(spaceId)) {
      return res.status(400).json({
        success: false,
        error: "Invalid space ID",
      });
    }

    // Get space basic info
    const space = await Space.findById(spaceId)
      .populate("createdBy", "name companyEmail avatar photographUrl")
      .populate("admins", "name companyEmail avatar photographUrl")
      .lean();

    if (!space) {
      return res.status(404).json({
        success: false,
        error: "Space not found",
      });
    }

    // Check if user is a member
    const isMember = space.members?.some(
      (m) => m.toString() === req.employee._id.toString()
    );

    if (!isMember) {
      return res.status(403).json({
        success: false,
        error: "Access denied. You are not a member of this space.",
      });
    }

    // Get conversation for group name and description
    const conversation = await Conversation.findOne({
      space: spaceId,
      isGroup: true,
    }).select("groupName groupDescription groupAvatar");

    // Format response
    const spaceDetails = {
      _id: space._id,
      name: space.name,
      description: space.description || "",
      avatar: space.avatar,
      groupName: conversation?.groupName || space.name,
      groupDescription:
        conversation?.groupDescription || space.description || "",
      groupAvatar: conversation?.groupAvatar || space.avatar,
      createdBy: space.createdBy,
      admins: space.admins,
      totalMembers: space.members?.length || 0,
      isPrivate: space.isPrivate || false,
      settings: space.settings || {},
      createdAt: space.createdAt,
      updatedAt: space.updatedAt,
    };

    res.json({
      success: true,
      space: spaceDetails,
    });
  } catch (error) {
    console.error("Get space details error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch space details",
      details: error.message,
    });
  }
};

// ✅ UPDATE SPACE DETAILS
exports.updateSpaceDetails = async (req, res) => {
  try {
    const { spaceId } = req.params;
    const { groupName, groupDescription, groupAvatar } = req.body;

    if (!mongoose.Types.ObjectId.isValid(spaceId)) {
      return res.status(400).json({
        success: false,
        error: "Invalid space ID",
      });
    }

    // Check if user has permission to update (admin or owner)
    const space = await Space.findOne({
      _id: spaceId,
      $or: [{ createdBy: req.employee._id }, { admins: req.employee._id }],
    });

    if (!space) {
      return res.status(404).json({
        success: false,
        error: "Space not found or insufficient permissions",
      });
    }

    // Find and update the conversation
    const conversation = await Conversation.findOneAndUpdate(
      {
        space: spaceId,
        isGroup: true,
      },
      {
        $set: {
          groupName: groupName?.trim(),
          groupDescription: groupDescription?.trim(),
          groupAvatar: groupAvatar?.trim(),
          updatedAt: new Date(),
        },
      },
      {
        new: true,
        runValidators: true,
      }
    );

    if (!conversation) {
      return res.status(404).json({
        success: false,
        error: "Conversation not found for this space",
      });
    }

    // Also update the space name and description if they're different
    if (groupName && groupName !== space.name) {
      space.name = groupName.trim();
      await space.save();
    }

    if (groupDescription && groupDescription !== space.description) {
      space.description = groupDescription.trim();
      await space.save();
    }

    // Populate the updated conversation
    const updatedConversation = await Conversation.findById(conversation._id)
      .populate("participants", "name companyEmail avatar")
      .populate("admins", "name companyEmail avatar");

    // ✅ EMIT SOCKET EVENT FOR SPACE UPDATE
    const io = req.app.get("io");
    if (io) {
      io.to(`space_${spaceId}`).emit("space_updated", {
        spaceId,
        updatedFields: {
          groupName: updatedConversation.groupName,
          groupDescription: updatedConversation.groupDescription,
          groupAvatar: updatedConversation.groupAvatar,
        },
        updatedBy: {
          _id: req.employee._id,
          name: req.employee.name,
        },
        updatedAt: new Date(),
      });

      console.log(`✅ Space details updated for space: ${spaceId}`);
    }

    res.json({
      success: true,
      message: "Space details updated successfully",
      space: {
        _id: space._id,
        name: space.name,
        description: space.description,
        groupName: updatedConversation.groupName,
        groupDescription: updatedConversation.groupDescription,
        groupAvatar: updatedConversation.groupAvatar,
      },
    });
  } catch (error) {
    console.error("Update space details error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to update space details",
      details: error.message,
    });
  }
};
exports.leaveSpace = async (req, res) => {
  try {
    const { spaceId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(spaceId)) {
      return res.status(400).json({
        success: false,
        error: "Invalid space ID",
      });
    }

    // Find the space
    const space = await Space.findById(spaceId)
      .populate("createdBy", "name companyEmail avatar")
      .populate("admins", "name companyEmail avatar")
      .populate("members", "name companyEmail avatar");

    if (!space) {
      return res.status(404).json({
        success: false,
        error: "Space not found",
      });
    }

    // Check if user is a member of the space
    const isMember = space.members.some(
      (member) => member._id.toString() === req.employee._id.toString()
    );

    if (!isMember) {
      return res.status(400).json({
        success: false,
        error: "You are not a member of this space",
      });
    }

    // Prevent space owner from leaving (they should transfer ownership first or delete the space)
    if (space.createdBy._id.toString() === req.employee._id.toString()) {
      return res.status(400).json({
        success: false,
        error:
          "Space owner cannot leave the space. Please transfer ownership first or delete the space.",
      });
    }

    // Remove user from space members
    space.members = space.members.filter(
      (member) => member._id.toString() !== req.employee._id.toString()
    );

    // Remove user from admins if they were an admin
    space.admins = space.admins.filter(
      (admin) => admin._id.toString() !== req.employee._id.toString()
    );

    await space.save();

    // Remove user from conversation participants
    const conversation = await Conversation.findOne({ space: spaceId });
    if (conversation) {
      conversation.participants = conversation.participants.filter(
        (participant) => participant.toString() !== req.employee._id.toString()
      );

      // If conversation becomes empty, delete it
      if (conversation.participants.length === 0) {
        await Message.deleteMany({ conversation: conversation._id });
        await Conversation.findByIdAndDelete(conversation._id);
      } else {
        await conversation.save();
      }
    }

    // ✅ EMIT SOCKET EVENT FOR USER LEAVING SPACE
    const io = req.app.get("io");
    if (io) {
      // Notify the user who left
      io.to(`employee_${req.employee._id}`).emit("left_space", {
        space: {
          _id: space._id,
          name: space.name,
        },
        leftAt: new Date(),
      });

      // Notify remaining space members
      io.to(`space_${spaceId}`).emit("space_members_updated", {
        spaceId,
        leftMemberId: req.employee._id,
        leftMemberName: req.employee.name,
        updatedBy: {
          _id: req.employee._id,
          name: req.employee.name,
        },
        updatedAt: new Date(),
        action: "member_left",
        remainingMembers: space.members.length,
      });

      console.log(`✅ User ${req.employee._id} left space ${spaceId}`);
    }

    res.json({
      success: true,
      message: "Successfully left the space",
      space: {
        _id: space._id,
        name: space.name,
        remainingMembers: space.members.length,
      },
    });
  } catch (error) {
    console.error("Leave space error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to leave space",
      details: error.message,
    });
  }
};
exports.transferSpaceOwnership = async (req, res) => {
  try {
    const { spaceId } = req.params;
    const { newOwnerId } = req.body;

    if (
      !mongoose.Types.ObjectId.isValid(spaceId) ||
      !mongoose.Types.ObjectId.isValid(newOwnerId)
    ) {
      return res.status(400).json({
        success: false,
        error: "Invalid space ID or new owner ID",
      });
    }

    // Find the space
    const space = await Space.findById(spaceId)
      .populate("createdBy", "name companyEmail avatar")
      .populate("admins", "name companyEmail avatar")
      .populate("members", "name companyEmail avatar");

    if (!space) {
      return res.status(404).json({
        success: false,
        error: "Space not found",
      });
    }

    // Check if current user is the space owner
    if (space.createdBy._id.toString() !== req.employee._id.toString()) {
      return res.status(403).json({
        success: false,
        error: "Only space owner can transfer ownership",
      });
    }

    // Check if new owner is a member of the space
    const newOwnerIsMember = space.members.some(
      (member) => member._id.toString() === newOwnerId
    );

    if (!newOwnerIsMember) {
      return res.status(400).json({
        success: false,
        error: "New owner must be a member of the space",
      });
    }

    // Prevent transferring to self
    if (newOwnerId === req.employee._id.toString()) {
      return res.status(400).json({
        success: false,
        error: "Cannot transfer ownership to yourself",
      });
    }

    // Transfer ownership
    const previousOwnerId = space.createdBy._id.toString();
    space.createdBy = newOwnerId;

    // Ensure new owner is an admin
    if (!space.admins.some((admin) => admin._id.toString() === newOwnerId)) {
      space.admins.push(newOwnerId);
    }

    await space.save();

    // Update conversation admins if exists
    const conversation = await Conversation.findOne({ space: spaceId });
    if (conversation) {
      if (!conversation.admins.includes(newOwnerId)) {
        conversation.admins.push(newOwnerId);
        await conversation.save();
      }
    }

    // ✅ EMIT SOCKET EVENT FOR OWNERSHIP TRANSFER
    const io = req.app.get("io");
    if (io) {
      io.to(`space_${spaceId}`).emit("space_ownership_transferred", {
        spaceId,
        previousOwnerId,
        newOwnerId,
        transferredBy: {
          _id: req.employee._id,
          name: req.employee.name,
        },
        transferredAt: new Date(),
      });

      console.log(
        `✅ Space ${spaceId} ownership transferred from ${previousOwnerId} to ${newOwnerId}`
      );
    }

    res.json({
      success: true,
      message: "Space ownership transferred successfully",
      space: {
        _id: space._id,
        name: space.name,
        createdBy: newOwnerId,
        admins: space.admins,
      },
    });
  } catch (error) {
    console.error("Transfer space ownership error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to transfer space ownership",
      details: error.message,
    });
  }
};
// ✅ SEARCH EMPLOYEES FOR ADDING TO SPACE
exports.searchEmployees = async (req, res) => {
  try {
    const { query } = req.query;
    const { spaceId } = req.params;

    if (!query || query.length < 2) {
      return res.json({
        success: true,
        employees: [],
      });
    }

    // Find space to get current members
    const space = await Space.findById(spaceId).select("members");
    const currentMemberIds = space
      ? space.members.map((m) => m.toString())
      : [];

    // Search employees (excluding current members)
    const employees = await Employee.find({
      $and: [
        {
          $or: [
            { name: { $regex: query, $options: "i" } },
            { companyEmail: { $regex: query, $options: "i" } },
          ],
        },
        { _id: { $ne: req.employee._id } }, // Exclude current user
        { _id: { $nin: currentMemberIds } }, // Exclude current members
      ],
    })
      .select("name companyEmail avatar photographUrl department position")
      .limit(20);

    const formattedEmployees = employees.map((emp) => ({
      id: emp._id,
      _id: emp._id,
      name: emp.name,
      email: emp.companyEmail,
      avatarUrl: emp.photographUrl || emp.avatar,
      department: emp.department,
      position: emp.position,
    }));

    res.json({
      success: true,
      employees: formattedEmployees,
    });
  } catch (error) {
    console.error("Search employees error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to search employees",
      details: error.message,
    });
  }
};

exports.getSpaceMessages = async (req, res) => {
  try {
    const { spaceId } = req.params;
    const { page = 1, limit = 50 } = req.query;

    const space = await Space.findOne({
      _id: spaceId,
      members: req.employee._id,
    }).populate("members", "name companyEmail avatar");

    if (!space) {
      return res
        .status(404)
        .json({ success: false, error: "Space not found or access denied" });
    }

    // Find conversation for this space
    const conversation = await Conversation.findOne({ space: spaceId });

    if (!conversation) {
      return res.json({
        success: true,
        messages: [],
        hasMore: false,
        space: {
          _id: space._id,
          name: space.name,
          description: space.description,
          avatar: space.avatar,
          members: space.members,
          admins: space.admins,
          settings: space.settings,
        },
      });
    }

    const messages = await Message.find({
      conversation: conversation._id,
    })
      .populate("sender", "name companyEmail avatar")
      .populate("receivers", "name companyEmail avatar")
      .populate("readBy.employee", "name companyEmail avatar")
      .populate("space")
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    // Mark messages as read for current user
    const unreadMessages = messages.filter(
      (msg) =>
        !msg.readBy.some(
          (read) => read.employee._id.toString() === req.employee._id.toString()
        )
    );

    if (unreadMessages.length > 0) {
      await Message.updateMany(
        {
          _id: { $in: unreadMessages.map((m) => m._id) },
          conversation: conversation._id,
        },
        {
          $addToSet: {
            readBy: {
              employee: req.employee._id,
              readAt: new Date(),
            },
          },
        }
      );

      // Update conversation unread count
      if (conversation.unreadCount) {
        conversation.unreadCount.set(req.employee._id.toString(), 0);
        await conversation.save();
      }

      // ✅ UPDATED: Use socket event for space read receipts
      const io = req.app.get("io");
      if (io) {
        io.to(`space_${spaceId}`).emit("messages_read", {
          conversationId: conversation._id,
          userId: req.employee._id,
          messageIds: unreadMessages.map((m) => m._id),
          readAt: new Date(),
        });
      }
    }

    res.json({
      success: true,
      messages: messages.reverse(),
      hasMore: messages.length === limit,
      space: {
        _id: space._id,
        name: space.name,
        description: space.description,
        avatar: space.avatar,
        members: space.members,
        admins: space.admins,
        settings: space.settings,
      },
    });
  } catch (error) {
    console.error("Get space messages error:", error);
    res.status(500).json({ success: false, error: "Failed to fetch messages" });
  }
};

// Typing indicators - UPDATED
exports.typing = async (req, res) => {
  try {
    const { conversationId, isTyping, isSpace = false } = req.body;

    if (!conversationId) {
      return res
        .status(400)
        .json({ success: false, error: "Conversation ID is required" });
    }

    // ✅ UPDATED: Use socket events that match your socket.io setup
    const io = req.app.get("io");
    if (io) {
      const room = isSpace
        ? `space_${conversationId}`
        : `conversation_${conversationId}`;

      if (isTyping) {
        io.to(room).emit("user_typing", {
          conversationId,
          user: {
            _id: req.employee._id,
            name: req.employee.name,
            avatar: req.employee.avatar,
          },
          isSpace,
        });
      } else {
        io.to(room).emit("user_stopped_typing", {
          conversationId,
          user: {
            _id: req.employee._id,
            name: req.employee.name,
            avatar: req.employee.avatar,
          },
          isSpace,
        });
      }

      console.log(`✅ Typing indicator sent to ${room}`);
    }

    res.json({
      success: true,
      message: isTyping ? "Typing indicator sent" : "Typing stopped",
    });
  } catch (error) {
    console.error("Typing indicator error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to send typing indicator",
      details: error.message,
    });
  }
};

// Delete message - UPDATED
exports.deleteMessage = async (req, res) => {
  try {
    const { messageId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(messageId)) {
      return res
        .status(400)
        .json({ success: false, error: "Invalid message ID" });
    }

    const message = await Message.findOne({
      _id: messageId,
      sender: req.employee._id,
    }).populate("conversation space");

    if (!message) {
      return res.status(404).json({
        success: false,
        error: "Message not found or insufficient permissions",
      });
    }

    const { conversation, space } = message;

    // Delete the message
    await Message.findByIdAndDelete(messageId);

    // Update conversation's last message if this was the last message
    if (conversation && conversation.lastMessage?.toString() === messageId) {
      const previousMessage = await Message.findOne({
        conversation: conversation._id,
      })
        .sort({ createdAt: -1 })
        .select("_id");

      conversation.lastMessage = previousMessage ? previousMessage._id : null;
      await conversation.save();
    }

    // ✅ UPDATED: Use socket events for message deletion
    const io = req.app.get("io");
    if (io) {
      if (space) {
        io.to(`space_${space._id}`).emit("message_deleted", {
          messageId,
          deletedBy: req.employee._id,
          deletedAt: new Date(),
          spaceId: space._id,
        });
      } else {
        io.to(`conversation_${conversation._id}`).emit("message_deleted", {
          messageId,
          deletedBy: req.employee._id,
          deletedAt: new Date(),
          conversationId: conversation._id,
        });
      }
    }

    res.json({
      success: true,
      message: "Message deleted successfully",
      deletedMessageId: messageId,
    });
  } catch (error) {
    console.error("Delete message error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to delete message",
      details: error.message,
    });
  }
};

exports.serveFile = async (req, res) => {
  try {
    const { filename } = req.params;

    // ✅ CORRECTED: Use the chat-attachments subdirectory
    const filePath = path.join(
      __dirname,
      "../uploads/chat-attachments",
      filename
    );

    console.log("📁 Looking for file at:", filePath); // Debug log

    // Check if file exists
    if (!fs.existsSync(filePath)) {
      console.error("❌ File not found:", filePath);
      return res.status(404).json({
        success: false,
        error: "File not found",
        requestedFile: filename,
        actualPath: filePath,
      });
    }

    // ✅ Get file stats for proper headers
    const stat = fs.statSync(filePath);

    // ✅ Set appropriate Content-Type
    const ext = path.extname(filename).toLowerCase();
    const mimeTypes = {
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".png": "image/png",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".svg": "image/svg+xml",
      ".pdf": "application/pdf",
      ".doc": "application/msword",
      ".docx":
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ".xls": "application/vnd.ms-excel",
      ".xlsx":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ".csv": "text/csv",
      ".txt": "text/plain",
    };

    const contentType = mimeTypes[ext] || "application/octet-stream";
    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Length", stat.size);

    // For images, allow them to be displayed inline
    if (ext.match(/\.(jpg|jpeg|png|gif|webp|svg)$/i)) {
      res.setHeader("Content-Disposition", "inline");
    } else {
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${filename}"`
      );
    }

    // Create read stream and pipe to response
    const fileStream = fs.createReadStream(filePath);
    fileStream.pipe(res);

    // Handle stream errors
    fileStream.on("error", (error) => {
      console.error("File stream error:", error);
      if (!res.headersSent) {
        res.status(500).json({
          success: false,
          error: "Error reading file",
        });
      }
    });
  } catch (error) {
    console.error("Serve file error:", error);
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        error: "Failed to serve file",
        details: error.message,
      });
    }
  }
};
// Add this to your existing chat controller
exports.getSharedContent = async (req, res) => {
  try {
    const { conversationId } = req.params;
    const { type } = req.query; // Optional: 'files', 'links', 'media', or 'all'

    console.log("🔍 Fetching shared content for:", conversationId);

    if (!mongoose.Types.ObjectId.isValid(conversationId)) {
      return res.status(400).json({
        success: false,
        error: "Invalid conversation ID",
      });
    }

    // Check if user has access to this conversation
    const conversation = await Conversation.findOne({
      _id: conversationId,
      participants: req.employee._id,
    });

    if (!conversation) {
      return res.status(404).json({
        success: false,
        error: "Conversation not found or access denied",
      });
    }

    // Build query based on content type
    let messageQuery = {
      conversation: conversationId,
      $or: [],
    };

    // Files query (non-image documents)
    const filesQuery = {
      $and: [
        { "attachments.0": { $exists: true } },
        {
          $or: [
            {
              "attachments.mimetype": {
                $regex: /^application\/(pdf|msword|vnd\.|json|xml)/,
              },
            },
            { "attachments.mimetype": { $regex: /^text\// } },
            {
              "attachments.originalName": {
                $regex: /\.(pdf|doc|docx|xls|xlsx|csv|txt|json|xml)$/i,
              },
            },
          ],
        },
      ],
    };

    // Links query (messages with URLs)
    const linksQuery = {
      content: { $regex: /https?:\/\/[^\s]+/ },
      messageType: { $ne: "gif" }, // Exclude GIF URLs
    };

    // Media query (images, videos, GIFs)
    const mediaQuery = {
      $or: [
        {
          "attachments.mimetype": {
            $regex: /^(image\/|video\/)/,
          },
        },
        { messageType: "gif" },
        {
          "attachments.originalName": {
            $regex: /\.(jpg|jpeg|png|gif|webp|svg|mp4|avi|mov|mkv)$/i,
          },
        },
      ],
    };

    // Add queries based on requested type
    switch (type) {
      case "files":
        messageQuery.$or.push(filesQuery);
        break;
      case "links":
        messageQuery.$or.push(linksQuery);
        break;
      case "media":
        messageQuery.$or.push(mediaQuery);
        break;
      default: // 'all'
        messageQuery.$or.push(filesQuery, linksQuery, mediaQuery);
    }

    // Fetch messages with shared content
    const messages = await Message.find(messageQuery)
      .populate("sender", "name companyEmail avatar")
      .populate("attachments")
      .sort({ createdAt: -1 })
      .limit(200); // Limit to prevent overload

    console.log(`📦 Found ${messages.length} messages with shared content`);

    // Process and categorize shared content
    const sharedContent = {
      files: [],
      links: [],
      media: [],
    };

    const processedUrls = new Set(); // To avoid duplicates

    messages.forEach((message) => {
      const {
        sender,
        content,
        messageType,
        attachments = [],
        createdAt,
        _id,
      } = message;

      // Extract links from text content
      if (content && messageType !== "gif") {
        const urlRegex = /(https?:\/\/[^\s]+)/g;
        const urls = content.match(urlRegex);

        if (urls) {
          urls.forEach((url, index) => {
            // Skip if URL is already processed or is a file attachment
            if (processedUrls.has(url)) return;

            const isAttachmentUrl = attachments.some(
              (att) => att.url === url || content.includes(att.url)
            );

            if (!isAttachmentUrl) {
              processedUrls.add(url);

              try {
                const urlObj = new URL(url);
                const domain = urlObj.hostname.replace("www.", "");

                sharedContent.links.push({
                  id: `link-${_id}-${index}`,
                  title: domain.charAt(0).toUpperCase() + domain.slice(1),
                  url: url,
                  sharedBy: sender?.name || "Unknown",
                  sharedByAvatar: sender?.name?.charAt(0).toUpperCase() || "U",
                  dateShared: formatSharedDate(createdAt),
                  messageId: _id,
                });
              } catch (error) {
                console.log("Invalid URL:", url);
              }
            }
          });
        }
      }

      // Process attachments
      if (attachments && attachments.length > 0) {
        attachments.forEach((attachment, index) => {
          const { filename, url, mimetype, size, originalName } = attachment;

          // Skip if this URL was already processed as a link
          if (processedUrls.has(url)) return;
          processedUrls.add(url);

          const attachmentData = {
            id: `attachment-${_id}-${index}`,
            name: filename || originalName || "Unnamed file",
            url: url,
            sharedBy: sender?.name || "Unknown",
            sharedByAvatar: sender?.name?.charAt(0).toUpperCase() || "U",
            dateShared: formatSharedDate(createdAt),
            messageId: _id,
            size: size || 0,
          };

          // Categorize by file type
          if (mimetype.startsWith("image/") || mimetype === "image/gif") {
            sharedContent.media.push({
              ...attachmentData,
              type: "image",
              thumbnail: url,
            });
          } else if (mimetype.startsWith("video/")) {
            sharedContent.media.push({
              ...attachmentData,
              type: "video",
              thumbnail: null,
            });
          } else if (messageType === "gif") {
            sharedContent.media.push({
              ...attachmentData,
              type: "image",
              thumbnail: url,
              name: "GIF",
            });
          } else {
            // It's a file
            const fileExtension =
              (filename || originalName || "")
                .split(".")
                .pop()
                ?.toLowerCase() || "file";

            sharedContent.files.push({
              ...attachmentData,
              type: fileExtension,
            });
          }
        });
      }

      // Handle GIF messages (content is GIF URL)
      if (messageType === "gif" && content && !processedUrls.has(content)) {
        processedUrls.add(content);
        sharedContent.media.push({
          id: `gif-${_id}`,
          type: "image",
          name: "GIF",
          url: content,
          thumbnail: content,
          sharedBy: sender?.name || "Unknown",
          sharedByAvatar: sender?.name?.charAt(0).toUpperCase() || "U",
          dateShared: formatSharedDate(createdAt),
          messageId: _id,
          size: 0,
        });
      }
    });

    // Sort by date (newest first)
    sharedContent.files.sort(
      (a, b) => new Date(b.dateShared) - new Date(a.dateShared)
    );
    sharedContent.links.sort(
      (a, b) => new Date(b.dateShared) - new Date(a.dateShared)
    );
    sharedContent.media.sort(
      (a, b) => new Date(b.dateShared) - new Date(a.dateShared)
    );

    console.log(`📊 Shared content summary:`, {
      files: sharedContent.files.length,
      links: sharedContent.links.length,
      media: sharedContent.media.length,
    });

    res.json({
      success: true,
      data: sharedContent,
      summary: {
        totalFiles: sharedContent.files.length,
        totalLinks: sharedContent.links.length,
        totalMedia: sharedContent.media.length,
      },
    });
  } catch (error) {
    console.error("Get shared content error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch shared content",
      details: error.message,
    });
  }
};

// Helper function to format date
function formatSharedDate(dateString) {
  const date = new Date(dateString);
  return date.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
// ✅ DELETE CONVERSATION (DM or Group)
exports.deleteConversation = async (req, res) => {
  try {
    const { conversationId } = req.params;
    const { permanent = false } = req.query; // optional flag ?permanent=true

    if (!mongoose.Types.ObjectId.isValid(conversationId)) {
      return res.status(400).json({
        success: false,
        error: "Invalid conversation ID",
      });
    }

    // Find conversation and verify user participation
    const conversation = await Conversation.findOne({
      _id: conversationId,
      participants: req.employee._id,
    }).populate("participants", "name companyEmail avatar");

    if (!conversation) {
      return res.status(404).json({
        success: false,
        error: "Conversation not found or access denied",
      });
    }

    // ✅ Option 1: Permanent delete (for everyone)
    if (permanent === "true" || conversation.isGroup === false) {
      // Delete all messages
      await Message.deleteMany({ conversation: conversationId });

      // Delete the conversation itself
      await Conversation.findByIdAndDelete(conversationId);

      // Emit socket event
      const io = req.app.get("io");
      if (io) {
        conversation.participants.forEach((participant) => {
          io.to(`user_${participant._id}`).emit("conversation_deleted", {
            conversationId,
            deletedBy: req.employee._id,
            permanent: true,
            deletedAt: new Date(),
          });
        });
      }

      return res.json({
        success: true,
        message: "Conversation permanently deleted",
        conversationId,
      });
    }

    // ✅ Option 2: Soft delete for current user only (hide chat)
    conversation.hiddenBy = conversation.hiddenBy || [];
    if (!conversation.hiddenBy.includes(req.employee._id)) {
      conversation.hiddenBy.push(req.employee._id);
      await conversation.save();
    }

    // Emit socket event for UI update
    const io = req.app.get("io");
    if (io) {
      io.to(`user_${req.employee._id}`).emit("conversation_deleted", {
        conversationId,
        deletedBy: req.employee._id,
        permanent: false,
        deletedAt: new Date(),
      });
    }

    res.json({
      success: true,
      message: "Conversation hidden for this user",
      conversationId,
    });
  } catch (error) {
    console.error("Delete conversation error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to delete conversation",
      details: error.message,
    });
  }
};
// ✅ DELETE SPACE (and related conversation + messages)
exports.deleteSpace = async (req, res) => {
  try {
    const { spaceId } = req.params;
    const { permanent = false } = req.query; // optional flag ?permanent=true

    // Validate space ID
    if (!mongoose.Types.ObjectId.isValid(spaceId)) {
      return res
        .status(400)
        .json({ success: false, error: "Invalid space ID" });
    }

    // Find space and verify permissions
    const space = await Space.findById(spaceId)
      .populate("members", "name companyEmail avatar")
      .populate("admins", "name companyEmail avatar");

    if (!space) {
      return res.status(404).json({ success: false, error: "Space not found" });
    }

    // Ensure requester is admin or creator
    if (
      space.createdBy.toString() !== req.employee._id.toString() &&
      !space.admins.some(
        (admin) => admin._id.toString() === req.employee._id.toString()
      )
    ) {
      return res.status(403).json({
        success: false,
        error: "Only the creator or admins can delete this space",
      });
    }

    // Find linked conversation
    const conversation = await Conversation.findOne({ space: spaceId });

    // ✅ Option 1: Permanent delete (everything)
    if (permanent === "true") {
      // Delete all messages and conversation
      if (conversation) {
        await Message.deleteMany({ conversation: conversation._id });
        await Conversation.findByIdAndDelete(conversation._id);
      }

      // Delete the space itself
      await Space.findByIdAndDelete(spaceId);

      // Emit socket event for all members
      const io = req.app.get("io");
      if (io) {
        space.members.forEach((member) => {
          io.to(`employee_${member._id}`).emit("space_deleted", {
            spaceId,
            deletedBy: req.employee._id,
            permanent: true,
            deletedAt: new Date(),
          });
        });
      }

      return res.json({
        success: true,
        message: "Space and related data permanently deleted",
        spaceId,
      });
    }

    // ✅ Option 2: Soft delete (hide for current user)
    space.hiddenBy = space.hiddenBy || [];
    if (!space.hiddenBy.includes(req.employee._id)) {
      space.hiddenBy.push(req.employee._id);
      await space.save();
    }

    const io = req.app.get("io");
    if (io) {
      io.to(`employee_${req.employee._id}`).emit("space_deleted", {
        spaceId,
        deletedBy: req.employee._id,
        permanent: false,
        deletedAt: new Date(),
      });
    }

    res.json({
      success: true,
      message: "Space hidden for this user",
      spaceId,
    });
  } catch (error) {
    console.error("Delete space error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to delete space",
      details: error.message,
    });
  }
};
