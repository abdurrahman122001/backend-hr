const express = require("express");
const router = express.Router();
const empAuth = require("../middleware/empAuth");
const { upload } = require("../utils/multer");
const ctrl = require("../controllers/assignmentMessageController");

// ✅ All routes require employee authentication
router.use(empAuth);

// =============================
// Draft Routes
// =============================
router.get("/drafts", ctrl.listDrafts);
router.post("/drafts", ctrl.createDraft);
router.get("/drafts/count", ctrl.getDraftCount);
// Starred messages routes
router.get("/starred", ctrl.getStarredMessages);
router.patch("/:id/star", ctrl.starMessage);
router.get("/starred/count", ctrl.getStarredCount);

// =============================
// General Message Routes
// =============================
router.get("/", ctrl.listMessages);
router.post("/", ctrl.createMessage);
router.get("/sent", ctrl.listMySentToClient);
router.get("/review", ctrl.getReviewMessages);

// =============================
// Manager-Specific Routes
// =============================
router.get("/manager/messages", ctrl.listMessagesForManager);
router.get("/manager/messages/:clientId", ctrl.listMessagesForManager);

// =============================
// Scheduled Message Routes
// =============================
router.get("/scheduled/all", ctrl.getScheduledMessages);
router.get("/client/:clientId/scheduled", ctrl.getScheduledMessagesForClient);

// =============================
// Attachment Routes
// =============================
router.get("/:id/attachments", ctrl.listAttachments);
router.post(
  "/:id/attachments",
  upload.array("files", 10),
  ctrl.uploadAttachments
);
router.delete("/:id/attachments/:attId", ctrl.deleteAttachment);

// =============================
// Approval Routes
// =============================
router.patch("/:id/approve", ctrl.approveMessage);
router.patch("/:id/disapprove", ctrl.disapproveMessage);

// =============================
// Scheduling Actions
// =============================
router.post("/:id/schedule", ctrl.scheduleMessage);
router.post("/:id/unschedule", ctrl.unscheduleMessage);
router.post("/:id/reschedule", ctrl.rescheduleMessage);

// =============================
// Individual Message CRUD
// =============================
router.get("/:id", ctrl.getMessage);
router.patch("/:id", ctrl.updateMessage);
router.delete("/:id", ctrl.deleteMessage);

// Add to routes:
router.get("/trash", ctrl.getTrashMessages);
// Thread deletion routes
router.delete("/:clientId", ctrl.deleteThread);
router.delete("/:clientId/permanent", ctrl.permanentlyDeleteThread);
router.patch("/:clientId/trash", ctrl.moveThreadToTrash);
router.patch("/:clientId/restore", ctrl.restoreThreadFromTrash);

module.exports = router;
