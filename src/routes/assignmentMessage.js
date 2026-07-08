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
// Normal employees can also draft email — the "from" (on-behalf-of-client)
// field is hidden from non-CRM users in ComposeDialog instead of gating here.
router.post("/drafts", ctrl.createDraft);
router.get("/drafts/count", filterCtrl.getDraftCount);

// Starred messages routes
router.get("/starred", filterCtrl.getStarredMessages);
router.get("/starred/count", filterCtrl.getStarredCount);

// Spam and Trash routes
router.get("/trash", filterCtrl.getTrashMessages);
router.get("/spam", filterCtrl.getSpamMessages);

// Supervision routes (messages from team members to supervisor)
router.get("/supervision", filterCtrl.getSupervisionMessages);

// General Message Routes
router.get("/has-juniors", filterCtrl.hasJuniors);
router.get("/my-juniors", filterCtrl.getMyJuniors);
router.get("/", filterCtrl.listMessages);

// Normal employees can create/send email (normal approval flow). The
// "from" (on-behalf-of-client) field is hidden from non-CRM users in the UI.
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
router.post("/thread/:threadId/read-all", ctrl.markThreadAsRead);
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

// Approval Routes — hierarchy/senior approval flow (controller authorizes)
router.patch("/:id/approve", ctrl.approveMessage);
router.patch("/:id/disapprove", ctrl.disapproveMessage);

// Scheduling Actions — normal employees may schedule their own messages
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
// Read receipts — which employees have read this message (for the "Read by" dialog)
router.get("/:id/read-by", ctrl.getReadBy);
// Lightweight approval-chain payload for the "Message Info" stepper
router.get("/:id/approval-info", ctrl.getApprovalInfo);
router.post("/:id/unread", ctrl.markAsUnread);
router.post("/read-multiple", ctrl.markMultipleAsRead);
router.post("/read-all", ctrl.markAllMessagesRead);
router.get("/unread/count", filterCtrl.getUnreadCount);
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
