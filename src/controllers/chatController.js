const express = require("express");
const { Conversation, Message, Space } = require("../models/Chat");
const Employee = require("../models/Employees");
const mongoose = require("mongoose");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

const storage = multer.diskStorage({
  destination(req, file, cb) {
    const uploadDir = "uploads/chat-attachments/";
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
    cb(null, uploadDir);
  },
  filename(req, file, cb) {
    // keep original name, add 3 random chars to avoid collisions
    const base = path.parse(file.originalname).name; // name without ext
    const ext = path.extname(file.originalname); // includes the dot
    const uniq = Math.random().toString(36).slice(-3); // short random bit
    cb(null, `${base}-${uniq}${ext}`);
  },
});
// Add this function to your chat controller
const sendMentionNotifications = async (
  mentions,
  message,
  conversation,
  req
) => {
  try {
    const io = req.app.get("io");

    for (const mention of mentions) {
      // Send socket notification to mentioned user
      io.to(`user_${mention.employee}`).emit("user_mentioned", {
        messageId: message._id,
        conversationId: conversation._id,
        mentionedBy: {
          _id: req.employee._id,
          name: req.employee.name,
          avatar: req.employee.avatar,
        },
        messageContent: message.content,
        mentionText: mention.mentionText,
        mentionedAt: new Date(),
        conversationType: conversation.isGroup ? "group" : "direct",
        conversationName: conversation.isGroup
          ? conversation.groupName
          : "Direct Message",
        spaceId: conversation.space,
      });

      // You can also add other notification methods here:
      // - Push notifications
      // - Email notifications
      // - Database notifications

      console.log(`✅ Mention notification sent to user ${mention.employee}`);
    }
  } catch (error) {
    console.error("Error sending mention notifications:", error);
  }
};

const processMentions = async (content, senderId) => {
  if (!content) return [];

  const mentions = [];

  // Handle both formats: @[Name](userId) and simple @username
  const mentionRegex = /(?:@\[([^\]]+)\]\(([^)]+)\)|@(\w+))/g;
  let match;

  while ((match = mentionRegex.exec(content)) !== null) {
    const [, mentionText, userId, simpleMention] = match;

    let finalUserId = userId;
    let finalMentionText = mentionText;

    // If it's a simple @mention (without brackets), we need to find the user
    if (simpleMention && !userId) {
      try {
        // Search for user by name, email, or username
        const user = await Employee.findOne({
          $or: [
            { name: { $regex: simpleMention, $options: "i" } },
            { companyEmail: { $regex: simpleMention, $options: "i" } },
            { username: { $regex: simpleMention, $options: "i" } },
          ],
        }).select("_id name companyEmail");

        if (user && user._id.toString() !== senderId.toString()) {
          finalUserId = user._id;
          finalMentionText = `@${simpleMention}`;
        } else {
          continue; // Skip if user not found or is sender
        }
      } catch (error) {
        console.error("Error finding user for mention:", error);
        continue;
      }
    }

    // Validate user exists and is not the sender
    if (finalUserId && finalUserId !== senderId.toString()) {
      const user = await Employee.findById(finalUserId).select(
        "name companyEmail"
      );
      if (user) {
        mentions.push({
          employee: finalUserId,
          mentionedAt: new Date(),
          mentionText: finalMentionText || `@${user.name}`,
        });
      }
    }
  }

  return mentions;
};
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
    "video/mp4",
    "video/mpeg",
    "video/ogg",
    "video/webm",
    "video/quicktime",
    "video/x-msvideo",
    "video/3gpp",
    "video/3gpp2",
    "audio/wav",
    "audio/mpeg",
    "audio/mp3",
    "audio/ogg",
    "audio/webm",
    "audio/aac",
    "audio/flac",
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
exports.getConversations = async (req, res) => {
  try {
    // Get direct conversations - UPDATED to include pinned status
    const conversations = await Conversation.find({
      participants: req.employee._id,
      isGroup: false,
      space: { $exists: false },
      archivedBy: { $ne: req.employee._id },
    })
      .populate("participants", "name companyEmail avatar photographUrl")
      .populate("lastMessage")
      .populate("pinnedBy.employee", "name companyEmail")
      .sort({ updatedAt: -1 });

    // Get group conversations (spaces) - EXCLUDE HIDDEN CONVERSATIONS
    const groupConversations = await Conversation.find({
      participants: req.employee._id,
      isGroup: true,
      archivedBy: { $ne: req.employee._id },
      hiddenBy: { $ne: req.employee._id },
      space: { $exists: true },
    })
      .populate("participants", "name companyEmail avatar photographUrl")
      .populate("lastMessage")
      .populate("admins", "name companyEmail avatar photographUrl")
      .populate("pinnedBy.employee", "name companyEmail")
      .populate("space", "name description avatar")
      .sort({ updatedAt: -1 });

    // Get spaces for the spaces section
    const spaces = await Space.find({
      members: req.employee._id,
    })
      .populate("createdBy", "name companyEmail avatar photographUrl")
      .populate("admins", "name companyEmail avatar photographUrl")
      .populate("members", "name companyEmail avatar photographUrl")
      .sort({ updatedAt: -1 });

    // Separate pinned and unpinned conversations
    const pinnedConversations = [];
    const unpinnedConversations = [];

    // Process direct messages
    conversations.forEach((conv) => {
      const isPinned = conv.isPinnedBy(req.employee._id);
      const userPin = conv.pinnedBy?.find((pin) => {
        if (!pin.employee) return false;
        const pinEmployeeId = pin.employee._id
          ? pin.employee._id.toString()
          : pin.employee.toString();
        return pinEmployeeId === req.employee._id.toString();
      });

      const conversationData = {
        _id: conv._id,
        participants: conv.participants.filter(
          (p) => p._id.toString() !== req.employee._id.toString()
        ),
        lastMessage: conv.lastMessage,
        unreadCount: conv.unreadCount?.get(req.employee._id.toString()) || 0,
        updatedAt: conv.updatedAt,
        isPinned: isPinned,
        pinnedAt: userPin ? userPin.pinnedAt : null,
        type: "dm",
      };

      if (isPinned) {
        pinnedConversations.push(conversationData);
      } else {
        unpinnedConversations.push(conversationData);
      }
    });

    // Process group conversations (spaces)
    groupConversations.forEach((conv) => {
      const isPinned = conv.isPinnedBy(req.employee._id);
      const userPin = conv.pinnedBy?.find((pin) => {
        if (!pin.employee) return false;
        const pinEmployeeId = pin.employee._id
          ? pin.employee._id.toString()
          : pin.employee.toString();
        return pinEmployeeId === req.employee._id.toString();
      });

      const conversationData = {
        _id: conv._id,
        participants: conv.participants,
        lastMessage: conv.lastMessage,
        unreadCount: conv.unreadCount?.get(req.employee._id.toString()) || 0,
        updatedAt: conv.updatedAt,
        groupName: conv.groupName,
        groupDescription: conv.groupDescription,
        groupAvatar: conv.groupAvatar,
        admins: conv.admins,
        space: conv.space,
        isPinned: isPinned,
        pinnedAt: userPin ? userPin.pinnedAt : null,
        type: "group",
      };

      if (isPinned) {
        pinnedConversations.push(conversationData);
      } else {
        unpinnedConversations.push(conversationData);
      }
    });

    // Sort pinned conversations by pinnedAt (newest first)
    pinnedConversations.sort(
      (a, b) => new Date(b.pinnedAt || 0) - new Date(a.pinnedAt || 0)
    );

    // Sort unpinned conversations by updatedAt (newest first)
    unpinnedConversations.sort(
      (a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)
    );

    // Combine pinned (first) and unpinned (after)
    const allConversations = [...pinnedConversations, ...unpinnedConversations];

    res.json({
      success: true,
      conversations: allConversations,
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
        unreadCount: 0,
        type: "space",
      })),
      pinnedCount: pinnedConversations.length,
    });
  } catch (error) {
    console.error("Get conversations error:", error);
    res
      .status(500)
      .json({ success: false, error: "Failed to fetch conversations" });
  }
};
exports.pinSpace = async (req, res) => {
  try {
    const { spaceId } = req.params;
    const employeeId = req.employee._id;

    if (!mongoose.Types.ObjectId.isValid(spaceId)) {
      return res
        .status(400)
        .json({ success: false, error: "Invalid space ID" });
    }

    const space = await Space.findOne({
      _id: spaceId,
      members: employeeId,
    });

    if (!space) {
      return res.status(403).json({
        success: false,
        error: "Access denied or space not found",
      });
    }

    const pinned = space.addPin(employeeId);
    if (!pinned) {
      return res.status(400).json({
        success: false,
        error: "Space already pinned",
      });
    }

    await space.save();

    // 🔔 socket event
    const io = req.app.get("io");
    io?.to(`space_${spaceId}`).emit("space_pinned", {
      spaceId,
      pinnedBy: employeeId,
      pinnedAt: new Date(),
    });

    res.json({ success: true, space });
  } catch (err) {
    console.error("Pin space error:", err);
    res.status(500).json({
      success: false,
      error: "Failed to pin space",
    });
  }
};

exports.getDirectMessages = async (req, res) => {
  try {
    const conversations = await Conversation.find({
      participants: req.employee._id,
      isGroup: false,
      space: { $exists: false },
      archivedBy: { $ne: req.employee._id },
      hiddenBy: { $ne: req.employee._id },
    })
      .populate("participants", "name companyEmail avatar photographUrl")
      .populate("lastMessage")
      .populate("pinnedBy.employee", "name companyEmail")
      .populate("mutedBy.employee", "name companyEmail") // ✅ ADD: Populate mutedBy
      .sort({ updatedAt: -1 });

    // ✅ FIXED: Proper pinned status handling
    const formattedConversations = conversations.map((conv) => {
      const userPin = conv.pinnedBy.find((pin) => {
        if (!pin.employee) return false;
        const pinEmployeeId = pin.employee._id
          ? pin.employee._id.toString()
          : pin.employee.toString();
        return pinEmployeeId === req.employee._id.toString();
      });
      const isMuted = conv.isMutedBy(req.employee._id);
      const userMute = conv.mutedBy.find((mute) => {
        if (!mute.employee) return false;
        const muteEmployeeId = mute.employee._id
          ? mute.employee._id.toString()
          : mute.employee.toString();
        return muteEmployeeId === req.employee._id.toString();
      });

      return {
        _id: conv._id,
        participants: conv.participants.filter(
          (p) => p._id.toString() !== req.employee._id.toString()
        ),
        lastMessage: conv.lastMessage,
        unreadCount: conv.unreadCount?.get(req.employee._id.toString()) || 0,
        updatedAt: conv.updatedAt,
        isPinned: !!userPin, // ✅ Proper boolean conversion
        pinnedAt: userPin ? userPin.pinnedAt : null,
        isMuted: isMuted, // ✅ Add mute status
        muteExpiresAt: userMute ? userMute.muteExpiresAt : null, // ✅ Add mute expiration
        type: "dm",
      };
    });

    // Separate pinned and unpinned
    const pinnedConversations = formattedConversations.filter(
      (conv) => conv.isPinned
    );
    const unpinnedConversations = formattedConversations.filter(
      (conv) => !conv.isPinned
    );

    // Sort pinned by pinnedAt (newest first)
    pinnedConversations.sort(
      (a, b) => new Date(b.pinnedAt || 0) - new Date(a.pinnedAt || 0)
    );

    // Sort unpinned by updatedAt (newest first)
    unpinnedConversations.sort(
      (a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)
    );

    // Combine
    const allConversations = [...pinnedConversations, ...unpinnedConversations];

    res.json({
      success: true,
      conversations: allConversations,
      pinnedCount: pinnedConversations.length,
      totalCount: allConversations.length,
    });
  } catch (error) {
    console.error("Get direct messages error:", error);
    res
      .status(500)
      .json({ success: false, error: "Failed to fetch direct messages" });
  }
};

// ✅ GET SPACE CONVERSATIONS ONLY
exports.getSpaceConversations = async (req, res) => {
  try {
    // Get only space conversations
    const spaceConversations = await Conversation.find({
      participants: req.employee._id,
      isGroup: true,
      space: { $exists: true }, // Only conversations with space reference
      archivedBy: { $ne: req.employee._id },
    })
      .populate("participants", "name companyEmail avatar photographUrl")
      .populate("lastMessage")
      .populate("admins", "name companyEmail avatar photographUrl")
      .populate("pinnedBy.employee", "name companyEmail")
      .populate("space", "name description avatar") // Populate space details
      .sort({ updatedAt: -1 });

    // Separate pinned and unpinned space conversations
    const pinnedConversations = [];
    const unpinnedConversations = [];

    spaceConversations.forEach((conv) => {
      const isPinned = conv.isPinnedBy(req.employee._id);
      const conversationData = {
        _id: conv._id,
        participants: conv.participants,
        lastMessage: conv.lastMessage,
        unreadCount: conv.unreadCount.get(req.employee._id.toString()) || 0,
        updatedAt: conv.updatedAt,
        groupName: conv.groupName,
        groupDescription: conv.groupDescription,
        groupAvatar: conv.groupAvatar,
        admins: conv.admins,
        space: conv.space,
        isPinned: isPinned,
        pinnedAt: isPinned
          ? conv.pinnedBy.find(
              (pin) => pin.employee.toString() === req.employee._id.toString()
            )?.pinnedAt
          : null,
        type: "group",
      };

      if (isPinned) {
        pinnedConversations.push(conversationData);
      } else {
        unpinnedConversations.push(conversationData);
      }
    });

    // Sort pinned conversations by pinnedAt (newest first)
    pinnedConversations.sort(
      (a, b) => new Date(b.pinnedAt) - new Date(a.pinnedAt)
    );

    // Sort unpinned conversations by updatedAt (newest first)
    unpinnedConversations.sort(
      (a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)
    );

    // Combine pinned (first) and unpinned (after)
    const allConversations = [...pinnedConversations, ...unpinnedConversations];

    res.json({
      success: true,
      conversations: allConversations,
      pinnedCount: pinnedConversations.length,
      totalCount: allConversations.length,
    });
  } catch (error) {
    console.error("Get space conversations error:", error);
    res
      .status(500)
      .json({ success: false, error: "Failed to fetch space conversations" });
  }
};

