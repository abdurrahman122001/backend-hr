const mongoose = require("mongoose");
const { Schema } = mongoose;

const AttachmentSchema = new Schema(
  {
    filename: String,
    originalName: String,
    mimetype: String,
    size: Number,
    url: String,
    uploadedAt: { type: Date, default: Date.now },
    uploadedBy: { type: Schema.Types.ObjectId, ref: "Employee" },
  },
  { _id: true },
);

const EditHistorySchema = new Schema(
  {
    previousMessage: String,
    previousSubject: String,
    previousApprovalStatus: {
      type: String,
      enum: ["pending", "approved", "disapproved", null],
    },
    editedAt: { type: Date, default: Date.now },
    editedBy: { type: Schema.Types.ObjectId, ref: "Employee" },
  },
  { _id: true },
);

// New: Comment Schema embedded within WhatsAppMessage
const CommentSchema = new Schema(
  {
    text: {
      type: String,
      required: true,
      trim: true,
    },
    sender: {
      type: Schema.Types.ObjectId,
      ref: "Employee",
      required: true,
    },
    senderName: {
      type: String,
      required: true,
    },
    isEdited: {
      type: Boolean,
      default: false,
    },
    editedAt: {
      type: Date,
    },
    replyTo: {
      type: Schema.Types.ObjectId,
      refPath: "comments._id",
    },
    attachments: [AttachmentSchema],
    mentions: [
      {
        userId: {
          type: Schema.Types.ObjectId,
          ref: "Employee",
        },
        userName: String,
      },
    ],
    reactions: [
      {
        userId: {
          type: Schema.Types.ObjectId,
          ref: "Employee",
        },
        emoji: String,
        createdAt: {
          type: Date,
          default: Date.now,
        },
      },
    ],
  },
  {
    timestamps: true,
    _id: true,
  },
);

