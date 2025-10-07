const { Conversation, Message, Space } = require("../models/Chat");
const mongoose = require("mongoose");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadDir = 'uploads/';
    // Create uploads directory if it doesn't exist
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    // Generate unique filename with timestamp
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

// File filter for allowed types
const fileFilter = (req, file, cb) => {
  const allowedMimes = [
    'image/jpeg',
    'image/jpg', 
    'image/png',
    'image/gif',
    'image/webp',
    'image/svg+xml',
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/csv',
    'text/plain'
  ];

  if (allowedMimes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error(`Invalid file type: ${file.mimetype}. Allowed types: images, PDF, Word, Excel, CSV, text files.`), false);
  }
};

const upload = multer({
  storage: storage,
  fileFilter: fileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
  }
});

// Upload file endpoint
exports.uploadFile = async (req, res) => {
  try {
    // Use multer middleware to handle file upload
    upload.single('file')(req, res, async function (err) {
      if (err) {
        return res.status(400).json({
          success: false,
          error: err.message
        });
      }

      if (!req.file) {
        return res.status(400).json({
          success: false,
          error: "No file uploaded"
        });
      }

      // Create file object for response
      const fileData = {
        filename: req.file.filename,
        originalName: req.file.originalname,
        mimetype: req.file.mimetype,
        size: req.file.size,
        url: `/uploads/${req.file.filename}`,
        uploadedAt: new Date()
      };

      res.json({
        success: true,
        message: "File uploaded successfully",
        file: fileData
      });
    });
  } catch (error) {
    console.error("Upload file error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to upload file"
    });
  }
};

// Upload multiple files endpoint
exports.uploadFiles = async (req, res) => {
  try {
    upload.array('files', 10)(req, res, async function (err) {
      if (err) {
        return res.status(400).json({
          success: false,
          error: err.message
        });
      }

      if (!req.files || req.files.length === 0) {
        return res.status(400).json({
          success: false,
          error: "No files uploaded"
        });
      }

      const uploadedFiles = req.files.map(file => ({
        filename: file.filename,
        originalName: file.originalname,
        mimetype: file.mimetype,
        size: file.size,
        url: `/uploads/${file.filename}`,
        uploadedAt: new Date()
      }));

      res.json({
        success: true,
        message: `${uploadedFiles.length} files uploaded successfully`,
        files: uploadedFiles
      });
    });
  } catch (error) {
    console.error("Upload files error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to upload files"
    });
  }
};

exports.getConversations = async (req, res) => {
  try {
    // Get direct conversations
    const conversations = await Conversation.find({
      participants: req.employee._id,
      isGroup: false,
    })
      .populate("participants", "name companyEmail avatar")
      .populate("lastMessage")
      .sort({ updatedAt: -1 });

    // Get group conversations
    const groupConversations = await Conversation.find({
      participants: req.employee._id,
      isGroup: true,
    })
      .populate("participants", "name companyEmail avatar")
      .populate("lastMessage")
      .populate("admins", "name companyEmail avatar")
      .sort({ updatedAt: -1 });

    // Get spaces
    const spaces = await Space.find({
      members: req.employee._id,
    })
      .populate("createdBy", "name companyEmail avatar")
      .populate("admins", "name companyEmail avatar")
      .populate("members", "name companyEmail avatar")
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
    const { content, messageType = "text", attachments = [] } = req.body;

    // ✅ UPDATED: Allow empty content if there are attachments
    if (!content?.trim() && (!attachments || attachments.length === 0)) {
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

    // Process attachments - convert file paths to full URLs if needed
    const processedAttachments = attachments.map(attachment => ({
      filename: attachment.filename || attachment.originalName,
      url: attachment.url.startsWith('http') ? attachment.url : `${req.protocol}://${req.get('host')}${attachment.url}`,
      mimetype: attachment.mimetype,
      size: attachment.size,
      originalName: attachment.originalName
    }));

    // Prepare message data
    const messageData = {
      conversation: conversationId,
      sender: req.employee._id,
      content: content?.trim() || '', // ✅ Allow empty content
      messageType: attachments.length > 0 ? 'file' : messageType,
      attachments: processedAttachments,
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
    const {
      participantId,
      content,
      messageType = "text",
      attachments = [],
    } = req.body;

    if (!participantId) {
      return res.status(400).json({
        success: false,
        error: "Participant ID is required",
      });
    }

    if (!content && (!attachments || attachments.length === 0)) {
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

    // Process attachments
    const processedAttachments = attachments.map(attachment => ({
      filename: attachment.filename || attachment.originalName,
      url: attachment.url.startsWith('http') ? attachment.url : `${req.protocol}://${req.get('host')}${attachment.url}`,
      mimetype: attachment.mimetype,
      size: attachment.size,
      originalName: attachment.originalName
    }));

    // Create message
    const receiver = conversation.participants.find(
      (p) => p.toString() !== req.employee._id.toString()
    );

    const message = new Message({
      conversation: conversation._id,
      sender: req.employee._id,
      receiver: receiver,
      content: content?.trim(),
      messageType: attachments.length > 0 ? 'file' : messageType,
      attachments: processedAttachments,
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
      (id) => !space.members.includes(mongoose.Types.ObjectId(id))
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
    const { content, messageType = "text", attachments = [] } = req.body;

    if (!content && (!attachments || attachments.length === 0)) {
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

    // Process attachments
    const processedAttachments = attachments.map(attachment => ({
      filename: attachment.filename || attachment.originalName,
      url: attachment.url.startsWith('http') ? attachment.url : `${req.protocol}://${req.get('host')}${attachment.url}`,
      mimetype: attachment.mimetype,
      size: attachment.size,
      originalName: attachment.originalName
    }));

    // Get receivers (all members except sender)
    const receivers = space.members
      .filter((member) => member._id.toString() !== req.employee._id.toString())
      .map((member) => member._id);

    console.log("📨 Space Message Details:", {
      spaceId,
      totalMembers: space.members.length,
      sender: req.employee._id,
      receiversCount: receivers.length,
    });

    // Create message with multiple receivers
    const message = new Message({
      conversation: conversation._id,
      sender: req.employee._id,
      receivers: receivers,
      space: spaceId,
      content: content?.trim(),
      messageType: attachments.length > 0 ? 'file' : messageType,
      attachments: processedAttachments,
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

// Serve uploaded files
exports.serveFile = async (req, res) => {
  try {
    const { filename } = req.params;
    const filePath = path.join(__dirname, '../uploads', filename);
    
    // Check if file exists
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({
        success: false,
        error: "File not found"
      });
    }

    // Set appropriate headers
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    
    // Send file
    res.sendFile(filePath);
  } catch (error) {
    console.error("Serve file error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to serve file"
    });
  }
};