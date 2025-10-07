const express = require('express');
const router = express.Router();
const chatController = require('../controllers/chatController');
const empAuth = require('../middleware/empAuth');
const multer  = require("multer");
const upload = multer({ dest: "uploads/" });      // or configure storage as you like
// Get all conversations for current user
router.get('/conversations', empAuth, chatController.getConversations);

// Get messages for a specific conversation
router.get('/conversations/:conversationId/messages', empAuth, chatController.getMessages);

// Start new conversation or get existing one
router.post('/conversations/start', empAuth, chatController.startConversation);

// Send message to existing conversation
router.post('/conversations/:conversationId/messages', empAuth, chatController.sendMessage);

// Send direct message (creates conversation if needed)
router.post('/messages/direct', empAuth, chatController.sendDirectMessage);

// Mark messages as read
router.put('/conversations/:conversationId/read', empAuth, chatController.markAsRead);

// Get conversation by participant
router.get('/conversations/participant/:participantId', empAuth, chatController.getConversationByParticipant);

// Create new space
router.post('/spaces', empAuth, chatController.createSpace);

// Add members to space
router.post('/spaces/:spaceId/members', empAuth, chatController.addSpaceMembers);

// Send message to space
router.post('/spaces/:spaceId/messages', empAuth, chatController.sendSpaceMessage);

// Get space messages
router.get('/spaces/:spaceId/messages', empAuth, chatController.getSpaceMessages);

// Typing indicators
router.post('/typing', empAuth, chatController.typing);

// Delete message
router.delete('/messages/:messageId', empAuth, chatController.deleteMessage);

module.exports = router;