const WhatsAppMessageSchema = new Schema(
  {
    owner: { type: Schema.Types.ObjectId, ref: "User", required: true },
    client: { type: Schema.Types.ObjectId, ref: "ClientInfo", default: null },
    sender: { type: Schema.Types.ObjectId, ref: "Employee", required: true },
    receiver: [
      { type: Schema.Types.ObjectId, ref: "Employee", required: true },
    ], // Array of receivers

    subject: { type: String },
    note: { type: String },
    approvalStatus: {
      type: String,
      enum: ["pending", "approved", "disapproved"],
      default: null,
    },
    intendedReceivers: {
      type: [{ type: Schema.Types.ObjectId, ref: "Employee" }],
      default: [],
    },
    isForwarded: { type: Boolean, default: false },
    originalMessage: { type: Schema.Types.ObjectId, ref: "WhatsAppMessage" },
    forwardedBy: { type: Schema.Types.ObjectId, ref: "Employee" },

    approvedBy: { type: Schema.Types.ObjectId, ref: "Employee", default: null },
    approvedAt: { type: Date, default: null },
    disapprovedBy: { type: Schema.Types.ObjectId, ref: "Employee", default: null },
    disapprovedAt: { type: Date, default: null },
    approvalChain: {
      type: [
        {
          approver: { type: Schema.Types.ObjectId, ref: "Employee" },
          approvedAt: { type: Date },
          hierarchyLevel: { type: Number },
          _id: false,
        },
      ],
      default: [],
    },
    // Ordered list of approvers from first to last (set at message creation)
    plannedApprovalChain: {
      type: [{ type: Schema.Types.ObjectId, ref: "Employee" }],
      default: [],
    },

    // Edit tracking fields
    isEdited: { type: Boolean, default: false },
    editedAt: { type: Date },
    editedBy: { type: Schema.Types.ObjectId, ref: "Employee" },
    editHistory: [EditHistorySchema],

    // Scheduling fields
    isScheduled: { type: Boolean, default: false },
    scheduledFor: { type: Date },
    scheduledAt: { type: Date },
    scheduledBy: { type: Schema.Types.ObjectId, ref: "Employee" },
    // 🔥 NEW: Client employee message fields
    isClientEmployeeMessage: {
      type: Boolean,
      default: false,
    },
    clientEmployeeId: {
      type: String,
      default: null,
    },
    clientEmployeeData: {
      type: {
        clientEmployeeId: String,
        clientEmployeeName: String,
        clientEmployeeDesignation: String,
        parentClientId: Schema.Types.ObjectId,
        parentClientName: String,
      },
      default: null,
    },
    // ── Group chat fields ────────────────────────────────────────────────
    /** true when this message belongs to a WhatsApp group (not a direct chat) */
    isGroupMessage: { type: Boolean, default: false },
    /** Reference to WhatsAppGroup document */
    groupId: { type: Schema.Types.ObjectId, ref: "WhatsAppGroup", default: null },
    /**
     * chatType differentiates normal 1-to-1/broadcast messages from group
     * messages so the listMessages query can filter correctly.
     *   "normal" – direct client / client-employee chat
     *   "group"  – group chat message
     */
    chatType: { type: String, enum: ["normal", "group"], default: "normal" },

    // parentClientId stored as a plain string (mirrors isClientEmployeeMessage practice)
    parentClientId: { type: String, default: null },
    // Display name of the selected client/client-employee (set by sender at compose time)
    receiverDisplayName: { type: String, default: null },

    sentAt: { type: Date },
    status: {
      type: String,
      enum: ["draft", "scheduled", "sent", "cancelled"],
      default: "sent",
    },
    seenBy: [
      {
        employee: { type: Schema.Types.ObjectId, ref: "Employee" },
        seenAt: { type: Date, default: Date.now },
      },
    ],
    // @mentions — people referenced with @ in the message text. `refId` is the
    // Employee _id or the client-employee id; `type` distinguishes them.
    mentions: [
      {
        refId: { type: String },
        name: { type: String },
        type: {
          type: String,
          enum: ["employee", "client_employee", "client"],
          default: "employee",
        },
        _id: false,
      },
    ],
    isReply: { type: Boolean, default: false },
    repliedTo: {
      type: Schema.Types.ObjectId,
      ref: "WhatsAppMessage",
      default: null,
    },
    replyContent: {
      type: {
        originalMessage: String,
        originalSender: { type: Schema.Types.ObjectId, ref: "Employee" },
        originalAttachments: [AttachmentSchema],
        preview: String,
      },
      default: null,
    },

    // Files
    attachments: [AttachmentSchema],

    // Delete for Everyone / Delete for Me
    deletedForEveryone: { type: Boolean, default: false },
    deletedAt: { type: Date, default: null },
    deletedForUsers: [
      { type: Schema.Types.ObjectId, ref: "Employee" },
    ],

    // Message-level reactions
    reactions: {
      type: [
        {
          userId: { type: Schema.Types.ObjectId, ref: "Employee", required: true },
          userName: { type: String },
          emoji: { type: String, required: true },
          createdAt: { type: Date, default: Date.now },
        },
      ],
      default: [],
    },

    // NEW: Comments system
    comments: [CommentSchema],
    commentCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    lastCommentAt: {
      type: Date,
    },
    commenters: [
      {
        type: Schema.Types.ObjectId,
        ref: "Employee",
      },
    ],
    lastCommentBy: {
      type: Schema.Types.ObjectId,
      ref: "Employee",
    },
  },
  { timestamps: true },
);

/** Helpful query patterns */
WhatsAppMessageSchema.index({ owner: 1, createdAt: -1 });
// Compound index for getChatList aggregation: owner + status filter + sort by createdAt
WhatsAppMessageSchema.index({ owner: 1, status: 1, createdAt: -1 });
// Receiver-based unread count inside aggregation
WhatsAppMessageSchema.index({ owner: 1, receiver: 1, createdAt: -1 });
// getChatList per-client last-message aggregations: match owner+client, sort by createdAt
WhatsAppMessageSchema.index({ owner: 1, client: 1, createdAt: -1 });
WhatsAppMessageSchema.index({ client: 1, createdAt: -1 });
WhatsAppMessageSchema.index({ sender: 1, createdAt: -1 });
WhatsAppMessageSchema.index({ receiver: 1, createdAt: -1 });
WhatsAppMessageSchema.index({ status: 1, scheduledFor: 1 });
WhatsAppMessageSchema.index({ isScheduled: 1, scheduledFor: 1 });
WhatsAppMessageSchema.index({ approvalStatus: 1, createdAt: -1 });
WhatsAppMessageSchema.index({
  client: 1,
  sender: 1,
  receiver: 1,
  createdAt: -1,
});

