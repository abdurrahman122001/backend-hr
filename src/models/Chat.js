// models/Chat.js - Updated with pinned messages functionality
const mongoose = require("mongoose");

const messageSchema = new mongoose.Schema(
  {
    conversation: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Conversation",
      required: true,
    },
    sender: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Employee",
      required: true,
    },
    // SINGLE receiver for direct messages - UPDATED
    receiver: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Employee",
      required: function () {
        return !this.space && !this.isGroupMessage; // Receiver required only for direct messages
      },
    },
    // MULTIPLE receivers for group messages
    receivers: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Employee",
      },
    ],
    // Space reference for space messages
    space: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Space",
    },
    // Flag to identify group messages
    isGroupMessage: {
      type: Boolean,
      default: false,
    },
    content: {
      type: String,
      required: false,
    },
    messageType: {
      type: String,
      enum: ["text", "file", "image", "gif", "system"],
      default: "text",
    },
    // Membership log lines ("X was invited by Y", "X joined"). Rendered
    // centred in the thread instead of as a chat bubble. `content` always
    // carries the same sentence in plain text so anything that only reads
    // content (chat list preview, search) still shows something sensible.
    systemEvent: {
      type: {
        type: String,
        enum: ["member_invited", "member_joined"],
      },
      actor: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Employee",
      },
      target: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Employee",
      },
    },
    attachments: [
      {
        filename: String,
        url: String,
        mimetype: String,
        size: Number,
      },
    ],
    reactions: [
      {
        emoji: {
          type: String,
          required: true,
        },
        users: [
          {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Employee",
          },
        ],
        count: {
          type: Number,
          default: 0,
        },
      },
    ],
    mentions: [
      {
        employee: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Employee",
          required: true,
        },
        mentionedAt: {
          type: Date,
          default: Date.now,
        },
        mentionText: String, // The text that was used to mention (e.g., "@john")
      },
    ],
    hasMentions: {
      type: Boolean,
      default: false,
    },
    threadFollowers: [
      {
        employee: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Employee",
          required: true,
        },
        followedAt: {
          type: Date,
          default: Date.now,
        },
      },
    ],
    threadUnfollowers: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Employee",
      },
    ],
    replyTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Message",
    },
    // ✅ ADDED: Forwarded message tracking
    forwarded: {
      type: Boolean,
      default: false,
    },
    forwardedFrom: {
      name: String,
      employee: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Employee",
      },
    },
    readBy: [
      {
        employee: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Employee",
        },
        readAt: {
          type: Date,
          default: Date.now,
        },
      },
    ],
    // For backward compatibility
    read: {
      type: Boolean,
      default: false,
    },
    readAt: Date,
    // ✅ ADDED: Starred messages functionality
    starredBy: [
      {
        employee: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Employee",
          required: true,
        },
        starredAt: {
          type: Date,
          default: Date.now,
        },
      },
    ],
    // ✅ ADDED: Pinned messages functionality
    pinnedBy: [
      {
        employee: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Employee",
          required: true,
        },
        pinnedAt: {
          type: Date,
          default: Date.now,
        },
        note: {
          type: String,
          trim: true,
          maxlength: 200,
        },
      },
    ],
    // For quick checks if message is pinned
    isPinned: {
      type: Boolean,
      default: false,
    },
    // ✅ ADDED: Message editing functionality
    editedAt: {
      type: Date,
    },
    isEdited: {
      type: Boolean,
      default: false,
    },
    // Soft delete: message stays as a "Message deleted by its author" tombstone
    isDeleted: {
      type: Boolean,
      default: false,
    },
    deletedAt: {
      type: Date,
    },
    // ✅ ADDED: View tracking for space messages
    viewCount: {
      type: Number,
      default: 0,
    },
    viewedBy: [
      {
        employee: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Employee",
          required: true,
        },
        viewedAt: {
          type: Date,
          default: Date.now,
        },
      },
    ],
  },
  {
    timestamps: true,
  }
);

// ✅ ADDED: Method to check if message is viewed by a specific employee
messageSchema.methods.isViewedBy = function (employeeId) {
  return this.viewedBy.some(
    (view) => view.employee.toString() === employeeId.toString()
  );
};