// ✅ GET ALL SPACES (for Spaces section)
exports.getSpaces = async (req, res) => {
  try {
    const spaces = await Space.find({
      members: req.employee._id,
    })
      .populate("createdBy", "name companyEmail avatar photographUrl")
      .populate("admins", "name companyEmail avatar photographUrl")
      .populate("members", "name companyEmail avatar photographUrl")
      .sort({ updatedAt: -1 });

    const spacesWithLastMessage = await Promise.all(
      spaces.map(async (space) => {
        // Find conversation for this space
        const conversation = await Conversation.findOne({
          space: space._id,
          participants: req.employee._id,
        }).populate("lastMessage");

        const unreadCount = conversation
          ? conversation.unreadCount.get(req.employee._id.toString()) || 0
          : 0;

        return {
          _id: space._id,
          name: space.name,
          description: space.description,
          avatar: space.avatar,
          createdBy: space.createdBy,
          admins: space.admins,
          members: space.members,
          isPrivate: space.isPrivate,
          memberCount: space.members.length,
          unreadCount,
          type: "space",

          // ✅ FIX: attach lastMessage
          lastMessage: conversation ? conversation.lastMessage : null,

          // Use conversation's update time, not space’s update time
          updatedAt: conversation ? conversation.updatedAt : space.updatedAt,

          isPinned: space.isPinnedBy(req.employee._id),
          pinnedAt: space.isPinnedBy(req.employee._id)
            ? space.pinnedBy.find(
                (pin) => pin.employee.toString() === req.employee._id.toString()
              )?.pinnedAt
            : null,
        };
      })
    );

    res.json({
      success: true,
      spaces: spacesWithLastMessage,
      totalCount: spacesWithLastMessage.length,
    });
  } catch (error) {
    console.error("Get spaces error:", error);
    res.status(500).json({ success: false, error: "Failed to fetch spaces" });
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
      .populate("replyTo") // ✅ ADD: Populate replyTo reference

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
        // Space/Group message
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
        // Direct message
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

      // ✅ CRITICAL FIX: Emit proper socket events
      const io = req.app.get("io");
      if (io) {
        const isSpace = conversation.isGroup || conversation.space;
        const room = isSpace
          ? `space_${conversation.space || conversationId}`
          : `conversation_${conversationId}`;

        // For each marked message, emit individual update
        unreadMessages.forEach((msg) => {
          io.to(room).emit("message_read_update", {
            messageId: msg._id,
            conversationId: conversationId,
            userId: req.employee._id,
            read: true,
            readAt: new Date(),
            isSpace: isSpace,
            // Include the reader info for space messages
            reader: isSpace
              ? {
                  employee: {
                    _id: req.employee._id,
                    name: req.employee.name,
                    avatar: req.employee.avatar,
                    photographUrl: req.employee.photographUrl,
                  },
                  readAt: new Date(),
                }
              : undefined,
          });
        });

        console.log(
          `✅ Emitted read receipts for ${unreadMessages.length} messages to ${room}`
        );
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
      isGroup: false, // ✅ Ensure we only look for direct messages
      space: { $exists: false }, // ✅ Ensure no space reference
    })
      .populate("participants", "name companyEmail avatar photographUrl")
      .populate("lastMessage");

    if (!conversation) {
      // Create new conversation with unreadCount map - FIXED: isGroup should be false
      conversation = new Conversation({
        participants: [req.employee._id, participantId],
        isGroup: false, // ✅ This should be false for direct messages
        unreadCount: new Map([
          [req.employee._id.toString(), 0],
          [participantId, 0],
        ]),
      });
      await conversation.save();

      // Populate after save
      conversation = await Conversation.findById(conversation._id)
        .populate("participants", "name companyEmail avatar photographUrl")
        .populate("lastMessage");

      // ✅ UPDATED: Use consistent socket events
      const io = req.app.get("io");
      if (io) {
        [req.employee._id.toString(), participantId].forEach((userId) => {
          io.to(`user_${userId}`).emit("conversation_created", {
            conversation: {
              _id: conversation._id,
              participants: conversation.participants,
              isGroup: conversation.isGroup, // ✅ Include isGroup in response
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
        type: "dm", // ✅ Explicitly set type
        isGroup: false, // ✅ Ensure isGroup is false
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
    const { content, messageType = "text", replyTo } = req.body; // ✅ ADD replyTo

    console.log("📨 Send message request:", {
      conversationId,
      content,
      messageType,
      replyTo, // ✅ ADD: Log replyTo
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

    // ✅ VALIDATE REPLYTO MESSAGE
    let repliedMessage = null;
    if (replyTo && mongoose.Types.ObjectId.isValid(replyTo)) {
      repliedMessage = await Message.findOne({
        _id: replyTo,
        conversation: conversationId, // Ensure replied message is in same conversation
      }).populate("sender", "name companyEmail avatar");

      if (!repliedMessage) {
        return res.status(400).json({
          success: false,
          error: "Replied message not found or invalid",
        });
      }
    }

    // Check if this is a group conversation
    const isGroup = conversation.isGroup || conversation.space;

    // ✅ ADDED: BLOCK STATUS CHECK FOR DIRECT MESSAGES
    if (!isGroup) {
      const otherParticipant = conversation.participants.find(
        (p) => p._id.toString() !== req.employee._id.toString()
      );

      if (otherParticipant) {
        // Check if either user has blocked the other
        const blockStatus = await Employee.getBlockStatus(
          req.employee._id,
          otherParticipant._id
        );

        console.log("🔒 Block status check:", {
          sender: req.employee._id,
          receiver: otherParticipant._id,
          blockStatus,
        });

        if (!blockStatus.canCommunicate) {
          let errorMessage = "Cannot send message";

          if (blockStatus.user1BlockedUser2 && blockStatus.user2BlockedUser1) {
            errorMessage = "You have blocked each other. Cannot send messages.";
          } else if (blockStatus.user1BlockedUser2) {
            errorMessage =
              "You have blocked this user. Unblock them to send messages.";
          } else if (blockStatus.user2BlockedUser1) {
            errorMessage =
              "This user has blocked you. You cannot send messages to them.";
          }

          return res.status(403).json({
            success: false,
            error: errorMessage,
            blockDetails: {
              youBlockedThem: blockStatus.user1BlockedUser2,
              theyBlockedYou: blockStatus.user2BlockedUser1,
              mutualBlock: blockStatus.isMutualBlock,
            },
          });
        }
      }
    }

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
    const mentions = await processMentions(content, req.employee._id);

    // Prepare message data
    const messageData = {
      conversation: conversationId,
      sender: req.employee._id,
      content: content?.trim() || "",
      messageType: finalMessageType,
      attachments: uploadedAttachments,
      isGroupMessage: isGroup,
      readBy: [
        {
          employee: req.employee._id,
          readAt: new Date(),
        },
      ],
      // ✅ ADD MENTIONS TO MESSAGE
      mentions: mentions,
      hasMentions: mentions.length > 0,
      // ✅ ADD REPLYTO TO MESSAGE
      replyTo: replyTo || undefined,
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
    if (mentions.length > 0) {
      await sendMentionNotifications(mentions, message, conversation, req);
    }
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

    // Populate and return - ✅ ADD populate for replyTo
    const populatedMessage = await Message.findById(message._id)
      .populate("sender", "name companyEmail avatar")
      .populate("receiver", "name companyEmail avatar")
      .populate("receivers", "name companyEmail avatar")
      .populate("conversation")
      .populate("space")
      .populate({
        path: "replyTo",
        populate: {
          path: "sender",
          select: "name companyEmail avatar",
        },
      });

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

    // ✅ ADDED: BLOCK STATUS CHECK FOR DIRECT MESSAGES
    const blockStatus = await Employee.getBlockStatus(
      req.employee._id,
      participantId
    );

    console.log("🔒 Direct message block status check:", {
      sender: req.employee._id,
      receiver: participantId,
      blockStatus,
    });

    if (!blockStatus.canCommunicate) {
      let errorMessage = "Cannot send message";

      if (blockStatus.user1BlockedUser2 && blockStatus.user2BlockedUser1) {
        errorMessage = "You have blocked each other. Cannot send messages.";
      } else if (blockStatus.user1BlockedUser2) {
        errorMessage =
          "You have blocked this user. Unblock them to send messages.";
      } else if (blockStatus.user2BlockedUser1) {
        errorMessage =
          "This user has blocked you. You cannot send messages to them.";
      }

      return res.status(403).json({
        success: false,
        error: errorMessage,
        blockDetails: {
          youBlockedThem: blockStatus.user1BlockedUser2,
          theyBlockedYou: blockStatus.user2BlockedUser1,
          mutualBlock: blockStatus.isMutualBlock,
        },
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

    const mentions = await processMentions(content, req.employee._id);

    // Create message with mentions
    const message = new Message({
      conversation: conversation._id,
      sender: req.employee._id,
      receiver: receiver,
      content: content?.trim(),
      messageType: finalMessageType,
      attachments: uploadedAttachments,
      read: false,
      mentions: mentions,
      hasMentions: mentions.length > 0,
    });

    await message.save();

    // Update conversation
    conversation.lastMessage = message._id;
    conversation.updatedAt = new Date();

    // Increment unread count for receiver
    const currentCount = conversation.unreadCount.get(receiver.toString()) || 0;
    conversation.unreadCount.set(receiver.toString(), currentCount + 1);

    await conversation.save();
    if (mentions.length > 0) {
      await sendMentionNotifications(mentions, message, conversation, req);
    }
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

// ✅ FIXED: Replace your markAsRead function with this

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

    const isSpace = conversation.isGroup || conversation.space;

    // Get all unread messages
    let unreadMessages;
    if (isSpace) {
      unreadMessages = await Message.find({
        conversation: conversationId,
        "readBy.employee": { $ne: req.employee._id },
      });
    } else {
      const otherParticipant = conversation.participants.find(
        (p) => p.toString() !== req.employee._id.toString()
      );

      unreadMessages = await Message.find({
        conversation: conversationId,
        receiver: req.employee._id,
        sender: otherParticipant,
        read: false,
      });
    }

    // Mark messages as read
    if (isSpace) {
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
        },
        {
          read: true,
          readAt: new Date(),
        }
      );
    }

    // Reset unread count
    conversation.unreadCount.set(req.employee._id.toString(), 0);
    await conversation.save();

    // ✅ EMIT SOCKET EVENTS FOR REAL-TIME UPDATE
    const io = req.app.get("io");
    if (io) {
      const room = isSpace
        ? `space_${conversation.space || conversationId}`
        : `conversation_${conversationId}`;

      // Emit for each marked message
      unreadMessages.forEach((msg) => {
        io.to(room).emit("message_read_update", {
          messageId: msg._id,
          conversationId: conversationId,
          userId: req.employee._id,
          read: true,
          readAt: new Date(),
          isSpace: isSpace,
          reader: isSpace
            ? {
                employee: {
                  _id: req.employee._id,
                  name: req.employee.name,
                  avatar: req.employee.avatar,
                  photographUrl: req.employee.photographUrl,
                },
                readAt: new Date(),
              }
            : undefined,
        });
      });

      console.log(
        `✅ Read receipts sent for ${unreadMessages.length} messages in ${room}`
      );
    }

    res.json({
      success: true,
      message: "Messages marked as read",
      updatedCount: unreadMessages.length,
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

exports.spaceMarkAsUnread = async (req, res) => {
  try {
    const { spaceId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(spaceId)) {
      return res
        .status(400)
        .json({ success: false, error: "Invalid space ID" });
    }

    // First, find the space and verify the user is a member
    const space = await Space.findOne({
      _id: spaceId,
      members: req.employee._id,
    });

    if (!space) {
      return res
        .status(404)
        .json({ success: false, error: "Space not found or access denied" });
    }

    // Find the conversation associated with this space
    const conversation = await Conversation.findOne({
      space: spaceId,
      participants: req.employee._id,
    });

    if (!conversation) {
      return res
        .status(404)
        .json({ success: false, error: "Space conversation not found" });
    }

    // Get the last message in the space conversation
    const lastMessage = await Message.findOne({
      conversation: conversation._id,
    }).sort({ createdAt: -1 });

    if (lastMessage) {
      // For space messages, remove the user from readBy array
      await Message.updateOne(
        { _id: lastMessage._id },
        {
          $pull: {
            readBy: {
              employee: req.employee._id,
            },
          },
        }
      );

      // Set unread count to 1 for this user
      conversation.unreadCount.set(req.employee._id.toString(), 1);
      await conversation.save();

      console.log(
        `✅ Space ${spaceId} marked as unread for user ${req.employee._id}`
      );
    } else {
      // If no messages, still set unread count to indicate unread status
      conversation.unreadCount.set(req.employee._id.toString(), 1);
      await conversation.save();
    }

    // Emit socket event for space
    const io = req.app.get("io");
    if (io) {
      io.to(`space_${spaceId}`).emit("space_marked_unread", {
        spaceId: spaceId,
        userId: req.employee._id,
        unreadCount: 1,
        conversationId: conversation._id,
      });

      // Also emit to user's personal room for UI updates
      io.to(`user_${req.employee._id}`).emit("conversation_marked_unread", {
        conversationId: conversation._id,
        userId: req.employee._id,
        unreadCount: 1,
      });
    }

    res.json({
      success: true,
      message: "Space marked as unread",
      unreadCount: 1,
      spaceId: spaceId,
      conversationId: conversation._id,
    });
  } catch (error) {
    console.error("Space mark as unread error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to mark space as unread",
      details: error.message,
    });
  }
};

// Also create a corresponding mark as read function for spaces
exports.spaceMarkAsRead = async (req, res) => {
  try {
    const { spaceId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(spaceId)) {
      return res
        .status(400)
        .json({ success: false, error: "Invalid space ID" });
    }

    // Find the space and verify membership
    const space = await Space.findOne({
      _id: spaceId,
      members: req.employee._id,
    });

    if (!space) {
      return res
        .status(404)
        .json({ success: false, error: "Space not found or access denied" });
    }

    // Find the conversation associated with this space
    const conversation = await Conversation.findOne({
      space: spaceId,
      participants: req.employee._id,
    });

    if (!conversation) {
      return res
        .status(404)
        .json({ success: false, error: "Space conversation not found" });
    }

    // Mark all unread messages as read for this user
    const unreadMessages = await Message.find({
      conversation: conversation._id,
      "readBy.employee": { $ne: req.employee._id },
    });

    if (unreadMessages.length > 0) {
      // Add user to readBy array for all unread messages
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
    }

    // Reset unread count for this user
    conversation.unreadCount.set(req.employee._id.toString(), 0);
    await conversation.save();

    // Emit socket events
    const io = req.app.get("io");
    if (io) {
      io.to(`space_${spaceId}`).emit("space_marked_read", {
        spaceId: spaceId,
        userId: req.employee._id,
        unreadCount: 0,
        conversationId: conversation._id,
      });

      io.to(`user_${req.employee._id}`).emit("conversation_marked_read", {
        conversationId: conversation._id,
        userId: req.employee._id,
        unreadCount: 0,
      });
    }

    res.json({
      success: true,
      message: "Space marked as read",
      unreadCount: 0,
      spaceId: spaceId,
      conversationId: conversation._id,
      markedReadCount: unreadMessages.length,
    });
  } catch (error) {
    console.error("Space mark as read error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to mark space as read",
      details: error.message,
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
    const { content, messageType = "text", replyTo } = req.body; // ✅ ADD replyTo

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

    // ✅ VALIDATE REPLYTO MESSAGE FOR SPACE
    let repliedMessage = null;
    if (replyTo && mongoose.Types.ObjectId.isValid(replyTo)) {
      repliedMessage = await Message.findOne({
        _id: replyTo,
        conversation: conversation._id, // Ensure replied message is in same space conversation
      }).populate("sender", "name companyEmail avatar");

      if (!repliedMessage) {
        return res.status(400).json({
          success: false,
          error: "Replied message not found or invalid",
        });
      }
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
      messageType: finalMessageType,
      replyTo, // ✅ ADD: Log replyTo
      attachments: uploadedAttachments.length,
    });

    const mentions = await processMentions(content, req.employee._id);

    // Create message with mentions
    const message = new Message({
      conversation: conversation._id,
      sender: req.employee._id,
      receivers: receivers,
      space: spaceId,
      content: content?.trim(),
      messageType: finalMessageType,
      attachments: uploadedAttachments,
      isGroupMessage: true,
      readBy: [
        {
          employee: req.employee._id,
          readAt: new Date(),
        },
      ],
      // ✅ ADD MENTIONS
      mentions: mentions,
      hasMentions: mentions.length > 0,
      // ✅ ADD REPLYTO
      replyTo: replyTo || undefined,
    });

    await message.save();

    // Update conversation
    conversation.lastMessage = message._id;
    conversation.updatedAt = new Date();

    // Initialize unreadCount map if it doesn't exist
    if (!conversation.unreadCount) {
      conversation.unreadCount = new Map();
    }
    if (mentions.length > 0) {
      await sendMentionNotifications(mentions, message, conversation, req);
    }
    // Increment unread count for all receivers
    receivers.forEach((receiverId) => {
      const currentCount =
        conversation.unreadCount.get(receiverId.toString()) || 0;
      conversation.unreadCount.set(receiverId.toString(), currentCount + 1);
    });

    await conversation.save();

    // Populate message for response - ✅ ADD populate for replyTo
    const populatedMessage = await Message.findById(message._id)
      .populate("sender", "name companyEmail avatar")
      .populate("receivers", "name companyEmail avatar")
      .populate("space")
      .populate("conversation")
      .populate({
        path: "replyTo",
        populate: {
          path: "sender",
          select: "name companyEmail avatar",
        },
      });

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

exports.updateSpaceDetails = async (req, res) => {
  try {
    const { spaceId } = req.params; // Make sure this is spaceId, not conversationId
    const { groupName, groupDescription, guidelines } = req.body;

    console.log("🔄 Updating space details for:", {
      spaceId,
      groupName,
      groupDescription,
    });

    if (!mongoose.Types.ObjectId.isValid(spaceId)) {
      return res.status(400).json({
        success: false,
        error: "Invalid space ID",
      });
    }

    // ✅ CRITICAL FIX: Only query Space collection, not Conversation
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

    // ✅ Update only Space document
    const updateData = {
      name: groupName?.trim() || space.name,
      description: groupDescription?.trim() || space.description,
      updatedAt: new Date(),
    };

    // Add guidelines to settings if provided
    if (guidelines !== undefined) {
      updateData.settings = {
        ...space.settings,
        guidelines: guidelines?.trim() || "",
      };
    }

    // ✅ Update only the Space
    const updatedSpace = await Space.findByIdAndUpdate(
      spaceId,
      {
        $set: updateData,
      },
      {
        new: true,
        runValidators: true,
      }
    )
      .populate("createdBy", "name companyEmail avatar")
      .populate("admins", "name companyEmail avatar")
      .populate("members", "name companyEmail avatar");

    if (!updatedSpace) {
      return res.status(404).json({
        success: false,
        error: "Space not found after update",
      });
    }

    // ✅ OPTIONAL: Update related conversation if it exists (but don't create one)
    const conversation = await Conversation.findOne({
      space: spaceId,
      isGroup: true,
    });

    if (conversation) {
      // Only update conversation if it's specifically a space conversation
      await Conversation.findByIdAndUpdate(conversation._id, {
        $set: {
          groupName: updatedSpace.name,
          groupDescription: updatedSpace.description,
          updatedAt: new Date(),
        },
      });
    }

    // ✅ EMIT SOCKET EVENT FOR SPACE UPDATE
    const io = req.app.get("io");
    if (io) {
      io.to(`space_${spaceId}`).emit("space_updated", {
        spaceId,
        updatedFields: {
          name: updatedSpace.name,
          description: updatedSpace.description,
          guidelines: updatedSpace.settings?.guidelines,
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
        _id: updatedSpace._id,
        name: updatedSpace.name,
        description: updatedSpace.description,
        avatar: updatedSpace.avatar,
        groupName: updatedSpace.name, // For compatibility
        groupDescription: updatedSpace.description, // For compatibility
        groupAvatar: updatedSpace.avatar, // For compatibility
        guidelines: updatedSpace.settings?.guidelines,
        createdBy: updatedSpace.createdBy,
        admins: updatedSpace.admins,
        members: updatedSpace.members,
        totalMembers: updatedSpace.members?.length || 0,
        isPrivate: updatedSpace.isPrivate,
        settings: updatedSpace.settings,
        createdAt: updatedSpace.createdAt,
        updatedAt: updatedSpace.updatedAt,
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

// In your chat controller file, make sure this is exported:
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
      .populate("replyTo") // ✅ ADD: Populate replyTo reference
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

// ✅ DELETE SPACE (and related conversation + messages) - ADMIN ONLY
exports.deleteSpace = async (req, res) => {
  try {
    const { spaceId } = req.params;
    const { permanent = false } = req.query;

    console.log(`🔍 Delete space request:`, {
      spaceId,
      permanent,
      user: req.employee._id,
      isAdmin: req.employee.isAdmin,
    });

    // Validate space ID
    if (!mongoose.Types.ObjectId.isValid(spaceId)) {
      return res
        .status(400)
        .json({ success: false, error: "Invalid space ID" });
    }

    // ✅ IMPROVED: Better admin check
    const isSystemAdmin = req.employee?.isAdmin === true;
    console.log(
      `🔍 Admin check - User: ${req.employee._id}, isAdmin: ${isSystemAdmin}`
    );

    // Find space and verify permissions
    const space = await Space.findById(spaceId)
      .populate("members", "name companyEmail avatar")
      .populate("admins", "name companyEmail avatar");

    if (!space) {
      return res.status(404).json({ success: false, error: "Space not found" });
    }

    console.log(
      `🔍 Space found: ${space.name}, Members: ${space.members.length}`
    );

    // Find linked conversation
    const conversation = await Conversation.findOne({ space: spaceId });
    console.log(
      `🔍 Linked conversation: ${conversation ? conversation._id : "None"}`
    );

    // ✅ Option 1: Permanent delete (everything) - ADMIN ONLY
    if (permanent === "true") {
      // ✅ CRITICAL: Enhanced admin check
      if (!isSystemAdmin) {
        console.log(`🚫 Admin permission denied for user: ${req.employee._id}`);
        return res.status(403).json({
          success: false,
          error:
            "Only system administrators can permanently delete spaces and all content",
        });
      }

      console.log(
        `🛑 ADMIN: Permanent deletion of space ${spaceId} by admin ${req.employee._id}`
      );

      // Use transaction for atomic operations
      const session = await mongoose.startSession();
      session.startTransaction();

      try {
        // Store space data for socket emission before deletion
        const spaceData = {
          _id: space._id,
          name: space.name,
          members: space.members.map((m) => m._id),
          totalMessages: 0,
        };

        // Delete all messages in the conversation
        let deletedMessagesCount = 0;
        if (conversation) {
          const deleteResult = await Message.deleteMany({
            conversation: conversation._id,
          });
          deletedMessagesCount = deleteResult.deletedCount;
          spaceData.totalMessages = deletedMessagesCount;

          // Delete the conversation itself
          await Conversation.findByIdAndDelete(conversation._id);
          console.log(
            `✅ Deleted conversation: ${conversation._id} with ${deletedMessagesCount} messages`
          );
        }

        // ✅ FIXED: Delete the space itself with better error handling
        const deleteResult = await Space.findByIdAndDelete(spaceId);
        if (!deleteResult) {
          throw new Error("Failed to delete space - space not found");
        }
        console.log(`✅ Deleted space: ${spaceId}`);

        await session.commitTransaction();
        console.log(`✅ Transaction committed successfully`);

        // Emit socket events
        const io = req.app.get("io");
        if (io) {
          space.members.forEach((member) => {
            io.to(`employee_${member._id}`).emit("space_permanently_deleted", {
              spaceId,
              spaceName: space.name,
              deletedBy: {
                _id: req.employee._id,
                name: req.employee.name,
                isAdmin: true,
              },
              permanent: true,
              deletedAt: new Date(),
              stats: {
                messagesDeleted: deletedMessagesCount,
                membersNotified: space.members.length,
              },
            });
          });

          // Also broadcast to space room
          io.to(`space_${spaceId}`).emit("space_destroyed", {
            spaceId,
            deletedByAdmin: {
              _id: req.employee._id,
              name: req.employee.name,
            },
            deletedAt: new Date(),
          });

          console.log(
            `✅ Notified ${space.members.length} members about space deletion`
          );
        }

        return res.json({
          success: true,
          message: "Space and all related content permanently deleted by admin",
          spaceId,
          deletionStats: {
            spaceDeleted: true,
            conversationDeleted: !!conversation,
            messagesDeleted: deletedMessagesCount,
            membersNotified: space.members.length,
            deletedBy: {
              _id: req.employee._id,
              name: req.employee.name,
              isAdmin: true,
            },
          },
        });
      } catch (transactionError) {
        await session.abortTransaction();
        console.error("❌ Transaction aborted:", transactionError);
        throw transactionError;
      } finally {
        session.endSession();
      }
    }

    // ✅ Option 2: Soft delete (hide for current user) - Available for all users
    // Ensure requester is member of the space
    const isMember = space.members.some(
      (member) => member._id.toString() === req.employee._id.toString()
    );

    if (!isMember) {
      return res.status(403).json({
        success: false,
        error: "You are not a member of this space",
      });
    }

    // Add hiddenBy field if it doesn't exist in your schema
    if (!space.hiddenBy) {
      space.hiddenBy = [];
    }

    if (!space.hiddenBy.includes(req.employee._id)) {
      space.hiddenBy.push(req.employee._id);
      await space.save();
    }

    const io = req.app.get("io");
    if (io) {
      io.to(`employee_${req.employee._id}`).emit("space_hidden", {
        spaceId,
        spaceName: space.name,
        hiddenBy: req.employee._id,
        permanent: false,
        hiddenAt: new Date(),
      });
    }

    res.json({
      success: true,
      message: "Space hidden for this user",
      spaceId,
      action: "hidden",
    });
  } catch (error) {
    console.error("❌ Delete space error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to delete space",
      details: error.message,
    });
  }
};
exports.addReaction = async (req, res) => {
  try {
    const { messageId } = req.params;
    const { emoji } = req.body;

    if (!messageId || !emoji) {
      return res.status(400).json({
        success: false,
        error: "Message ID and emoji are required",
      });
    }

    // Validate message ID
    if (!mongoose.Types.ObjectId.isValid(messageId)) {
      return res.status(400).json({
        success: false,
        error: "Invalid message ID",
      });
    }

    // Find the message
    const message = await Message.findById(messageId);
    if (!message) {
      return res.status(404).json({
        success: false,
        error: "Message not found",
      });
    }

    // Check if user has access to this message
    const conversation = await Conversation.findOne({
      _id: message.conversation,
      participants: req.employee._id,
    });

    if (!conversation) {
      return res.status(403).json({
        success: false,
        error: "Access denied to this message",
      });
    }

    // Find existing reaction for this emoji
    const existingReaction = message.reactions.find(
      (reaction) => reaction.emoji === emoji
    );

    if (existingReaction) {
      // Check if user already reacted with this emoji
      const userAlreadyReacted = existingReaction.users.some(
        (userId) => userId.toString() === req.employee._id.toString()
      );

      if (userAlreadyReacted) {
        // Remove user's reaction
        existingReaction.users = existingReaction.users.filter(
          (userId) => userId.toString() !== req.employee._id.toString()
        );
        existingReaction.count = Math.max(0, existingReaction.count - 1);

        // Remove reaction if no users left
        if (existingReaction.count === 0) {
          message.reactions = message.reactions.filter(
            (reaction) => reaction.emoji !== emoji
          );
        }
      } else {
        // Add user to existing reaction
        existingReaction.users.push(req.employee._id);
        existingReaction.count += 1;
      }
    } else {
      // Create new reaction
      message.reactions.push({
        emoji,
        users: [req.employee._id],
        count: 1,
      });
    }

    await message.save();

    // Populate the updated message
    const updatedMessage = await Message.findById(messageId)
      .populate("sender", "name companyEmail avatar")
      .populate("reactions.users", "name companyEmail avatar")
      .populate("receivers", "name companyEmail avatar")
      .populate("space")
      .populate("conversation");

    // ✅ EMIT SOCKET EVENT FOR REACTION UPDATE
    const io = req.app.get("io");
    if (io) {
      const room = message.space
        ? `space_${message.space}`
        : `conversation_${message.conversation}`;

      io.to(room).emit("message_reaction_updated", {
        messageId,
        reactions: updatedMessage.reactions,
        updatedBy: req.employee._id,
        updatedAt: new Date(),
      });

      console.log(`✅ Reaction updated for message: ${messageId}`);
    }

    res.json({
      success: true,
      message: "Reaction updated successfully",
      reactions: updatedMessage.reactions,
    });
  } catch (error) {
    console.error("Add reaction error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to add reaction",
      details: error.message,
    });
  }
};
// Helper function to remove users from conversations when blocking
async function removeFromConversations(blockerId, blockedId) {
  try {
    // Find all direct conversations between these users
    const conversations = await Conversation.find({
      participants: { $all: [blockerId, blockedId] },
      isGroup: false,
    });

    for (const conversation of conversations) {
      // Archive or delete the conversation
      await Conversation.findByIdAndUpdate(conversation._id, {
        $set: { archived: true, archivedAt: new Date() },
      });

      // Notify via socket
      const io = require("socket.io")(); // You might need to get this differently
      if (io) {
        io.to(`conversation_${conversation._id}`).emit(
          "conversation_archived_due_to_block",
          {
            conversationId: conversation._id,
            archivedBy: blockerId,
            archivedAt: new Date(),
          }
        );
      }
    }

    console.log(
      `✅ Removed conversations between ${blockerId} and ${blockedId}`
    );
  } catch (error) {
    console.error("Error removing from conversations:", error);
  }
}

// ✅ GET MESSAGE REACTIONS
exports.getMessageReactions = async (req, res) => {
  try {
    const { messageId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(messageId)) {
      return res.status(400).json({
        success: false,
        error: "Invalid message ID",
      });
    }

    const message = await Message.findById(messageId)
      .populate("reactions.users", "name companyEmail avatar")
      .select("reactions");

    if (!message) {
      return res.status(404).json({
        success: false,
        error: "Message not found",
      });
    }

    res.json({
      success: true,
      reactions: message.reactions || [],
    });
  } catch (error) {
    console.error("Get message reactions error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to get message reactions",
      details: error.message,
    });
  }
};
exports.blockUser = async (req, res) => {
  try {
    const { userId, reason } = req.body;

    if (!userId) {
      return res.status(400).json({
        success: false,
        error: "User ID is required",
      });
    }

    // Validate user ID
    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({
        success: false,
        error: "Invalid user ID",
      });
    }

    // Prevent self-blocking
    if (userId === req.employee._id.toString()) {
      return res.status(400).json({
        success: false,
        error: "Cannot block yourself",
      });
    }

    // Check if user exists
    const userToBlock = await Employee.findById(userId);
    if (!userToBlock) {
      return res.status(404).json({
        success: false,
        error: "User not found",
      });
    }

    // Check if already blocked
    const currentEmployee = await Employee.findById(req.employee._id);
    if (currentEmployee.hasBlocked(userId)) {
      return res.status(400).json({
        success: false,
        error: "User is already blocked",
      });
    }

    // Add to blocked users
    await Employee.findByIdAndUpdate(req.employee._id, {
      $push: {
        blockedUsers: {
          user: userId,
          reason: reason || "",
          blockedAt: new Date(),
        },
      },
    });

    // Remove from any existing conversations
    await removeFromConversations(req.employee._id, userId);

    // ✅ EMIT SOCKET EVENT FOR BLOCK
    const io = req.app.get("io");
    if (io) {
      io.to(`user_${userId}`).emit("user_blocked_you", {
        blockedBy: {
          _id: req.employee._id,
          name: req.employee.name,
        },
        blockedAt: new Date(),
      });

      io.to(`user_${req.employee._id}`).emit("user_blocked", {
        blockedUser: {
          _id: userToBlock._id,
          name: userToBlock.name,
        },
        blockedAt: new Date(),
      });
    }

    res.json({
      success: true,
      message: "User blocked successfully",
      blockedUser: {
        _id: userToBlock._id,
        name: userToBlock.name,
        companyEmail: userToBlock.companyEmail,
      },
    });
  } catch (error) {
    console.error("Block user error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to block user",
      details: error.message,
    });
  }
};
exports.updateMessage = async (req, res) => {
  try {
    const { messageId } = req.params;
    const { content, messageType, removedAttachments } = req.body;
    const userId = req.employee._id;

    console.log("📝 Update message request:", {
      messageId,
      content,
      messageType,
      removedAttachments,
      newFiles: req.files?.length || 0,
    });

    // ✅ CRITICAL FIX: Handle temporary IDs more gracefully
    if (messageId && messageId.toString().startsWith("temp-")) {
      console.warn(
        "⚠️ Attempting to update a message with temporary ID:",
        messageId
      );

      // Instead of returning an error, we should check if there's an actual message
      // that matches the content/sender to find the real message ID
      // Or simply return a success to prevent frontend errors
      return res.status(200).json({
        success: true,
        message: "Message updated (temporary ID ignored)",
        tempMessageId: messageId,
      });
    }

    // ✅ Validate MongoDB ObjectId format
    if (!mongoose.Types.ObjectId.isValid(messageId)) {
      return res.status(400).json({
        success: false,
        error: `Invalid message ID format: ${messageId}`,
        details: "Message ID must be a valid MongoDB ObjectId",
      });
    }

    // Find the message
    const message = await Message.findById(messageId);

    if (!message) {
      return res.status(404).json({
        success: false,
        error: "Message not found",
        messageId: messageId,
      });
    }

    // Check if user is the sender
    if (message.sender.toString() !== userId.toString()) {
      return res.status(403).json({
        success: false,
        error: "You can only edit your own messages",
      });
    }

    // Update content if provided
    if (content !== undefined) {
      message.content = content;
    }

    // Handle removed attachments
    if (removedAttachments) {
      try {
        // Check if removedAttachments is already an array or needs parsing
        let removedIds;
        if (Array.isArray(removedAttachments)) {
          removedIds = removedAttachments;
        } else {
          removedIds = JSON.parse(removedAttachments);
        }

        if (Array.isArray(removedIds) && removedIds.length > 0) {
          console.log("🗑️ Removing attachments:", removedIds);

          // Filter out attachments marked for removal
          const remainingAttachments = [];

          for (const attachment of message.attachments) {
            const shouldRemove = removedIds.some(
              (id) => id === attachment._id?.toString()
            );

            if (!shouldRemove) {
              remainingAttachments.push(attachment);
            } else if (attachment.url) {
              // Try to delete file from storage if it exists
              try {
                const filePath = path.join(
                  __dirname,
                  "../../",
                  attachment.url.replace(
                    `${req.protocol}://${req.get("host")}/`,
                    ""
                  )
                );

                if (fs.existsSync(filePath)) {
                  fs.unlinkSync(filePath);
                  console.log("✅ Deleted file:", filePath);
                }
              } catch (fileError) {
                console.warn("Could not delete file:", fileError.message);
              }
            }
          }

          message.attachments = remainingAttachments;
        }
      } catch (parseError) {
        console.error("Error parsing removedAttachments:", parseError);
      }
    }

    // ✅ FIX: Handle new file uploads with multer
    if (req.files && req.files.length > 0) {
      console.log("📎 Adding new attachments:", req.files.length);

      const newAttachments = req.files.map((file) => ({
        filename: file.filename,
        originalName: file.originalname,
        url: `${req.protocol}://${req.get("host")}/uploads/chat-attachments/${
          file.filename
        }`,
        mimetype: file.mimetype,
        size: file.size,
        uploadedAt: new Date(),
      }));

      // Add new attachments to existing ones
      message.attachments = [...message.attachments, ...newAttachments];
    }

    // Determine final message type
    if (messageType) {
      message.messageType = messageType;
    } else if (message.attachments.length > 0) {
      // Auto-detect message type based on attachments
      const hasImages = message.attachments.some((a) =>
        a.mimetype.startsWith("image/")
      );
      const hasGifs = message.attachments.some(
        (a) => a.mimetype === "image/gif"
      );
      const hasVideos = message.attachments.some((a) =>
        a.mimetype.startsWith("video/")
      );
      const hasAudio = message.attachments.some((a) =>
        a.mimetype.startsWith("audio/")
      );

      if (hasGifs) {
        message.messageType = "gif";
      } else if (hasImages) {
        message.messageType = "image";
      } else if (hasVideos) {
        message.messageType = "video";
      } else if (hasAudio) {
        message.messageType = "audio";
      } else {
        message.messageType = "file";
      }
    } else if (message.attachments.length === 0 && message.content) {
      message.messageType = "text";
    }

    // Mark as edited
    message.editedAt = new Date();
    message.isEdited = true;

    // Save the updated message
    await message.save();

    // Populate sender details for response
    await message.populate([
      { path: "sender", select: "name companyEmail avatar photographUrl" },
      { path: "conversation", select: "_id" },
      { path: "space", select: "_id name" },
    ]);

    // Emit socket event for real-time update
    const io = req.app.get("io");
    if (io) {
      // Determine room based on conversation or space
      let room;
      if (message.conversation) {
        room = `conversation_${message.conversation._id}`;
      } else if (message.space) {
        room = `space_${message.space._id}`;
      }

      if (room) {
        io.to(room).emit("message_updated", {
          messageId: message._id,
          message: message,
          updatedBy: userId,
          updatedAt: new Date(),
        });

        console.log(`✅ Message update broadcasted to ${room}`);
      }
    }

    res.status(200).json({
      success: true,
      message: message,
      msg: "Message updated successfully",
    });
  } catch (error) {
    console.error("❌ Error updating message:", error);
    res.status(500).json({
      success: false,
      error: "Failed to update message",
      details: error.message,
    });
  }
};

exports.deleteSingleMessage = async (req, res) => {
  try {
    const { messageId } = req.params;
    const userId = req.employee._id;

    // Validate ID
    if (!mongoose.Types.ObjectId.isValid(messageId)) {
      return res.status(400).json({
        success: false,
        error: "Invalid message ID",
      });
    }

    // Find message and ensure the current user is the sender
    const message = await Message.findById(messageId).populate(
      "conversation space"
    );
    if (!message) {
      return res.status(404).json({
        success: false,
        error: "Message not found",
      });
    }
    if (message.sender.toString() !== userId.toString()) {
      return res.status(403).json({
        success: false,
        error: "You can only delete your own messages",
      });
    }

    // Delete the message document
    await Message.findByIdAndDelete(messageId);

    // If it was the last message in the conversation, update the conversation.lastMessage
    if (
      message.conversation &&
      message.conversation.lastMessage?.toString() === messageId
    ) {
      const prev = await Message.findOne({
        conversation: message.conversation._id,
      })
        .sort({ createdAt: -1 })
        .select("_id");
      await Conversation.findByIdAndUpdate(
        message.conversation._id,
        { lastMessage: prev ? prev._id : null },
        { new: true }
      );
    }

    // Broadcast deletion event via socket.io
    const io = req.app.get("io");
    if (io) {
      const room = message.space
        ? `space_${message.space._id}`
        : `conversation_${message.conversation._id}`;
      io.to(room).emit("message_deleted", {
        messageId,
        deletedBy: userId,
        deletedAt: new Date(),
      });
    }

    return res.json({
      success: true,
      message: "Message deleted successfully",
      deletedMessageId: messageId,
    });
  } catch (error) {
    console.error("Delete single message error:", error);
    return res.status(500).json({
      success: false,
      error: "Failed to delete message",
      details: error.message,
    });
  }
};
// Unblock a user
exports.unblockUser = async (req, res) => {
  try {
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({
        success: false,
        error: "User ID is required",
      });
    }

    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({
        success: false,
        error: "Invalid user ID",
      });
    }

    // Check if user is actually blocked
    const currentEmployee = await Employee.findById(req.employee._id);
    if (!currentEmployee.hasBlocked(userId)) {
      return res.status(400).json({
        success: false,
        error: "User is not blocked",
      });
    }

    // Remove from blocked users
    await Employee.findByIdAndUpdate(req.employee._id, {
      $pull: {
        blockedUsers: { user: userId },
      },
    });

    const unblockedUser = await Employee.findById(userId).select(
      "name companyEmail"
    );

    // ✅ EMIT SOCKET EVENT FOR UNBLOCK
    const io = req.app.get("io");
    if (io) {
      io.to(`user_${userId}`).emit("user_unblocked_you", {
        unblockedBy: {
          _id: req.employee._id,
          name: req.employee.name,
        },
        unblockedAt: new Date(),
      });

      io.to(`user_${req.employee._id}`).emit("user_unblocked", {
        unblockedUser: {
          _id: unblockedUser._id,
          name: unblockedUser.name,
        },
        unblockedAt: new Date(),
      });
    }

    res.json({
      success: true,
      message: "User unblocked successfully",
      unblockedUser: {
        _id: unblockedUser._id,
        name: unblockedUser.name,
        companyEmail: unblockedUser.companyEmail,
      },
    });
  } catch (error) {
    console.error("Unblock user error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to unblock user",
      details: error.message,
    });
  }
};

// Get blocked users list
exports.getBlockedUsers = async (req, res) => {
  try {
    const employee = await Employee.findById(req.employee._id)
      .populate("blockedUsers.user", "name companyEmail avatar photographUrl")
      .select("blockedUsers");

    const blockedUsers = employee.blockedUsers.map((block) => ({
      _id: block.user._id,
      name: block.user.name,
      companyEmail: block.user.companyEmail,
      avatar: block.user.avatar,
      photographUrl: block.user.photographUrl,
      blockedAt: block.blockedAt,
      reason: block.reason,
    }));

    res.json({
      success: true,
      blockedUsers,
      total: blockedUsers.length,
    });
  } catch (error) {
    console.error("Get blocked users error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch blocked users",
      details: error.message,
    });
  }
};

// Check block status between users
exports.checkBlockStatus = async (req, res) => {
  try {
    const { userId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({
        success: false,
        error: "Invalid user ID",
      });
    }

    const blockStatus = await Employee.getBlockStatus(req.employee._id, userId);

    res.json({
      success: true,
      ...blockStatus,
    });
  } catch (error) {
    console.error("Check block status error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to check block status",
      details: error.message,
    });
  }
};
exports.pinConversation = async (req, res) => {
  try {
    const { conversationId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(conversationId)) {
      return res.status(400).json({
        success: false,
        error: "Invalid conversation ID",
      });
    }

    const conversation = await Conversation.findOne({
      _id: conversationId,
      participants: req.employee._id,
    });

    if (!conversation) {
      return res.status(404).json({
        success: false,
        error: "Conversation not found",
      });
    }

    // Check if already pinned
    const isAlreadyPinned = conversation.pinnedBy.some(
      (pin) => pin.employee.toString() === req.employee._id.toString()
    );

    if (isAlreadyPinned) {
      // Return success with current state instead of error
      const updatedConversation = await Conversation.findById(conversationId)
        .populate("participants", "name companyEmail avatar photographUrl")
        .populate("lastMessage")
        .populate("pinnedBy.employee", "name companyEmail");

      return res.json({
        success: true,
        message: "Conversation is already pinned",
        conversation: {
          _id: updatedConversation._id,
          participants: updatedConversation.participants.filter(
            (p) => p._id.toString() !== req.employee._id.toString()
          ),
          lastMessage: updatedConversation.lastMessage,
          unreadCount:
            updatedConversation.unreadCount?.get(req.employee._id.toString()) ||
            0,
          updatedAt: updatedConversation.updatedAt,
          isPinned: true,
          pinnedAt: conversation.pinnedBy.find(
            (pin) => pin.employee.toString() === req.employee._id.toString()
          )?.pinnedAt,
          type: updatedConversation.isGroup ? "group" : "dm",
        },
      });
    }

    // Add to pinnedBy array
    conversation.pinnedBy.push({
      employee: req.employee._id,
      pinnedAt: new Date(),
    });

    await conversation.save();

    // Populate the updated conversation
    const updatedConversation = await Conversation.findById(conversationId)
      .populate("participants", "name companyEmail avatar photographUrl")
      .populate("lastMessage")
      .populate("pinnedBy.employee", "name companyEmail");

    // ✅ EMIT SOCKET EVENT FOR PIN
    const io = req.app.get("io");
    if (io) {
      io.to(`user_${req.employee._id}`).emit("conversation_pinned", {
        conversationId,
        pinnedBy: req.employee._id,
        pinnedAt: new Date(),
      });
    }

    res.json({
      success: true,
      message: "Conversation pinned successfully",
      conversation: {
        _id: updatedConversation._id,
        participants: updatedConversation.participants.filter(
          (p) => p._id.toString() !== req.employee._id.toString()
        ),
        lastMessage: updatedConversation.lastMessage,
        unreadCount:
          updatedConversation.unreadCount?.get(req.employee._id.toString()) ||
          0,
        updatedAt: updatedConversation.updatedAt,
        isPinned: true,
        pinnedAt: new Date(),
        type: updatedConversation.isGroup ? "group" : "dm",
      },
    });
  } catch (error) {
    console.error("Pin conversation error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to pin conversation",
      details: error.message,
    });
  }
};

exports.unpinConversation = async (req, res) => {
  try {
    const { conversationId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(conversationId)) {
      return res.status(400).json({
        success: false,
        error: "Invalid conversation ID",
      });
    }

    const conversation = await Conversation.findOne({
      _id: conversationId,
      participants: req.employee._id,
    });

    if (!conversation) {
      return res.status(404).json({
        success: false,
        error: "Conversation not found",
      });
    }

    // Check if actually pinned
    const isPinned = conversation.pinnedBy.some(
      (pin) => pin.employee.toString() === req.employee._id.toString()
    );

    if (!isPinned) {
      return res.status(400).json({
        success: false,
        error: "Conversation is not pinned",
      });
    }

    // Remove from pinnedBy array
    conversation.pinnedBy = conversation.pinnedBy.filter(
      (pin) => pin.employee.toString() !== req.employee._id.toString()
    );

    await conversation.save();

    // Populate the updated conversation
    const updatedConversation = await Conversation.findById(conversationId)
      .populate("participants", "name companyEmail avatar photographUrl")
      .populate("lastMessage");

    // ✅ EMIT SOCKET EVENT FOR UNPIN
    const io = req.app.get("io");
    if (io) {
      io.to(`user_${req.employee._id}`).emit("conversation_unpinned", {
        conversationId,
        unpinnedBy: req.employee._id,
        unpinnedAt: new Date(),
      });
    }

    res.json({
      success: true,
      message: "Conversation unpinned successfully",
      conversation: {
        _id: updatedConversation._id,
        participants: updatedConversation.participants.filter(
          (p) => p._id.toString() !== req.employee._id.toString()
        ),
        lastMessage: updatedConversation.lastMessage,
        unreadCount:
          updatedConversation.unreadCount?.get(req.employee._id.toString()) ||
          0,
        updatedAt: updatedConversation.updatedAt,
        isPinned: false,
        type: updatedConversation.isGroup ? "group" : "dm",
      },
    });
  } catch (error) {
    console.error("Unpin conversation error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to unpin conversation",
      details: error.message,
    });
  }
};
// ✅ GET PINNED CONVERSATIONS ONLY
exports.getPinnedConversations = async (req, res) => {
  try {
    const pinnedConversations = await Conversation.find({
      participants: req.employee._id,
      "pinnedBy.employee": req.employee._id, // only pinned by current user
      archivedBy: { $ne: req.employee._id },
    })
      .populate("participants", "name companyEmail avatar photographUrl")
      .populate("lastMessage")
      .populate("admins", "name companyEmail avatar photographUrl")
      .populate("pinnedBy.employee", "name companyEmail")
      .sort({ "pinnedBy.pinnedAt": -1 });

    const formatted = pinnedConversations.map((conv) => ({
      _id: conv._id,
      participants: conv.participants.filter(
        (p) => p._id.toString() !== req.employee._id.toString()
      ),
      lastMessage: conv.lastMessage,
      unreadCount: conv.unreadCount.get(req.employee._id.toString()) || 0,
      updatedAt: conv.updatedAt,
      isPinned: true,
      pinnedAt:
        conv.pinnedBy.find(
          (pin) => pin.employee.toString() === req.employee._id.toString()
        )?.pinnedAt || null,
      type: conv.isGroup ? "group" : "dm",
      groupName: conv.groupName,
      groupAvatar: conv.groupAvatar,
      admins: conv.admins,
    }));

    res.json({
      success: true,
      pinnedConversations: formatted,
      count: formatted.length,
    });
  } catch (error) {
    console.error("Get pinned conversations error:", error);
    res
      .status(500)
      .json({ success: false, error: "Failed to fetch pinned conversations" });
  }
};
// ✅ HIDE CONVERSATION
exports.hideConversation = async (req, res) => {
  try {
    const { conversationId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(conversationId)) {
      return res.status(400).json({
        success: false,
        error: "Invalid conversation ID",
      });
    }

    const conversation = await Conversation.findOne({
      _id: conversationId,
      participants: req.employee._id,
    });

    if (!conversation) {
      return res.status(404).json({
        success: false,
        error: "Conversation not found",
      });
    }

    // Add user to hiddenBy array
    if (!conversation.hiddenBy.includes(req.employee._id)) {
      conversation.hiddenBy.push(req.employee._id);
      await conversation.save();
    }

    // ✅ EMIT SOCKET EVENT FOR CONVERSATION HIDDEN
    const io = req.app.get("io");
    if (io) {
      io.to(`user_${req.employee._id}`).emit("conversation_hidden", {
        conversationId,
        hiddenBy: req.employee._id,
        hiddenAt: new Date(),
      });
    }

    res.json({
      success: true,
      message: "Conversation hidden successfully",
      conversationId,
    });
  } catch (error) {
    console.error("Hide conversation error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to hide conversation",
      details: error.message,
    });
  }
};
// ✅ UNHIDE CONVERSATION
exports.unhideConversation = async (req, res) => {
  try {
    const { conversationId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(conversationId)) {
      return res.status(400).json({
        success: false,
        error: "Invalid conversation ID",
      });
    }

    const conversation = await Conversation.findOne({
      _id: conversationId,
      participants: req.employee._id,
    });

    if (!conversation) {
      return res.status(404).json({
        success: false,
        error: "Conversation not found",
      });
    }

    // Remove user from hiddenBy array
    conversation.hiddenBy = conversation.hiddenBy.filter(
      (userId) => userId.toString() !== req.employee._id.toString()
    );
    await conversation.save();

    // ✅ EMIT SOCKET EVENT FOR CONVERSATION UNHIDDEN
    const io = req.app.get("io");
    if (io) {
      io.to(`user_${req.employee._id}`).emit("conversation_unhidden", {
        conversationId,
        unhiddenBy: req.employee._id,
        unhiddenAt: new Date(),
      });
    }

    res.json({
      success: true,
      message: "Conversation unhidden successfully",
      conversationId,
    });
  } catch (error) {
    console.error("Unhide conversation error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to unhide conversation",
      details: error.message,
    });
  }
};

// ✅ GET HIDDEN CONVERSATIONS
exports.getHiddenConversations = async (req, res) => {
  try {
    const hiddenConversations = await Conversation.find({
      participants: req.employee._id,
      hiddenBy: req.employee._id, // Only conversations hidden by current user
    })
      .populate("participants", "name companyEmail avatar photographUrl")
      .populate("lastMessage")
      .sort({ updatedAt: -1 });

    const formatted = hiddenConversations.map((conv) => ({
      _id: conv._id,
      participants: conv.participants.filter(
        (p) => p._id.toString() !== req.employee._id.toString()
      ),
      lastMessage: conv.lastMessage,
      unreadCount: conv.unreadCount.get(req.employee._id.toString()) || 0,
      updatedAt: conv.updatedAt,
      isHidden: true,
      type: conv.isGroup ? "group" : "dm",
      groupName: conv.groupName,
      groupAvatar: conv.groupAvatar,
    }));

    res.json({
      success: true,
      hiddenConversations: formatted,
      count: formatted.length,
    });
  } catch (error) {
    console.error("Get hidden conversations error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch hidden conversations",
    });
  }
};
// ✅ GET SIMPLE CONVERSATION MEMBERS (minimal data)
exports.getConversationMembersSimple = async (req, res) => {
  try {
    const { conversationId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(conversationId)) {
      return res.status(400).json({
        success: false,
        error: "Invalid conversation ID",
      });
    }

    const conversation = await Conversation.findOne({
      _id: conversationId,
      participants: req.employee._id,
    })
      .populate(
        "participants",
        "name companyEmail avatar photographUrl isOnline"
      )
      .lean();

    if (!conversation) {
      return res.status(404).json({
        success: false,
        error: "Conversation not found or access denied",
      });
    }

    // Simple member list without additional statistics
    const members = conversation.participants
      .filter(
        (participant) =>
          participant._id.toString() !== req.employee._id.toString()
      )
      .map((participant) => ({
        _id: participant._id,
        name: participant.name,
        email: participant.companyEmail,
        avatar: participant.photographUrl || participant.avatar,
        isOnline: participant.isOnline || false,
        status: participant.isOnline ? "online" : "offline",
      }));

    res.json({
      success: true,
      members: members,
      total: members.length,
    });
  } catch (error) {
    console.error("Get simple conversation members error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch conversation members",
      details: error.message,
    });
  }
};
exports.getSpaceSharedContent = async (req, res) => {
  try {
    const { spaceId } = req.params;
    const { type } = req.query; // Optional: 'files', 'links', 'media', or 'all'

    console.log("🔍 Fetching shared content for space:", spaceId);

    if (!mongoose.Types.ObjectId.isValid(spaceId)) {
      return res.status(400).json({
        success: false,
        error: "Invalid space ID",
      });
    }

    // Check if user has access to this space
    const space = await Space.findOne({
      _id: spaceId,
      members: req.employee._id,
    });

    if (!space) {
      return res.status(404).json({
        success: false,
        error: "Space not found or access denied",
      });
    }

    // Find the conversation for this space
    const conversation = await Conversation.findOne({
      space: spaceId,
      participants: req.employee._id,
    });

    if (!conversation) {
      return res.json({
        success: true,
        data: {
          files: [],
          links: [],
          media: [],
        },
        summary: {
          totalFiles: 0,
          totalLinks: 0,
          totalMedia: 0,
        },
      });
    }

    // Build query based on content type
    let messageQuery = {
      conversation: conversation._id,
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

    console.log(
      `📦 Found ${messages.length} messages with shared content in space ${spaceId}`
    );

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

    console.log(`📊 Space shared content summary:`, {
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
      space: {
        _id: space._id,
        name: space.name,
        description: space.description,
      },
    });
  } catch (error) {
    console.error("Get space shared content error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch space shared content",
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
// ✅ FIXED SEARCH MESSAGES API - PROPERLY ESCAPED REGEX
exports.searchMessages = async (req, res) => {
  try {
    const { q: query, conversationId, limit = 50 } = req.query;

    if (!query || query.trim().length < 2) {
      return res.status(400).json({
        success: false,
        error: "Search query must be at least 2 characters long",
      });
    }

    const searchTerm = query.trim();
    console.log("🔍 Searching for:", searchTerm);

    // ✅ FIX: Properly escape regex special characters
    const escapedSearchTerm = searchTerm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    // Build search query with escaped term
    let searchQuery = {
      $or: [
        { content: { $regex: escapedSearchTerm, $options: "i" } },
        {
          "attachments.originalName": {
            $regex: escapedSearchTerm,
            $options: "i",
          },
        },
        {
          "attachments.filename": { $regex: escapedSearchTerm, $options: "i" },
        },
      ],
    };

    // If specific conversation, verify access
    if (conversationId) {
      if (!mongoose.Types.ObjectId.isValid(conversationId)) {
        return res.status(400).json({
          success: false,
          error: "Invalid conversation ID",
        });
      }

      const conversation = await Conversation.findOne({
        _id: conversationId,
        participants: req.employee._id,
      });

      if (!conversation) {
        return res.status(403).json({
          success: false,
          error: "Access denied to this conversation",
        });
      }

      searchQuery.conversation = conversationId;
    } else {
      // Search across all user's conversations
      const userConversations = await Conversation.find({
        participants: req.employee._id,
        archivedBy: { $ne: req.employee._id },
        hiddenBy: { $ne: req.employee._id },
      }).select("_id");

      const conversationIds = userConversations.map((conv) => conv._id);

      if (conversationIds.length === 0) {
        return res.json({
          success: true,
          messages: [],
          total: 0,
        });
      }

      searchQuery.conversation = { $in: conversationIds };
    }

    // Execute search
    const messages = await Message.find(searchQuery)
      .populate("sender", "name companyEmail avatar photographUrl")
      .populate("conversation", "isGroup groupName space")
      .populate("space", "name description avatar")
      .populate("attachments")
      .sort({ createdAt: -1 })
      .limit(parseInt(limit))
      .lean();

    console.log(
      `✅ Found ${messages.length} messages matching "${searchTerm}"`
    );

    // Format results
    const results = messages.map((message) => {
      const isSpace = message.conversation?.space || message.space;

      return {
        _id: message._id,
        content: message.content,
        messageType: message.messageType,
        attachments: message.attachments || [],
        sender: {
          _id: message.sender._id,
          name: message.sender.name,
          email: message.sender.companyEmail,
          avatar: message.sender.photographUrl || message.sender.avatar,
        },
        conversation: {
          _id: message.conversation._id,
          name: message.conversation.isGroup
            ? message.conversation.groupName
            : "Direct Message",
          isGroup: message.conversation.isGroup,
          isSpace: !!isSpace,
        },
        space: message.space
          ? {
              _id: message.space._id,
              name: message.space.name,
            }
          : null,
        createdAt: message.createdAt,
        // Simple highlight - frontend can handle proper highlighting
        hasMatchInContent: message.content
          ?.toLowerCase()
          .includes(searchTerm.toLowerCase()),
        hasMatchInFiles: message.attachments?.some(
          (att) =>
            att.originalName
              ?.toLowerCase()
              .includes(searchTerm.toLowerCase()) ||
            att.filename?.toLowerCase().includes(searchTerm.toLowerCase())
        ),
      };
    });

    res.json({
      success: true,
      query: searchTerm,
      messages: results,
      total: results.length,
    });
  } catch (error) {
    console.error("Search messages error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to search messages",
      details: error.message,
    });
  }
};
// ✅ STAR MESSAGE
exports.starMessage = async (req, res) => {
  try {
    const { messageId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(messageId)) {
      return res.status(400).json({
        success: false,
        error: "Invalid message ID",
      });
    }

    // Find the message
    const message = await Message.findById(messageId);
    if (!message) {
      return res.status(404).json({
        success: false,
        error: "Message not found",
      });
    }

    // Check if user has access to this message
    const conversation = await Conversation.findOne({
      _id: message.conversation,
      participants: req.employee._id,
    });

    if (!conversation) {
      return res.status(403).json({
        success: false,
        error: "Access denied to this message",
      });
    }

    // Check if already starred
    if (message.isStarredBy(req.employee._id)) {
      return res.status(400).json({
        success: false,
        error: "Message is already starred",
      });
    }

    // Add to starredBy array
    message.starredBy.push({
      employee: req.employee._id,
      starredAt: new Date(),
    });

    await message.save();

    // Populate the updated message
    const updatedMessage = await Message.findById(messageId)
      .populate("sender", "name companyEmail avatar")
      .populate("starredBy.employee", "name companyEmail avatar")
      .populate("receivers", "name companyEmail avatar")
      .populate("space")
      .populate("conversation");

    // ✅ EMIT SOCKET EVENT FOR MESSAGE STARRED
    const io = req.app.get("io");
    if (io) {
      const room = message.space
        ? `space_${message.space}`
        : `conversation_${message.conversation}`;

      io.to(room).emit("message_starred", {
        messageId,
        starredBy: req.employee._id,
        starredAt: new Date(),
        totalStars: updatedMessage.starredBy.length,
      });

      console.log(`✅ Message starred: ${messageId}`);
    }

    res.json({
      success: true,
      message: "Message starred successfully",
      starredBy: updatedMessage.starredBy,
      totalStars: updatedMessage.starredBy.length,
    });
  } catch (error) {
    console.error("Star message error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to star message",
      details: error.message,
    });
  }
};

// ✅ UNSTAR MESSAGE
exports.unstarMessage = async (req, res) => {
  try {
    const { messageId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(messageId)) {
      return res.status(400).json({
        success: false,
        error: "Invalid message ID",
      });
    }

    // Find the message
    const message = await Message.findById(messageId);
    if (!message) {
      return res.status(404).json({
        success: false,
        error: "Message not found",
      });
    }

    // Check if user has access to this message
    const conversation = await Conversation.findOne({
      _id: message.conversation,
      participants: req.employee._id,
    });

    if (!conversation) {
      return res.status(403).json({
        success: false,
        error: "Access denied to this message",
      });
    }

    // Check if actually starred
    if (!message.isStarredBy(req.employee._id)) {
      return res.status(400).json({
        success: false,
        error: "Message is not starred",
      });
    }

    // Remove from starredBy array
    message.starredBy = message.starredBy.filter(
      (star) => star.employee.toString() !== req.employee._id.toString()
    );

    await message.save();

    // Populate the updated message
    const updatedMessage = await Message.findById(messageId)
      .populate("sender", "name companyEmail avatar")
      .populate("starredBy.employee", "name companyEmail avatar")
      .populate("receivers", "name companyEmail avatar")
      .populate("space")
      .populate("conversation");

    // ✅ EMIT SOCKET EVENT FOR MESSAGE UNSTARRED
    const io = req.app.get("io");
    if (io) {
      const room = message.space
        ? `space_${message.space}`
        : `conversation_${message.conversation}`;

      io.to(room).emit("message_unstarred", {
        messageId,
        unstarredBy: req.employee._id,
        unstarredAt: new Date(),
        totalStars: updatedMessage.starredBy.length,
      });

      console.log(`✅ Message unstarred: ${messageId}`);
    }

    res.json({
      success: true,
      message: "Message unstarred successfully",
      starredBy: updatedMessage.starredBy,
      totalStars: updatedMessage.starredBy.length,
    });
  } catch (error) {
    console.error("Unstar message error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to unstar message",
      details: error.message,
    });
  }
};

// ✅ GET STARRED MESSAGES FOR USER
exports.getStarredMessages = async (req, res) => {
  try {
    const { page = 1, limit = 50, conversationId } = req.query;

    // Build query for starred messages
    let query = {
      "starredBy.employee": req.employee._id,
    };

    // If specific conversation, filter by it
    if (conversationId && mongoose.Types.ObjectId.isValid(conversationId)) {
      const conversation = await Conversation.findOne({
        _id: conversationId,
        participants: req.employee._id,
      });

      if (!conversation) {
        return res.status(403).json({
          success: false,
          error: "Access denied to this conversation",
        });
      }

      query.conversation = conversationId;
    } else {
      // Get all conversations user has access to
      const userConversations = await Conversation.find({
        participants: req.employee._id,
        archivedBy: { $ne: req.employee._id },
        hiddenBy: { $ne: req.employee._id },
      }).select("_id");

      const conversationIds = userConversations.map((conv) => conv._id);

      if (conversationIds.length === 0) {
        return res.json({
          success: true,
          messages: [],
          total: 0,
          hasMore: false,
        });
      }

      query.conversation = { $in: conversationIds };
    }

    // Get starred messages with pagination
    const messages = await Message.find(query)
      .populate("sender", "name companyEmail avatar photographUrl")
      .populate("conversation", "isGroup groupName space")
      .populate("space", "name description avatar")
      .populate("starredBy.employee", "name companyEmail avatar")
      .populate("attachments")
      .sort({ "starredBy.starredAt": -1 })
      .limit(parseInt(limit))
      .skip((page - 1) * limit);

    const total = await Message.countDocuments(query);

    // Format response
    const formattedMessages = messages.map((message) => {
      const userStar = message.starredBy.find(
        (star) => star.employee._id.toString() === req.employee._id.toString()
      );

      return {
        _id: message._id,
        content: message.content,
        messageType: message.messageType,
        attachments: message.attachments || [],
        sender: {
          _id: message.sender._id,
          name: message.sender.name,
          email: message.sender.companyEmail,
          avatar: message.sender.photographUrl || message.sender.avatar,
        },
        conversation: {
          _id: message.conversation._id,
          name: message.conversation.isGroup
            ? message.conversation.groupName
            : "Direct Message",
          isGroup: message.conversation.isGroup,
          isSpace: !!message.conversation.space,
        },
        space: message.space
          ? {
              _id: message.space._id,
              name: message.space.name,
            }
          : null,
        starredAt: userStar ? userStar.starredAt : null,
        totalStars: message.starredBy.length,
        createdAt: message.createdAt,
        isStarred: true,
      };
    });

    res.json({
      success: true,
      messages: formattedMessages,
      total,
      hasMore: (page - 1) * limit + messages.length < total,
      page: parseInt(page),
      totalPages: Math.ceil(total / limit),
    });
  } catch (error) {
    console.error("Get starred messages error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch starred messages",
      details: error.message,
    });
  }
};

// ✅ PIN A MESSAGE
exports.pinMessage = async (req, res) => {
  try {
    const { messageId } = req.params;
    const { note } = req.body || {};

    console.log("📌 Pin message request:", {
      messageId,
      note,
      user: req.employee._id,
    });

    // Validate message ID
    if (!mongoose.Types.ObjectId.isValid(messageId)) {
      return res.status(400).json({
        success: false,
        error: "Invalid message ID",
      });
    }

    // Find the message
    const message = await Message.findById(messageId)
      .populate("sender", "name companyEmail avatar")
      .populate("conversation", "participants isGroup space");

    if (!message) {
      return res.status(404).json({
        success: false,
        error: "Message not found",
      });
    }

    // Check if user has access to this message's conversation
    const hasAccess = message.conversation.participants.some(
      (participant) => participant.toString() === req.employee._id.toString()
    );

    if (!hasAccess) {
      return res.status(403).json({
        success: false,
        error: "Access denied to this message",
      });
    }

    // Check if message is already pinned by this user
    if (message.isPinnedBy(req.employee._id)) {
      return res.status(400).json({
        success: false,
        error: "Message is already pinned by you",
      });
    }

    // Add pin to message
    message.pinnedBy.push({
      employee: req.employee._id,
      pinnedAt: new Date(),
      note: note || "",
    });

    // Update isPinned flag
    message.isPinned = true;

    await message.save();

    // Populate the updated message with pin details
    const updatedMessage = await Message.findById(messageId)
      .populate("sender", "name companyEmail avatar photographUrl")
      .populate("pinnedBy.employee", "name companyEmail avatar photographUrl")
      .populate("conversation", "isGroup groupName space");

    // ✅ EMIT SOCKET EVENT FOR MESSAGE PINNED
    const io = req.app.get("io");
    if (io) {
      const room = message.conversation.space
        ? `space_${message.conversation.space}`
        : `conversation_${message.conversation._id}`;

      io.to(room).emit("message_pinned", {
        messageId,
        pinnedBy: {
          _id: req.employee._id,
          name: req.employee.name,
          avatar: req.employee.avatar,
        },
        pinnedAt: new Date(),
        note: note || "",
        totalPins: updatedMessage.pinnedBy.length,
        message: {
          _id: updatedMessage._id,
          content: updatedMessage.content,
          messageType: updatedMessage.messageType,
          sender: updatedMessage.sender,
        },
      });

      console.log(`✅ Message pinned: ${messageId} in room: ${room}`);
    }

    res.json({
      success: true,
      message: "Message pinned successfully",
      pinnedMessage: {
        _id: updatedMessage._id,
        content: updatedMessage.content,
        messageType: updatedMessage.messageType,
        sender: updatedMessage.sender,
        pinnedBy: updatedMessage.pinnedBy,
        isPinned: true,
        pinnedAt: new Date(),
        note: note || "",
        totalPins: updatedMessage.pinnedBy.length,
      },
    });
  } catch (error) {
    console.error("Pin message error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to pin message",
      details: error.message,
    });
  }
};

// ✅ UNPIN A MESSAGE
exports.unpinMessage = async (req, res) => {
  try {
    const { messageId } = req.params;

    console.log("📌 Unpin message request:", {
      messageId,
      user: req.employee._id,
    });

    // Validate message ID
    if (!mongoose.Types.ObjectId.isValid(messageId)) {
      return res.status(400).json({
        success: false,
        error: "Invalid message ID",
      });
    }

    // Find the message
    const message = await Message.findById(messageId)
      .populate("sender", "name companyEmail avatar")
      .populate("conversation", "participants isGroup space");

    if (!message) {
      return res.status(404).json({
        success: false,
        error: "Message not found",
      });
    }

    // Check if user has access to this message's conversation
    const hasAccess = message.conversation.participants.some(
      (participant) => participant.toString() === req.employee._id.toString()
    );

    if (!hasAccess) {
      return res.status(403).json({
        success: false,
        error: "Access denied to this message",
      });
    }

    // Check if message is actually pinned by this user
    if (!message.isPinnedBy(req.employee._id)) {
      return res.status(400).json({
        success: false,
        error: "Message is not pinned by you",
      });
    }

    // Get pin details before removing (for socket event)
    const pinToRemove = message.pinnedBy.find(
      (pin) => pin.employee.toString() === req.employee._id.toString()
    );

    // Remove user's pin from message
    message.pinnedBy = message.pinnedBy.filter(
      (pin) => pin.employee.toString() !== req.employee._id.toString()
    );

    // Update isPinned flag if no pins left
    message.isPinned = message.pinnedBy.length > 0;

    await message.save();

    // Populate the updated message
    const updatedMessage = await Message.findById(messageId).populate(
      "pinnedBy.employee",
      "name companyEmail avatar photographUrl"
    );

    // ✅ EMIT SOCKET EVENT FOR MESSAGE UNPINNED
    const io = req.app.get("io");
    if (io) {
      const room = message.conversation.space
        ? `space_${message.conversation.space}`
        : `conversation_${message.conversation._id}`;

      io.to(room).emit("message_unpinned", {
        messageId,
        unpinnedBy: req.employee._id,
        unpinnedAt: new Date(),
        previousPinId: pinToRemove?._id,
        totalPins: updatedMessage.pinnedBy.length,
      });

      console.log(`✅ Message unpinned: ${messageId} from room: ${room}`);
    }

    res.json({
      success: true,
      message: "Message unpinned successfully",
      messageId,
      totalPins: updatedMessage.pinnedBy.length,
      isPinned: updatedMessage.isPinned,
    });
  } catch (error) {
    console.error("Unpin message error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to unpin message",
      details: error.message,
    });
  }
};

// ✅ GET PINNED MESSAGES FOR A CONVERSATION
exports.getPinnedMessages = async (req, res) => {
  try {
    const { conversationId } = req.params;
    const { page = 1, limit = 50 } = req.query;

    console.log("📌 Get pinned messages request:", { conversationId });

    // Validate conversation ID
    if (!mongoose.Types.ObjectId.isValid(conversationId)) {
      return res.status(400).json({
        success: false,
        error: "Invalid conversation ID",
      });
    }

    // First, check if this is a space ID by looking for a space with this ID
    const space = await Space.findOne({
      _id: conversationId,
      members: req.employee._id,
    });

    if (space) {
      // If it's a space ID, find the conversation associated with this space
      const spaceConversation = await Conversation.findOne({
        space: conversationId,
        participants: req.employee._id,
      });

      if (!spaceConversation) {
        return res.status(404).json({
          success: false,
          error: "Space conversation not found",
        });
      }

      // Get pinned messages for the space conversation
      const pinnedMessages = await Message.find({
        conversation: spaceConversation._id,
        isPinned: true,
      })
        .populate("sender", "name companyEmail avatar photographUrl")
        .populate("pinnedBy.employee", "name companyEmail avatar photographUrl")
        .populate("conversation", "isGroup groupName space")
        .sort({ "pinnedBy.pinnedAt": -1 })
        .limit(parseInt(limit))
        .skip((page - 1) * limit);

      const total = await Message.countDocuments({
        conversation: spaceConversation._id,
        isPinned: true,
      });

      // Format the response for space
      const formattedMessages = pinnedMessages.map((message) => {
        const userPin = message.pinnedBy.find(
          (pin) => pin.employee._id.toString() === req.employee._id.toString()
        );

        return {
          _id: message._id,
          content: message.content,
          messageType: message.messageType,
          attachments: message.attachments || [],
          sender: {
            _id: message.sender._id,
            name: message.sender.name,
            email: message.sender.companyEmail,
            avatar: message.sender.photographUrl || message.sender.avatar,
          },
          conversation: {
            _id: spaceConversation._id,
            name: space.name,
            isGroup: true,
            isSpace: true,
          },
          space: {
            _id: space._id,
            name: space.name,
            description: space.description,
          },
          pinnedBy: message.pinnedBy,
          pinnedAt: userPin ? userPin.pinnedAt : message.pinnedBy[0]?.pinnedAt,
          note: userPin ? userPin.note : message.pinnedBy[0]?.note,
          totalPins: message.pinnedBy.length,
          isPinned: true,
          createdAt: message.createdAt,
          pinnedByCurrentUser: !!userPin,
        };
      });

      return res.json({
        success: true,
        pinnedMessages: formattedMessages,
        total,
        hasMore: (page - 1) * limit + pinnedMessages.length < total,
        page: parseInt(page),
        totalPages: Math.ceil(total / limit),
        space: {
          _id: space._id,
          name: space.name,
          description: space.description,
        },
        isSpace: true,
      });
    }

    // If not a space, treat it as a regular conversation
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

    // Check if this conversation has a space reference
    if (conversation.space) {
      const spaceData = await Space.findById(conversation.space);

      // Get pinned messages for this conversation
      const pinnedMessages = await Message.find({
        conversation: conversationId,
        isPinned: true,
      })
        .populate("sender", "name companyEmail avatar photographUrl")
        .populate("pinnedBy.employee", "name companyEmail avatar photographUrl")
        .populate("conversation", "isGroup groupName space")
        .sort({ "pinnedBy.pinnedAt": -1 })
        .limit(parseInt(limit))
        .skip((page - 1) * limit);

      const total = await Message.countDocuments({
        conversation: conversationId,
        isPinned: true,
      });

      // Format the response for space conversation
      const formattedMessages = pinnedMessages.map((message) => {
        const userPin = message.pinnedBy.find(
          (pin) => pin.employee._id.toString() === req.employee._id.toString()
        );

        return {
          _id: message._id,
          content: message.content,
          messageType: message.messageType,
          attachments: message.attachments || [],
          sender: {
            _id: message.sender._id,
            name: message.sender.name,
            email: message.sender.companyEmail,
            avatar: message.sender.photographUrl || message.sender.avatar,
          },
          conversation: {
            _id: conversation._id,
            name: spaceData ? spaceData.name : conversation.groupName,
            isGroup: true,
            isSpace: true,
          },
          space: spaceData
            ? {
                _id: spaceData._id,
                name: spaceData.name,
                description: spaceData.description,
              }
            : null,
          pinnedBy: message.pinnedBy,
          pinnedAt: userPin ? userPin.pinnedAt : message.pinnedBy[0]?.pinnedAt,
          note: userPin ? userPin.note : message.pinnedBy[0]?.note,
          totalPins: message.pinnedBy.length,
          isPinned: true,
          createdAt: message.createdAt,
          pinnedByCurrentUser: !!userPin,
        };
      });

      return res.json({
        success: true,
        pinnedMessages: formattedMessages,
        total,
        hasMore: (page - 1) * limit + pinnedMessages.length < total,
        page: parseInt(page),
        totalPages: Math.ceil(total / limit),
        conversation: {
          _id: conversation._id,
          name: spaceData ? spaceData.name : conversation.groupName,
          isGroup: conversation.isGroup,
          isSpace: true,
        },
        space: spaceData,
        isSpace: true,
      });
    }

    // Regular direct message conversation (no space)
    const pinnedMessages = await Message.find({
      conversation: conversationId,
      isPinned: true,
    })
      .populate("sender", "name companyEmail avatar photographUrl")
      .populate("pinnedBy.employee", "name companyEmail avatar photographUrl")
      .populate("conversation", "isGroup groupName space")
      .sort({ "pinnedBy.pinnedAt": -1 })
      .limit(parseInt(limit))
      .skip((page - 1) * limit);

    const total = await Message.countDocuments({
      conversation: conversationId,
      isPinned: true,
    });

    // Get the other participant for direct messages
    const otherParticipant = conversation.participants.find(
      (p) => p.toString() !== req.employee._id.toString()
    );

    let otherParticipantData = null;
    if (otherParticipant) {
      otherParticipantData = await Employee.findById(otherParticipant).select(
        "name companyEmail avatar photographUrl"
      );
    }

    // Format the response for direct message
    const formattedMessages = pinnedMessages.map((message) => {
      const userPin = message.pinnedBy.find(
        (pin) => pin.employee._id.toString() === req.employee._id.toString()
      );

      return {
        _id: message._id,
        content: message.content,
        messageType: message.messageType,
        attachments: message.attachments || [],
        sender: {
          _id: message.sender._id,
          name: message.sender.name,
          email: message.sender.companyEmail,
          avatar: message.sender.photographUrl || message.sender.avatar,
        },
        conversation: {
          _id: conversation._id,
          name: conversation.isGroup
            ? conversation.groupName
            : otherParticipantData?.name || "Direct Message",
          isGroup: conversation.isGroup,
          isSpace: false,
        },
        pinnedBy: message.pinnedBy,
        pinnedAt: userPin ? userPin.pinnedAt : message.pinnedBy[0]?.pinnedAt,
        note: userPin ? userPin.note : message.pinnedBy[0]?.note,
        totalPins: message.pinnedBy.length,
        isPinned: true,
        createdAt: message.createdAt,
        pinnedByCurrentUser: !!userPin,
      };
    });

    res.json({
      success: true,
      pinnedMessages: formattedMessages,
      total,
      hasMore: (page - 1) * limit + pinnedMessages.length < total,
      page: parseInt(page),
      totalPages: Math.ceil(total / limit),
      conversation: {
        _id: conversation._id,
        name: conversation.isGroup
          ? conversation.groupName
          : otherParticipantData?.name || "Direct Message",
        isGroup: conversation.isGroup,
        isSpace: false,
      },
      isSpace: false,
    });
  } catch (error) {
    console.error("Get pinned messages error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch pinned messages",
      details: error.message,
    });
  }
};

// ✅ GET ALL PINNED MESSAGES FOR USER (across all conversations)
exports.getAllPinnedMessages = async (req, res) => {
  try {
    const { page = 1, limit = 50 } = req.query;

    // Get all conversations user has access to
    const userConversations = await Conversation.find({
      participants: req.employee._id,
      archivedBy: { $ne: req.employee._id },
      hiddenBy: { $ne: req.employee._id },
    }).select("_id");

    const conversationIds = userConversations.map((conv) => conv._id);

    if (conversationIds.length === 0) {
      return res.json({
        success: true,
        pinnedMessages: [],
        total: 0,
        hasMore: false,
      });
    }

    // Get pinned messages from all user's conversations
    const pinnedMessages = await Message.find({
      conversation: { $in: conversationIds },
      isPinned: true,
    })
      .populate("sender", "name companyEmail avatar photographUrl")
      .populate("pinnedBy.employee", "name companyEmail avatar photographUrl")
      .populate("conversation", "isGroup groupName space participants")
      .sort({ "pinnedBy.pinnedAt": -1 })
      .limit(parseInt(limit))
      .skip((page - 1) * limit);

    const total = await Message.countDocuments({
      conversation: { $in: conversationIds },
      isPinned: true,
    });

    // Format response
    const formattedMessages = pinnedMessages.map((message) => {
      const userPin = message.pinnedBy.find(
        (pin) => pin.employee._id.toString() === req.employee._id.toString()
      );

      // For direct messages, get the other participant
      let conversationName = "Direct Message";
      if (message.conversation.isGroup) {
        conversationName = message.conversation.groupName;
      } else {
        const otherParticipant = message.conversation.participants.find(
          (p) => p.toString() !== req.employee._id.toString()
        );
        // You might want to populate this with actual user data
        conversationName = `Chat with User`;
      }

      return {
        _id: message._id,
        content: message.content,
        messageType: message.messageType,
        attachments: message.attachments || [],
        sender: {
          _id: message.sender._id,
          name: message.sender.name,
          email: message.sender.companyEmail,
          avatar: message.sender.photographUrl || message.sender.avatar,
        },
        conversation: {
          _id: message.conversation._id,
          name: conversationName,
          isGroup: message.conversation.isGroup,
          isSpace: !!message.conversation.space,
        },
        pinnedBy: message.pinnedBy,
        pinnedAt: userPin ? userPin.pinnedAt : message.pinnedBy[0]?.pinnedAt,
        note: userPin ? userPin.note : message.pinnedBy[0]?.note,
        totalPins: message.pinnedBy.length,
        isPinned: true,
        createdAt: message.createdAt,
        pinnedByCurrentUser: !!userPin,
      };
    });

    res.json({
      success: true,
      pinnedMessages: formattedMessages,
      total,
      hasMore: (page - 1) * limit + pinnedMessages.length < total,
      page: parseInt(page),
      totalPages: Math.ceil(total / limit),
    });
  } catch (error) {
    console.error("Get all pinned messages error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch pinned messages",
      details: error.message,
    });
  }
};
// ✅ GET MESSAGES WHERE USER WAS MENTIONED
exports.getMentionedMessages = async (req, res) => {
  try {
    const { page = 1, limit = 50 } = req.query;

    const messages = await Message.find({
      "mentions.employee": req.employee._id,
    })
      .populate("sender", "name companyEmail avatar photographUrl")
      .populate("mentions.employee", "name companyEmail avatar photographUrl")
      .populate("conversation", "isGroup groupName space participants")
      .populate("space", "name description avatar")
      .sort({ createdAt: -1 })
      .limit(parseInt(limit))
      .skip((page - 1) * limit)
      .lean();

    const total = await Message.countDocuments({
      "mentions.employee": req.employee._id,
    });

    // Format response
    const formattedMessages = messages.map((message) => {
      const userMention = message.mentions.find(
        (mention) =>
          mention.employee._id.toString() === req.employee._id.toString()
      );

      // Get conversation name
      let conversationName = "Direct Message";
      if (message.conversation.isGroup) {
        conversationName = message.conversation.groupName;
      } else {
        const otherParticipant = message.conversation.participants.find(
          (p) => p.toString() !== req.employee._id.toString()
        );
        conversationName = `Chat with User`;
      }

      return {
        _id: message._id,
        content: message.content,
        messageType: message.messageType,
        attachments: message.attachments || [],
        sender: {
          _id: message.sender._id,
          name: message.sender.name,
          email: message.sender.companyEmail,
          avatar: message.sender.photographUrl || message.sender.avatar,
        },
        conversation: {
          _id: message.conversation._id,
          name: conversationName,
          isGroup: message.conversation.isGroup,
          isSpace: !!message.conversation.space,
        },
        space: message.space
          ? {
              _id: message.space._id,
              name: message.space.name,
            }
          : null,
        mentionedAt: userMention ? userMention.mentionedAt : null,
        mentionText: userMention ? userMention.mentionText : null,
        createdAt: message.createdAt,
        hasMentions: message.hasMentions,
      };
    });

    res.json({
      success: true,
      messages: formattedMessages,
      total,
      hasMore: (page - 1) * limit + messages.length < total,
      page: parseInt(page),
      totalPages: Math.ceil(total / limit),
    });
  } catch (error) {
    console.error("Get mentioned messages error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch mentioned messages",
      details: error.message,
    });
  }
};

