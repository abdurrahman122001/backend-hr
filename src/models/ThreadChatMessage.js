const mongoose = require("mongoose");
const { Schema } = mongoose;

const ThreadChatAttachmentSchema = new Schema(
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

const ThreadChatMessageSchema = new Schema(
  {
    // Reference to the assignment thread
    threadId: {
      type: String,
      required: true,
      index: true,
    },
    
    // Reference to the assignment message (optional - for linking)
    assignmentMessageId: {
      type: Schema.Types.ObjectId,
      ref: "AssignmentMessage",
      required: false,
    },
    
    // Organization scope
    owner: { type: Schema.Types.ObjectId, ref: "User", required: true },
    
    // Client reference (if applicable)
    client: {
      type: Schema.Types.ObjectId,
      ref: "ClientInfo",
      required: false,
    },
    
    // Chat participants
    sender: { 
      type: Schema.Types.ObjectId, 
      ref: "Employee", 
      required: true 
    },
    receiver: [{ 
      type: Schema.Types.ObjectId, 
      ref: "Employee", 
      required: true 
    }],
    
    // Message content
    content: {
      type: String,
      required: true,
    },
    
    // Message type
    messageType: {
      type: String,
      enum: ["text", "file", "system", "reply"],
      default: "text",
    },
    
    // Formatting
    isFormatted: {
      type: Boolean,
      default: false,
    },
    
    // Reply reference
    replyTo: {
      type: Schema.Types.ObjectId,
      ref: "ThreadChatMessage",
      default: null,
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
    attachments: [ThreadChatAttachmentSchema],
    
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
ThreadChatMessageSchema.index({ threadId: 1, createdAt: -1 });
ThreadChatMessageSchema.index({ sender: 1, createdAt: -1 });
ThreadChatMessageSchema.index({ receiver: 1, createdAt: -1 });
ThreadChatMessageSchema.index({ owner: 1, threadId: 1, createdAt: -1 });
ThreadChatMessageSchema.index({ createdAt: -1 });

// Virtual for formatted content
ThreadChatMessageSchema.virtual('formattedContent').get(function() {
  if (this.isFormatted) {
    return this.content;
  }
  return this.content.replace(/</g, '&lt;').replace(/>/g, '&gt;');
});

// Pre-save middleware to ensure receiver is always an array
ThreadChatMessageSchema.pre("save", function (next) {
  if (!this.receiver || this.receiver.length === 0) {
    const error = new Error("At least one receiver is required");
    return next(error);
  }

  if (!Array.isArray(this.receiver)) {
    this.receiver = [this.receiver];
  }

  next();
});

// Method to mark as read
ThreadChatMessageSchema.methods.markAsRead = async function(employeeId) {
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
ThreadChatMessageSchema.methods.addReaction = async function(employeeId, emoji) {
  // Remove existing reaction from same user
  this.reactions = this.reactions.filter(
    reaction => reaction.employee.toString() !== employeeId.toString()
  );
  
  // Add new reaction
  this.reactions.push({
    employee: employeeId,
    emoji: emoji,
    reactedAt: new Date()
  });
  
  await this.save();
  return this;
};

// Method to remove reaction
ThreadChatMessageSchema.methods.removeReaction = async function(employeeId) {
  this.reactions = this.reactions.filter(
    reaction => reaction.employee.toString() !== employeeId.toString()
  );
  
  await this.save();
  return this;
};

// Method to edit message
ThreadChatMessageSchema.methods.edit = async function(newContent, employeeId) {
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

// Static method to get thread participants
ThreadChatMessageSchema.statics.getThreadParticipants = async function(threadId) {
  const messages = await this.find({ threadId })
    .select('sender receiver')
    .populate('sender', '_id name email')
    .populate('receiver', '_id name email')
    .limit(100);
  
  const participants = new Set();
  
  messages.forEach(msg => {
    if (msg.sender) participants.add(msg.sender._id.toString());
    if (msg.receiver && Array.isArray(msg.receiver)) {
      msg.receiver.forEach(receiver => {
        if (receiver) participants.add(receiver._id.toString());
      });
    }
  });
  
  return Array.from(participants);
};

module.exports = mongoose.model("ThreadChatMessage", ThreadChatMessageSchema);