// ✅ ADDED: Method to add view for space messages
messageSchema.methods.addView = async function (employeeId) {
  // Only add view if it's a space message and not already viewed by this user
  if ((this.space || this.isGroupMessage) && !this.isViewedBy(employeeId)) {
    this.viewedBy.push({
      employee: employeeId,
      viewedAt: new Date(),
    });
    this.viewCount += 1;
    await this.save();
    return true;
  }
  return false;
};

// Add to Message schema methods
messageSchema.methods.markAsRead = function (userId) {
  // Check if already read by this user
  if (!this.isReadBy(userId)) {
    this.readBy.push({
      employee: userId,
      readAt: new Date(),
    });
    return this.save();
  }
  return Promise.resolve(this);
};

messageSchema.methods.isReadBy = function (userId) {
  return this.readBy.some(
    (read) => read.employee.toString() === userId.toString()
  );
};

messageSchema.methods.getUnreadUsers = function (senderId) {
  const participants = this.conversation?.participants || [];
  const readUserIds = this.readBy.map((read) => read.employee.toString());

  return participants.filter(
    (participantId) =>
      participantId.toString() !== senderId.toString() &&
      !readUserIds.includes(participantId.toString())
  );
};

// ✅ ADDED: Static method to get message views
messageSchema.statics.getMessageViews = async function (messageId, employeeId) {
  const message = await this.findById(messageId)
    .populate("viewedBy.employee", "name companyEmail avatar photographUrl")
    .select("viewCount viewedBy space isGroupMessage");

  if (!message) {
    throw new Error("Message not found");
  }

  const isSpaceMessage = message.space || message.isGroupMessage;
  const currentUserViewed = message.isViewedBy(employeeId);

  return {
    viewCount: message.viewCount,
    viewedBy: message.viewedBy,
    currentUserViewed,
    isSpaceMessage,
  };
};
const conversationSchema = new mongoose.Schema(
  {
    participants: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Employee",
        required: true,
      },
    ],
    lastMessage: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Message",
    },
    unreadCount: {
      type: Map,
      of: Number,
      default: {},
    },
    isGroup: {
      type: Boolean,
      default: false,
    },
    groupName: String,
    groupDescription: String,
    groupAvatar: String,
    admins: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Employee",
      },
    ],
    // Link to Space if this is a space conversation
    space: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Space",
    },
    // Pinned functionality
    pinnedBy: [
      {
        employee: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Employee",
          required: true,
        },
        pinnedAt: {
          type: Date,
          default: Date.now,
        },
      },
    ],
    hiddenBy: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Employee",
      },
    ],
    // Archived functionality
    archivedBy: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Employee",
      },
    ],
    mutedBy: [
      {
        employee: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Employee",
        },
        mutedAt: Date,
        muteExpiresAt: Date,
      },
    ],
  },
  {
    timestamps: true,
  }
);
// Add this to your Conversation schema methods
conversationSchema.methods.isPinnedBy = function (userId) {
  return this.pinnedBy.some(
    (pin) => pin.employee.toString() === userId.toString()
  );
};

// Add this to your Conversation model if not already present
conversationSchema.methods.getUserPin = function (userId) {
  return this.pinnedBy.find(
    (pin) => pin.employee.toString() === userId.toString()
  );
};
conversationSchema.path("mutedBy").default([]);