// ✅ GET UNREAD MENTIONS COUNT
exports.getUnreadMentionsCount = async (req, res) => {
  try {
    const count = await Message.countDocuments({
      "mentions.employee": req.employee._id,
      createdAt: {
        $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), // Last 30 days
      },
      // You can add read status logic here if you track read mentions
    });

    res.json({
      success: true,
      unreadMentionsCount: count,
    });
  } catch (error) {
    console.error("Get unread mentions count error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to get unread mentions count",
      details: error.message,
    });
  }
};
exports.getMessageViews = async (req, res) => {
  try {
    const { messageId } = req.params;

    // ✅ PROPER VALIDATION
    if (!mongoose.Types.ObjectId.isValid(messageId)) {
      return res.status(400).json({
        success: false,
        error: "Invalid message ID format",
      });
    }

    const message = await Message.findById(messageId)
      .populate("conversation", "space")
      .populate("viewedBy.employee", "name companyEmail avatar photographUrl");

    if (!message) {
      return res.status(404).json({
        success: false,
        error: "Message not found",
      });
    }

    // Check if it's a space message
    const isSpaceMessage = message.conversation?.space;

    if (!isSpaceMessage) {
      return res.status(400).json({
        success: false,
        error: "View tracking is only available for space messages",
      });
    }

    // Check if user has access to the space
    const space = await Space.findOne({
      _id: message.conversation.space,
      members: req.employee._id,
    });

    if (!space) {
      return res.status(403).json({
        success: false,
        error: "Access denied to this space",
      });
    }

    res.json({
      success: true,
      views: {
        viewCount: message.viewCount || 0,
        viewedBy: message.viewedBy || [],
        currentUserViewed: message.viewedBy.some(
          (view) => view.employee._id.toString() === req.employee._id.toString()
        ),
      },
      isSpaceMessage: true,
    });
  } catch (error) {
    console.error("Get message views error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch message views",
    });
  }
};
// ✅ MUTE CONVERSATION
exports.muteConversation = async (req, res) => {
  try {
    const { conversationId } = req.params;
    const { muteDuration } = req.body; // muteDuration in hours

    if (!mongoose.Types.ObjectId.isValid(conversationId)) {
      return res.status(400).json({
        success: false,
        error: "Invalid conversation ID",
      });
    }

    const conversation = await Conversation.findOne({
      _id: conversationId,
      participants: req.employee._id,
    });

    if (!conversation) {
      return res.status(404).json({
        success: false,
        error: "Conversation not found",
      });
    }

    // Calculate mute expiration time (default 8 hours)
    const muteExpiresAt = new Date(
      Date.now() + (muteDuration || 8) * 60 * 60 * 1000
    );

    // Initialize mutedBy if it doesn't exist
    if (!conversation.mutedBy) {
      conversation.mutedBy = [];
    }

    // Remove existing mute if exists
    conversation.mutedBy = conversation.mutedBy.filter(
      (mute) => mute.employee.toString() !== req.employee._id.toString()
    );

    // Add new mute
    conversation.mutedBy.push({
      employee: req.employee._id,
      mutedAt: new Date(),
      muteExpiresAt: muteExpiresAt,
    });

    await conversation.save();

    // ✅ EMIT SOCKET EVENT FOR MUTE
    const io = req.app.get("io");
    if (io) {
      io.to(`conversation_${conversationId}`).emit("conversation_muted", {
        conversationId,
        mutedBy: req.employee._id,
        muteExpiresAt: muteExpiresAt,
        mutedAt: new Date(),
      });
    }

    res.json({
      success: true,
      message: "Conversation muted successfully",
      muteExpiresAt: muteExpiresAt,
      isMuted: true,
    });
  } catch (error) {
    console.error("Mute conversation error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to mute conversation",
    });
  }
};

