const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema({
  conversation: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Conversation',
    required: true
  },
  sender: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Employee',
    required: true
  },
  // SINGLE receiver for direct messages - UPDATED
  receiver: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Employee',
    required: function() {
      return !this.space && !this.isGroupMessage; // Receiver required only for direct messages
    }
  },
  // MULTIPLE receivers for group messages
  receivers: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Employee'
  }],
  // Space reference for space messages
  space: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Space'
  },
  // Flag to identify group messages
  isGroupMessage: {
    type: Boolean,
    default: false
  },
  content: {
    type: String,
    required: false,
    trim: true
  },
  messageType: {
    type: String,
    enum: ['text', 'file', 'image', 'gif'],
    default: 'text'
  },
  attachments: [{
    filename: String,
    url: String,
    mimetype: String,
    size: Number
  }],
  readBy: [{
    employee: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Employee'
    },
    readAt: {
      type: Date,
      default: Date.now
    }
  }],
  // For backward compatibility
  read: {
    type: Boolean,
    default: false
  },
  readAt: Date
}, {
  timestamps: true
});

const conversationSchema = new mongoose.Schema({
  participants: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Employee',
    required: true
  }],
  lastMessage: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Message'
  },
  unreadCount: {
    type: Map,
    of: Number,
    default: {}
  },
  isGroup: {
    type: Boolean,
    default: false
  },
  groupName: String,
  groupDescription: String,
  groupAvatar: String,
  admins: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Employee'
  }],
  // Link to Space if this is a space conversation
  space: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Space'
  }
}, {
  timestamps: true
});

const spaceSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  description: {
    type: String,
    trim: true
  },
  avatar: String,
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Employee',
    required: true
  },
  admins: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Employee'
  }],
  members: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Employee',
    required: true
  }],
  isPrivate: {
    type: Boolean,
    default: false
  },
  settings: {
    allowMemberInvites: {
      type: Boolean,
      default: true
    },
    messagePermissions: {
      type: String,
      enum: ['all', 'admins_only'],
      default: 'all'
    }
  }
}, {
  timestamps: true
});

// Indexes
conversationSchema.index({ participants: 1 });
conversationSchema.index({ updatedAt: -1 });
conversationSchema.index({ isGroup: 1 });
conversationSchema.index({ space: 1 });
messageSchema.index({ conversation: 1, createdAt: -1 });
messageSchema.index({ sender: 1, createdAt: -1 });
messageSchema.index({ space: 1, createdAt: -1 });
messageSchema.index({ receivers: 1 });
spaceSchema.index({ members: 1 });
spaceSchema.index({ createdBy: 1 });

const Message = mongoose.model('Message', messageSchema);
const Conversation = mongoose.model('Conversation', conversationSchema);
const Space = mongoose.model('Space', spaceSchema);

module.exports = { Message, Conversation, Space };