// Add helper method to check if conversation is muted by a user
conversationSchema.methods.isMutedBy = function (employeeId) {
  if (!this.mutedBy || !Array.isArray(this.mutedBy)) {
    return false;
  }

  const mute = this.mutedBy.find(
    (mute) => mute.employee.toString() === employeeId.toString()
  );

  if (!mute) return false;

  // Check if mute has expired
  if (mute.muteExpiresAt && new Date() > mute.muteExpiresAt) {
    // Remove expired mute
    this.mutedBy = this.mutedBy.filter(
      (m) => m.employee.toString() !== employeeId.toString()
    );
    this.save(); // Save the update
    return false;
  }

  return true;
};
const spaceSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    // "space" (default) or "group" — groups share the exact same behavior
    // (messages, threads, tasks, realtime) but are listed separately in the
    // chat UI for team-internal communication.
    kind: {
      type: String,
      enum: ["space", "group"],
      default: "space",
      index: true,
    },
    description: {
      type: String,
      trim: true,
    },
    avatar: String,
    emoji: {
      type: String,
      default: "💡",
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Employee",
      required: true,
    },
    admins: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Employee",
      },
    ],
    members: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Employee",
        required: true,
      },
    ],
    // Someone added by another member is a full member straight away (so their
    // unread counts, mentions and message access all keep working) but stays
    // listed here until they accept. The invite banner in the conversation is
    // driven off this list, and declining removes them from `members` again.
    // The space creator never gets an entry — they are in by definition.
    pendingInvites: [
      {
        employee: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Employee",
          required: true,
        },
        invitedBy: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Employee",
        },
        invitedAt: {
          type: Date,
          default: Date.now,
        },
      },
    ],
    hiddenBy: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Employee",
      },
    ],
    isPrivate: {
      type: Boolean,
      default: false,
    },
    settings: {
      allowMemberInvites: {
        type: Boolean,
        default: true,
      },
      messagePermissions: {
        type: String,
        enum: ["all", "admins_only"],
        default: "all",
      },
    },
    notificationSettings: [
      {
        employee: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Employee",
          required: true,
        },
        level: {
          type: String,
          enum: ["all", "main", "none"],
          default: "main",
        },
        updatedAt: {
          type: Date,
          default: Date.now,
        },
      },
    ],
    // Pinned functionality for spaces
    pinnedBy: [
      {
        employee: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Employee",
          required: true,
        },
        pinnedAt: {
          type: Date,
          default: Date.now,
        },
      },
    ],
    // Members who hid this space from their own chat list. Hiding is per-user
    // and non-destructive: the space stays intact for everyone else and comes
    // back for the hider on new activity (see sendSpaceMessage).
    hiddenBy: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Employee",
      },
    ],
  },
  {
    timestamps: true,
  }
);

// ============ MESSAGE SCHEMA METHODS ============

// ✅ ADDED: Method to check if message is starred by user
messageSchema.methods.isStarredBy = function (userId) {
  if (!this.starredBy || !Array.isArray(this.starredBy)) {
    return false;
  }
  return this.starredBy.some(
    (star) => star.employee.toString() === userId.toString()
  );
};

// ✅ ADDED: Method to check if message is pinned by user
messageSchema.methods.isPinnedBy = function (userId) {
  if (!this.pinnedBy || !Array.isArray(this.pinnedBy)) {
    return false;
  }
  return this.pinnedBy.some(
    (pin) => pin.employee.toString() === userId.toString()
  );
};

// ✅ ADDED: Method to get pin details for a user
messageSchema.methods.getPinDetails = function (userId) {
  if (!this.pinnedBy || !Array.isArray(this.pinnedBy)) {
    return null;
  }
  return this.pinnedBy.find(
    (pin) => pin.employee.toString() === userId.toString()
  );
};

// ✅ ADDED: Method to add a pin to message
messageSchema.methods.addPin = function (employeeId, note = "") {
  if (!this.pinnedBy) {
    this.pinnedBy = [];
  }

  // Check if already pinned by this user
  if (this.isPinnedBy(employeeId)) {
    return false; // Already pinned
  }

  this.pinnedBy.push({
    employee: employeeId,
    pinnedAt: new Date(),
    note: note,
  });

  this.isPinned = true;
  return true;
};

// ✅ ADDED: Method to remove a pin from message
messageSchema.methods.removePin = function (employeeId) {
  if (!this.pinnedBy || !Array.isArray(this.pinnedBy)) {
    return false;
  }

  const initialLength = this.pinnedBy.length;
  this.pinnedBy = this.pinnedBy.filter(
    (pin) => pin.employee.toString() !== employeeId.toString()
  );

  // Update isPinned flag
  this.isPinned = this.pinnedBy.length > 0;

  return this.pinnedBy.length < initialLength;
};

// ============ CONVERSATION SCHEMA METHODS ============

