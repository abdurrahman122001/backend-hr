const express = require("express");
const router = express.Router();
const chatThreadController = require("../controllers/chatThreadController");
const empAuth = require("../middleware/empAuth");

// All routes require employee authentication
router.use(empAuth);

/**
 * @route   POST /api/chat-threads
 * @desc    Create a new thread reply
 */
router.post("/", chatThreadController.createThreadReply);

/**
 * @route   GET /api/chat-threads/recent/active
 * @desc    Get recently active threads
 */
router.get("/recent/active", chatThreadController.getRecentActiveThreads);

/**
 * @route   GET /api/chat-threads/:parentMessageId
 * @desc    Get all replies for a thread
 */
router.get("/:parentMessageId", chatThreadController.getThreadReplies);

/**
 * @route   PATCH /api/chat-threads/:id
 * @desc    Edit a thread reply
 */
router.patch("/:id", chatThreadController.editThreadReply);

/**
 * @route   DELETE /api/chat-threads/:id
 * @desc    Delete a thread reply
 */
router.delete("/:id", chatThreadController.deleteThreadReply);

/**
 * @route   POST /api/chat-threads/:id/reactions
 * @desc    Add reaction to a reply
 */
router.post("/:id/reactions", chatThreadController.addReactionToReply);

module.exports = router;
