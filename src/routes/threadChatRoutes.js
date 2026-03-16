const express = require("express");
const router = express.Router();
const threadChatController = require("../controllers/threadChatController");
const { upload } = require("../utils/multer");
const empAuth = require("../middleware/empAuth");
// Middleware to verify authentication

// Apply auth middleware to all routes
router.use(empAuth);

// Create a new thread chat message
router.post("/messages", empAuth, threadChatController.createThreadChatMessage);

// Get messages for a thread
router.get("/threads/:threadId/messages", empAuth, threadChatController.getThreadMessages);

// Get thread info
router.get("/threads/:threadId/info", empAuth, threadChatController.getThreadInfo);

// Get unread count
router.get("/threads/:threadId/unread-count", empAuth, threadChatController.getUnreadCount);

// Edit a message
router.patch("/messages/:id/edit", empAuth, threadChatController.editMessage);

// Delete a message (soft delete)
router.delete("/messages/:id", empAuth, threadChatController.deleteMessage);

// Add reaction to message
router.post("/messages/:id/reactions", empAuth, threadChatController.addReaction);

// Remove reaction from message
router.delete("/messages/:id/reactions", empAuth, threadChatController.removeReaction);

// Upload attachments to thread
router.post(
  "/threads/:threadId/attachments",
  upload.array("files", 10), // Max 10 files
  empAuth,
  threadChatController.uploadAttachments,
  
);

// Get thread participants
router.get("/threads/:threadId/participants", empAuth, threadChatController.getThreadParticipants);

// Mark thread as read
router.post("/threads/:threadId/read", empAuth, threadChatController.markThreadAsRead);

// Search in thread
router.get("/threads/:threadId/search", empAuth, threadChatController.searchInThread);

// Get thread statistics
router.get("/threads/:threadId/stats", empAuth, threadChatController.getThreadStats);

module.exports = router;