// routes/assignmentMessage.routes.js
const express = require("express");
const router = express.Router();
const empAuth = require("../middleware/empAuth");
const { upload } = require("../utils/multer");
const ctrl = require("../controllers/assignmentMessageController");

// Middleware to ensure all routes require employee authentication
router.use(empAuth);

/** Manager-specific message routes */
router.get("/messages", ctrl.listMessagesForManager); // List messages for managers with optional filters
router.get("/messages/:clientId", ctrl.listMessagesForManager); // List messages for a specific client

/** General message routes */
router.get("/", ctrl.listMessages); // List messages with filters (owner, client, sender, receiver, etc.)
router.post("/", ctrl.createMessage); // Create a new message, auto-assigns receivers based on role if needed
router.get("/sent", ctrl.listMySentToClient); // List messages sent by the current user to a specific client

/** Attachment routes */
router.get("/:id/attachments", ctrl.listAttachments); // List attachments for a specific message
router.post(
  "/:id/attachments",
  upload.array("files", 10), // Supports up to 10 files per upload
  ctrl.uploadAttachments
); // Upload attachments to a message
router.delete("/:id/attachments/:attId", ctrl.deleteAttachment); // Delete a specific attachment

/** Message approval routes */
router.patch("/:id/approve", ctrl.approveMessage); // Approve a message and forward to managers
router.patch("/:id/disapprove", ctrl.disapproveMessage); // Disapprove a message

/** Individual message routes */
router.get("/:id", ctrl.getMessage); // Get a specific message by ID
router.patch("/:id", ctrl.updateMessage); // Update a message's subject or note
router.delete("/:id", ctrl.deleteMessage); // Delete a message

module.exports = router;