// Method to check if conversation is pinned by user
conversationSchema.methods.isPinnedBy = function (userId) {
  if (!this.pinnedBy || !Array.isArray(this.pinnedBy)) {
    return false;
  }
  return this.pinnedBy.some(
    (pin) => pin.employee.toString() === userId.toString()
  );
};

// Method to check if conversation is archived by user
conversationSchema.methods.isArchivedBy = function (userId) {
  if (!this.archivedBy || !Array.isArray(this.archivedBy)) {
    return false;
  }
  return this.archivedBy.some(
    (archived) => archived.toString() === userId.toString()
  );
};

// Method to check if conversation is hidden by user
conversationSchema.methods.isHiddenBy = function (userId) {
  if (!this.hiddenBy || !Array.isArray(this.hiddenBy)) {
    return false;
  }
  return this.hiddenBy.some(
    (hidden) => hidden.toString() === userId.toString()
  );
};

// Add to Conversation schema methods
conversationSchema.methods.updateUnreadCount = function (
  senderId,
  increment = true
) {
  this.participants.forEach((participantId) => {
    // Don't increment for the sender
    if (participantId.toString() !== senderId.toString()) {
      const currentCount = this.unreadCount.get(participantId.toString()) || 0;
      const newCount = increment
        ? currentCount + 1
        : Math.max(0, currentCount - 1);
      this.unreadCount.set(participantId.toString(), newCount);
    }
  });
};

conversationSchema.methods.markAsRead = function (userId) {
  // Reset unread count for this user
  this.unreadCount.set(userId.toString(), 0);
  return this.save();
};

conversationSchema.methods.getUnreadCount = function (userId) {
  return this.unreadCount.get(userId.toString()) || 0;
};

// ============ SPACE SCHEMA METHODS ============

// Method to check if space is pinned by user
spaceSchema.methods.isPinnedBy = function (userId) {
  if (!this.pinnedBy || !Array.isArray(this.pinnedBy)) {
    return false;
  }
  return this.pinnedBy.some(
    (pin) => pin.employee.toString() === userId.toString()
  );
};

// ✅ ADD: Pin space for a user
spaceSchema.methods.addPin = function (employeeId) {
  if (!this.pinnedBy) this.pinnedBy = [];

  if (this.isPinnedBy(employeeId)) {
    return false; // already pinned
  }

  this.pinnedBy.push({
    employee: employeeId,
    pinnedAt: new Date(),
  });

  return true;
};

// ✅ ADD: Unpin space for a user
spaceSchema.methods.removePin = function (employeeId) {
  if (!this.pinnedBy || !Array.isArray(this.pinnedBy)) {
    return false;
  }

  const initialLength = this.pinnedBy.length;

  this.pinnedBy = this.pinnedBy.filter(
    (pin) => pin.employee.toString() !== employeeId.toString()
  );

  return this.pinnedBy.length < initialLength;
};

// ============ INDEXES ============

conversationSchema.index({ participants: 1 });
conversationSchema.index({ updatedAt: -1 });
conversationSchema.index({ isGroup: 1 });
conversationSchema.index({ space: 1 });
conversationSchema.index({ "pinnedBy.employee": 1 });

messageSchema.index({ conversation: 1, createdAt: -1 });
messageSchema.index({ sender: 1, createdAt: -1 });
messageSchema.index({ space: 1, createdAt: -1 });
messageSchema.index({ receivers: 1 });
messageSchema.index({ "starredBy.employee": 1 });
messageSchema.index({ "pinnedBy.employee": 1 }); // ✅ ADDED: Index for pinned messages
messageSchema.index({ isPinned: 1 }); // ✅ ADDED: Index for pinned status

messageSchema.index({ "threadFollowers.employee": 1 });
messageSchema.index({ threadUnfollowers: 1 });

spaceSchema.index({ members: 1 });
spaceSchema.index({ createdBy: 1 });
spaceSchema.index({ "pinnedBy.employee": 1 });
spaceSchema.index({ hiddenBy: 1 });
spaceSchema.index({ "notificationSettings.employee": 1, "notificationSettings.level": 1 });

const Message = mongoose.model("Message", messageSchema);
const Conversation = mongoose.model("Conversation", conversationSchema);
const Space = mongoose.model("Space", spaceSchema);

module.exports = { Message, Conversation, Space };