// NEW: Indexes for comments
WhatsAppMessageSchema.index({ "comments.sender": 1 });
WhatsAppMessageSchema.index({ "comments.createdAt": -1 });
WhatsAppMessageSchema.index({ commentCount: -1 });
WhatsAppMessageSchema.index({ lastCommentAt: -1 });

// NEW: Virtual for comment replies (nested structure)
CommentSchema.virtual("replies", {
  ref: "WhatsAppMessage.comments",
  localField: "_id",
  foreignField: "replyTo",
  justOne: false,
  match: { replyTo: { $ne: null } },
});

// NEW: Middleware to update comment stats before saving
WhatsAppMessageSchema.pre("save", function (next) {
  // Handle backwards compatibility: ensure comments is at least an empty array
  if (!this.comments || !Array.isArray(this.comments)) {
    this.comments = [];
  }

  if (this.isModified("comments")) {
    this.commentCount = this.comments.length;

    if (this.comments.length > 0) {
      const lastComment = this.comments[this.comments.length - 1];
      this.lastCommentAt = lastComment.createdAt;
      this.lastCommentBy = lastComment.sender;

      // Update unique commenters
      const commenterIds = new Set();
      this.comments.forEach((comment) => {
        commenterIds.add(comment.sender.toString());
      });
      this.commenters = Array.from(commenterIds);
    } else {
      this.lastCommentAt = null;
      this.lastCommentBy = null;
      this.commenters = [];
    }
  }
  next();
});
// NEW: Method to add a comment (FIXED VERSION)
WhatsAppMessageSchema.methods.addComment = async function (
  commentData,
  employee,
) {
  console.log("🔍 Adding comment with employee:", {
    employeeId: employee._id,
    employeeName: employee.name,
    commentText: commentData.text,
  });

  const comment = {
    text: commentData.text,
    sender: employee._id,
    senderName: employee.name,
    replyTo: commentData.replyTo || null,
    attachments: commentData.attachments || [],
    mentions: commentData.mentions || [],
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  console.log("📝 Comment data to add:", comment);

  // Initialize comments array if it doesn't exist
  if (!this.comments) {
    this.comments = [];
  }

  this.comments.push(comment);

  // Update comment statistics
  this.commentCount = this.comments.length;
  this.lastCommentAt = comment.createdAt;
  this.lastCommentBy = employee._id;

  // Add to commenters if not already
  if (!this.commenters) {
    this.commenters = [];
  }

  if (!this.commenters.includes(employee._id)) {
    this.commenters.push(employee._id);
  }

  console.log("✅ Comment added. New stats:", {
    commentCount: this.commentCount,
    commenters: this.commenters,
  });

  await this.save();

  // Return the added comment (populated if possible)
  const addedComment = this.comments[this.comments.length - 1];

  // Try to populate sender info
  try {
    await this.populate({
      path: "comments.sender",
      select: "name email avatar role",
    });
  } catch (error) {
    console.warn("⚠️ Could not populate sender info:", error.message);
  }

  return addedComment;
};

// NEW: Method to edit a comment
WhatsAppMessageSchema.methods.editComment = async function (
  commentId,
  updates,
  employee,
) {
  // Handle case where comments doesn't exist (for old messages before schema update)
  if (!this.comments || !Array.isArray(this.comments)) {
    throw new Error("Comment not found");
  }

  const comment = this.comments.id(commentId);
  if (!comment) {
    throw new Error("Comment not found");
  }

  // Check permissions
  const isAuthor = comment.sender.toString() === employee._id.toString();
  const isTeamLead = employee.role === "team_lead" || employee.role === "admin";

  if (!isAuthor && !isTeamLead) {
    throw new Error("Not authorized to edit this comment");
  }

  // Update comment
  if (updates.text !== undefined) {
    comment.text = updates.text;
    comment.isEdited = true;
    comment.editedAt = new Date();
  }
  if (updates.attachments !== undefined)
    comment.attachments = updates.attachments;
  if (updates.mentions !== undefined) comment.mentions = updates.mentions;

  comment.updatedAt = new Date();

  await this.save();
  return comment;
};

// NEW: Method to delete a comment
WhatsAppMessageSchema.methods.deleteComment = async function (
  commentId,
  employee,
) {
  // Handle case where comments doesn't exist (for old messages before schema update)
  if (!this.comments || !Array.isArray(this.comments)) {
    throw new Error("Comment not found");
  }

  const comment = this.comments.id(commentId);
  if (!comment) {
    throw new Error("Comment not found");
  }

  // Check permissions
  const isAuthor = comment.sender.toString() === employee._id.toString();
  const isTeamLead = employee.role === "team_lead" || employee.role === "admin";

  if (!isAuthor && !isTeamLead) {
    throw new Error("Not authorized to delete this comment");
  }

  // Find and delete all replies to this comment
  const deleteCommentAndReplies = (commentId) => {
    const commentToDelete = this.comments.id(commentId);
    if (commentToDelete) {
      // Find replies
      const replies = this.comments.filter(
        (c) => c.replyTo && c.replyTo.toString() === commentId,
      );

      // Delete replies recursively
      replies.forEach((reply) => {
        deleteCommentAndReplies(reply._id);
      });

      // Delete the comment itself.
      // Mongoose 6+ removed subdoc.remove(); pull from the array instead.
      this.comments.pull(commentId);
    }
  };

  deleteCommentAndReplies(commentId);

  // Recalculate comment stats
  this.commentCount = this.comments.length;

  if (this.comments.length > 0) {
    const lastComment = this.comments[this.comments.length - 1];
    this.lastCommentAt = lastComment.createdAt;
    this.lastCommentBy = lastComment.sender;

    // Recalculate unique commenters
    const commenterIds = new Set();
    this.comments.forEach((c) => {
      commenterIds.add(c.sender.toString());
    });
    this.commenters = Array.from(commenterIds);
  } else {
    this.lastCommentAt = null;
    this.lastCommentBy = null;
    this.commenters = [];
  }

  await this.save();
  return true;
};

// NEW: Method to add reaction to comment
WhatsAppMessageSchema.methods.addReactionToComment = async function (
  commentId,
  emoji,
  employee,
) {
  // Handle case where comments doesn't exist (for old messages before schema update)
  if (!this.comments || !Array.isArray(this.comments)) {
    throw new Error("Comment not found");
  }

  const comment = this.comments.id(commentId);
  if (!comment) {
    throw new Error("Comment not found");
  }

  // Remove existing reaction from same user
  comment.reactions = comment.reactions.filter(
    (reaction) => reaction.userId.toString() !== employee._id.toString(),
  );

  // Add new reaction
  comment.reactions.push({
    userId: employee._id,
    emoji,
    createdAt: new Date(),
  });

  await this.save();
  return comment.reactions;
};

// Toggle emoji reaction on a message — WhatsApp behavior: one reaction per
// user; the same emoji toggles off, a different emoji replaces the previous one
WhatsAppMessageSchema.methods.toggleReaction = async function (emoji, employee) {
  if (!this.reactions) this.reactions = [];

  const myExisting = this.reactions.find(
    (r) => r.userId.toString() === employee._id.toString(),
  );

  this.reactions = this.reactions.filter(
    (r) => r.userId.toString() !== employee._id.toString(),
  );

  if (!myExisting || myExisting.emoji !== emoji) {
    this.reactions.push({
      userId: employee._id,
      userName: employee.name || "",
      emoji,
      createdAt: new Date(),
    });
  }

  await this.save();
  return this.reactions;
};

// NEW: Method to get organized comments (with nested replies)
WhatsAppMessageSchema.methods.getOrganizedComments = function () {
  const commentMap = new Map();
  const rootComments = [];

  // Handle case where comments doesn't exist (for old messages before schema update)
  if (!this.comments || !Array.isArray(this.comments) || this.comments.length === 0) {
    return [];
  }

  // First pass: create map
  this.comments.forEach((comment) => {
    commentMap.set(comment._id.toString(), {
      ...comment.toObject(),
      replies: [],
    });
  });

  // Second pass: build hierarchy
  this.comments.forEach((comment) => {
    const commentObj = commentMap.get(comment._id.toString());

    if (comment.replyTo) {
      const parent = commentMap.get(comment.replyTo.toString());
      if (parent) {
        parent.replies.push(commentObj);
      }
    } else {
      rootComments.push(commentObj);
    }
  });

  return rootComments;
};

module.exports = mongoose.model("WhatsAppMessage", WhatsAppMessageSchema);
