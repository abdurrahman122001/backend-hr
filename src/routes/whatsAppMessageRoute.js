const express = require("express");
const router = express.Router();
const empAuth = require("../middleware/empAuth");
const { upload } = require("../utils/multer");
const ctrl = require("../controllers/whatsAppMessageController");

// All routes require employee authentication
router.use(empAuth);

// List / create / sent etc.
router.get("/", ctrl.listMessages);
router.post("/", ctrl.createMessage);
router.get("/sent", ctrl.listMySentToClient);

// Manager-specific
router.get("/messages", ctrl.listMessagesForManager);
router.get("/messages/:clientId", ctrl.listMessagesForManager);

// Scheduled routes
router.get("/scheduled/all", ctrl.getScheduledMessages);
router.get("/client/:clientId/scheduled", ctrl.getScheduledMessagesForClient);

// Attachments
router.get("/:id/attachments", ctrl.listAttachments);
router.post(
  "/:id/attachments",
  upload.array("files", 10),
  ctrl.uploadAttachments
);
router.delete("/:id/attachments/:attId", ctrl.deleteAttachment);

// Approvals
router.patch("/:id/approve", ctrl.approveMessage);
router.patch("/:id/disapprove", ctrl.disapproveMessage);

// Scheduling actions
router.post("/:id/schedule", ctrl.scheduleMessage);
router.post("/:id/unschedule", ctrl.unscheduleMessage);
router.post("/:id/reschedule", ctrl.rescheduleMessage);

// Individual message CRUD
router.get("/:id", ctrl.getMessage);
router.patch("/:id", ctrl.updateMessage);
router.patch("/:id/edit", ctrl.editMessage); // Enhanced edit endpoint with approval workflow
router.delete("/:id", ctrl.deleteMessage);
router.patch("/:id/seen", ctrl.markAsSeen);
router.get("/unread/counts", ctrl.getUnreadCounts);
router.get("/client/:clientId/seen-status", ctrl.getClientMessagesSeenStatus);
router.patch("/client/:clientId/mark-all-seen", ctrl.markAllMessagesAsSeen);

module.exports = router;