const express = require("express");
const router = express.Router();
const empAuth = require("../middleware/empAuth");
const { upload } = require("../utils/multer");
const ctrl = require("../controllers/assignmentMessageController");
const filterCtrl = require("../controllers/listAssignmentMessages");
// ✅ All routes require employee authentication
router.use(empAuth);
router.get("/search", filterCtrl.searchMessages);
router.get("/count", filterCtrl.getMessageCounts);
router.get("/external", filterCtrl.getExternalCommunications);
router.get("/pending-approval", filterCtrl.getTeamLeadPendingApprovals);
router.get("/internal", filterCtrl.getInternalCommunications);
// =============================
// ✅ SPECIFIC ROUTES FIRST (without parameters)
// =============================
router.get("/drafts", filterCtrl.listDrafts);
router.post("/drafts", ctrl.createDraft);
router.get("/drafts/count", filterCtrl.getDraftCount);

// Starred messages routes
router.get("/starred", filterCtrl.getStarredMessages);
router.get("/starred/count", filterCtrl.getStarredCount);

// Spam and Trash routes
router.get("/trash", filterCtrl.getTrashMessages);
router.get("/spam", filterCtrl.getSpamMessages);

// General Message Routes
router.get("/", filterCtrl.listMessages);

router.post("/", ctrl.createMessage);
router.get("/sent", ctrl.listMySentToClient);
router.get("/review", filterCtrl.getReviewMessages);

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
router.get("/client/:threadId/threads", filterCtrl.getClientThreads);

// =============================
// ✅ GENERIC ROUTES WITH :id PARAMETERS
// =============================

// Individual Message CRUD
router.get("/:id", filterCtrl.getMessage);
router.patch("/:id", ctrl.updateMessage);
router.delete("/:id", ctrl.deleteMessage);

// Star action
router.patch("/:id/star", filterCtrl.starMessage);

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
router.patch(
  "/:id/edit-disapproved",
  upload.array("files"), // Handle file uploads
  ctrl.editDisapprovedMessage
);
router.patch(
  "/:id/edit-pending",
  upload.array("files", 50),
  ctrl.editPendingMessage
);

router.post("/:id/read", ctrl.markAsRead);
router.post("/:id/unread", ctrl.markAsUnread);
router.post("/read-multiple", ctrl.markMultipleAsRead);
router.get("/unread/count", filterCtrl.getUnreadCount);
router.post("/thread/:threadId/read-all", ctrl.markThreadAsRead);
router.get("/activity", ctrl.getActivity);

// In your backend routes file
router.get("/thread/:threadId", filterCtrl.getMessagesByThread);
// =============================
// ✅ ATTACHMENT ROUTES (keep these last)
// =============================
router.get("/:id/attachments", filterCtrl.listAttachments);
router.post(
  "/:id/attachments",
  upload.array("files", 50),
  ctrl.uploadAttachments
);
router.delete("/:id/attachments/:attId", filterCtrl.deleteAttachment);

module.exports = router;
