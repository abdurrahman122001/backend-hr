const mongoose = require("mongoose");
const { Schema } = mongoose;

const ChatThreadAttachmentSchema = new Schema(
  {
    filename: String,
    originalName: String,
    mimetype: String,
    size: Number,
    url: String,
    uploadedAt: { type: Date, default: Date.now },
    uploadedBy: { type: Schema.Types.ObjectId, ref: "Employee" },
  },
  { _id: true }
);

const ChatThreadSchema = new Schema(
  {
    // Reference to the main message that started this thread
    parentMessageId: {
      type: Schema.Types.ObjectId,
      ref: "Message",
      required: true,
      index: true,
    },
    
    // Organization scope (from parent message)
    owner: { type: Schema.Types.ObjectId, ref: "User", required: true },
    
    // Sender of the reply
    sender: {
      type: Schema.Types.ObjectId,
      ref: "Employee",
      required: true
    },

    // Quote-reply to another reply in the same thread (like main chat).
    replyTo: {
      type: Schema.Types.ObjectId,
      ref: "ChatThread",
      default: null,
    },
    
    // Message content
    content: {
      type: String,
      required: true,
    },
    
    // Message type
    messageType: {
      type: String,
      enum: ["text", "file", "image", "gif", "audio"],
      default: "text",
    },
    
    // Read status
    readBy: [{
      employee: { type: Schema.Types.ObjectId, ref: "Employee", required: true },
      readAt: { type: Date, default: Date.now }
    }],
    
    // Reactions
    reactions: [{
      employee: { type: Schema.Types.ObjectId, ref: "Employee" },
      emoji: String,
      reactedAt: { type: Date, default: Date.now }
    }],
    
    // Attachments
    attachments: [ChatThreadAttachmentSchema],

    // Mentions
    mentions: [
      {
        employee: { type: Schema.Types.ObjectId, ref: "Employee" },
        mentionedAt: { type: Date, default: Date.now },
        mentionText: String,
      },
    ],

    // GIF URL if applicable
    gifUrl: String,
    
    // Deletion status
    isDeleted: {
      type: Boolean,
      default: false,
    },
    deletedBy: { type: Schema.Types.ObjectId, ref: "Employee" },
    deletedAt: Date,
    
    // Edit history
    isEdited: {
      type: Boolean,
      default: false,
    },
    editedAt: Date,
    editHistory: [{
      content: String,
      editedAt: Date,
      editedBy: { type: Schema.Types.ObjectId, ref: "Employee" }
    }],
  },
  { timestamps: true }
);

// Indexes for efficient querying
ChatThreadSchema.index({ parentMessageId: 1, createdAt: 1 });
ChatThreadSchema.index({ sender: 1, createdAt: -1 });

// Method to mark as read
ChatThreadSchema.methods.markAsRead = async function(employeeId) {
  const alreadyRead = this.readBy.some(read => 
    read.employee.toString() === employeeId.toString()
  );
  
  if (!alreadyRead) {
    this.readBy.push({
      employee: employeeId,
      readAt: new Date()
    });
    await this.save();
  }
  return this;
};

// Method to add reaction
ChatThreadSchema.methods.addReaction = async function(employeeId, emoji) {
  // Check if this exact reaction already exists for this user
  const existingIndex = this.reactions.findIndex(
    r => r.employee.toString() === employeeId.toString() && r.emoji === emoji
  );

  if (existingIndex > -1) {
    // If it exists, remove it (toggle off)
    this.reactions.splice(existingIndex, 1);
  } else {
    // If it doesn't exist, remove any OTHER emoji this user might have (one emoji per user)
    this.reactions = this.reactions.filter(
      r => r.employee.toString() !== employeeId.toString()
    );
    
    // Add new reaction
    this.reactions.push({
      employee: employeeId,
      emoji: emoji,
      reactedAt: new Date()
    });
  }
  
  await this.save();
  return this;
};

// Method to remove reaction
ChatThreadSchema.methods.removeReaction = async function(employeeId) {
  this.reactions = this.reactions.filter(
    reaction => reaction.employee.toString() !== employeeId.toString()
  );
  
  await this.save();
  return this;
};

// Method to edit message
ChatThreadSchema.methods.edit = async function(newContent, employeeId) {
  // Save current content to edit history
  this.editHistory.push({
    content: this.content,
    editedAt: new Date(),
    editedBy: employeeId
  });
  
  // Update content
  this.content = newContent;
  this.isEdited = true;
  this.editedAt = new Date();
  
  await this.save();
  return this;
};

module.exports = mongoose.model("ChatThread", ChatThreadSchema);