// ✅ UNMUTE CONVERSATION
exports.unmuteConversation = async (req, res) => {
  try {
    const { conversationId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(conversationId)) {
      return res.status(400).json({
        success: false,
        error: "Invalid conversation ID",
      });
    }

    const conversation = await Conversation.findOne({
      _id: conversationId,
      participants: req.employee._id,
    });

    if (!conversation) {
      return res.status(404).json({
        success: false,
        error: "Conversation not found",
      });
    }

    // Initialize mutedBy if it doesn't exist
    if (!conversation.mutedBy) {
      conversation.mutedBy = [];
    }

    // Remove user from mutedBy array
    conversation.mutedBy = conversation.mutedBy.filter(
      (mute) => mute.employee.toString() !== req.employee._id.toString()
    );

    await conversation.save();

    // ✅ EMIT SOCKET EVENT FOR UNMUTE
    const io = req.app.get("io");
    if (io) {
      io.to(`conversation_${conversationId}`).emit("conversation_unmuted", {
        conversationId,
        unmutedBy: req.employee._id,
        unmutedAt: new Date(),
      });
    }

    res.json({
      success: true,
      message: "Conversation unmuted successfully",
      isMuted: false,
    });
  } catch (error) {
    console.error("Unmute conversation error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to unmute conversation",
    });
  }
};

