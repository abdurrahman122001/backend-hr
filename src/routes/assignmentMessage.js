const express = require("express");
const router = express.Router();
const empAuth = require("../middleware/empAuth");
const { upload } = require("../utils/multer");
const ctrl = require("../controllers/assignmentMessageController");

// ✅ All routes require employee authentication
router.use(empAuth);
router.get("/search", ctrl.searchMessages);
router.get("/count", ctrl.getMessageCounts);

// =============================
// ✅ SPECIFIC ROUTES FIRST (without parameters)
// =============================
router.get("/drafts", ctrl.listDrafts);
router.post("/drafts", ctrl.createDraft);
router.get("/drafts/count", ctrl.getDraftCount);

// Starred messages routes
router.get("/starred", ctrl.getStarredMessages);
router.get("/starred/count", ctrl.getStarredCount);

// Spam and Trash routes
router.get("/trash", ctrl.getTrashMessages);
router.get("/spam", ctrl.getSpamMessages);

// General Message Routes
router.get("/", ctrl.listMessages);
router.post("/", ctrl.createMessage);
router.get("/sent", ctrl.listMySentToClient);
router.get("/review", ctrl.getReviewMessages);

// Manager-Specific Routes
router.get("/manager/messages", ctrl.listMessagesForManager);
router.get("/manager/messages/:clientId", ctrl.listMessagesForManager);
// Scheduled Message Routes
router.get("/scheduled/all", ctrl.getScheduledMessages);
router.get("/client/:clientId/scheduled", ctrl.getScheduledMessagesForClient);

// =============================
// ✅ THREAD-LEVEL ROUTES (specific patterns - must come before generic :id)
// =============================
router.delete("/thread/:threadId", ctrl.deleteThread);
router.delete("/thread/:threadId/permanent", ctrl.permanentlyDeleteThread);
router.patch("/thread/:threadId/trash", ctrl.moveThreadToTrash);
router.patch("/thread/:threadId/restore", ctrl.restoreThreadFromTrash);
router.get("/client/:threadId/threads", ctrl.getClientThreads);

// =============================
// ✅ GENERIC ROUTES WITH :id PARAMETERS
// =============================

// Individual Message CRUD
router.get("/:id", ctrl.getMessage);
router.patch("/:id", ctrl.updateMessage);
router.delete("/:id", ctrl.deleteMessage);

// Star action
router.patch("/:id/star", ctrl.starMessage);

// Spam actions
router.patch("/:id/spam", ctrl.reportSpam);
router.patch("/:id/remove-spam", ctrl.removeFromSpam);

// Trash actions
// router.patch("/:id/trash", ctrl.moveToTrash);
router.delete("/:clientId", ctrl.deleteThread);
router.delete("/:clientId/permanent", ctrl.permanentlyDeleteThread);
router.patch("/:clientId/trash", ctrl.moveThreadToTrash);
router.patch("/:clientId/restore", ctrl.restoreThreadFromTrash);
router.patch("/:id/restore", ctrl.restoreFromTrash);

// Approval Routes
router.patch("/:id/approve", ctrl.approveMessage);
router.patch("/:id/disapprove", ctrl.disapproveMessage);

// Scheduling Actions
router.patch("/:id/schedule", ctrl.scheduleMessage);
router.patch("/:id/unschedule", ctrl.unscheduleMessage);
router.patch("/:id/reschedule", ctrl.rescheduleMessage);
router.patch("/:id/send", ctrl.sendDraft);
router.patch('/:id/edit-disapproved', 
  upload.array('files'),  // Handle file uploads
  ctrl.editDisapprovedMessage
);router.patch("/:id/edit-pending", upload.array("files", 50), ctrl.editPendingMessage);

router.post("/:id/read", ctrl.markAsRead);
router.post("/:id/unread", ctrl.markAsUnread);
router.post("/read-multiple", ctrl.markMultipleAsRead);
router.get("/unread/count", ctrl.getUnreadCount);
router.post("/thread/:threadId/read-all", ctrl.markThreadAsRead);

// In your backend routes file
router.get('/thread/:threadId', ctrl.getMessagesByThread);
// =============================
// ✅ ATTACHMENT ROUTES (keep these last)
// =============================
router.get("/:id/attachments", ctrl.listAttachments);
router.post(
  "/:id/attachments",
  upload.array("files", 50),
  ctrl.uploadAttachments
);
router.delete("/:id/attachments/:attId", ctrl.deleteAttachment);

module.exports = router;