// If you have a chat unread count endpoint, it should look like this:
exports.getChatUnreadCount = async (req, res) => {
  try {
    const userId = req.employee._id;

    const unreadCount = await Conversation.aggregate([
      {
        $match: {
          participants: userId,
        },
      },
      {
        $project: {
          unreadForUser: {
            $ifNull: [`$unreadCount.${userId.toString()}`, 0],
          },
        },
      },
      {
        $group: {
          _id: null,
          totalUnread: { $sum: "$unreadForUser" },
        },
      },
    ]);

    const totalUnread = unreadCount.length > 0 ? unreadCount[0].totalUnread : 0;

    res.json({
      success: true,
      data: {
        unreadCount: totalUnread,
      },
    });
  } catch (error) {
    console.error("Error getting chat unread count:", error);
    res.status(500).json({ error: "Server error" });
  }
};
exports.unpinSpace = async (req, res) => {
  try {
    const { spaceId } = req.params;
    const employeeId = req.employee._id;

    if (!mongoose.Types.ObjectId.isValid(spaceId)) {
      return res
        .status(400)
        .json({ success: false, error: "Invalid space ID" });
    }

    const space = await Space.findOne({
      _id: spaceId,
      members: employeeId,
    });

    if (!space) {
      return res.status(403).json({
        success: false,
        error: "Access denied or space not found",
      });
    }

    const unpinned = space.removePin(employeeId);
    if (!unpinned) {
      return res.status(400).json({
        success: false,
        error: "Space not pinned",
      });
    }

    await space.save();

    const io = req.app.get("io");
    io?.to(`space_${spaceId}`).emit("space_unpinned", {
      spaceId,
      unpinnedBy: employeeId,
    });

    res.json({ success: true });
  } catch (err) {
    console.error("Unpin space error:", err);
    res.status(500).json({
      success: false,
      error: "Failed to unpin space",
    });
  }
};
