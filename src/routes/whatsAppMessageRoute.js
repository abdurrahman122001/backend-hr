const express = require("express");
const router = express.Router();
const empAuth = require("../middleware/empAuth");
const { upload } = require("../utils/multer");
const ctrl = require("../controllers/whatsAppMessageController");
const commentController = require("../controllers/commentController");
const groupCtrl = require("../controllers/whatsAppGroupController");

// All routes require employee authentication
router.use(empAuth);

// ── Per-employee notification preferences (literal path; before /:id) ───────
router.get("/notify-prefs", ctrl.getNotifyPrefs);
router.put("/notify-prefs", ctrl.updateNotifyPrefs);

// ── Group routes (must come BEFORE /:id wildcards) ──────────────────────────
// chatType differentiation: isGroupMessage=true on group messages
router.get("/groups", groupCtrl.getGroups);
router.post("/groups", groupCtrl.createGroup);
router.get("/groups/:groupId", groupCtrl.getGroup);
router.delete("/groups/:groupId", groupCtrl.deleteGroup);
router.post("/groups/:groupId/members", groupCtrl.addMembers);
router.delete("/groups/:groupId/members/:memberId", groupCtrl.removeMember);
router.get("/groups/:groupId/messages", groupCtrl.getGroupMessages);
router.post("/groups/:groupId/messages", groupCtrl.sendGroupMessage);

// List / create / sent etc.
router.get("/", ctrl.listMessages);
router.post("/", ctrl.createMessage);
router.get("/sent", ctrl.listMySentToClient);

router.get("/chat-list", ctrl.getChatList);

// Delete an entire chat (client chat or client-employee sub-chat)
router.delete("/chats/:clientId", ctrl.deleteChat);

router.get("/messages", ctrl.listMessagesForManager);
router.get("/messages/:clientId", ctrl.listMessagesForManager);

router.get("/unread/counts", ctrl.getUnreadCounts);

router.get("/scheduled/all", ctrl.getScheduledMessages);
router.get("/client/:clientId/scheduled", ctrl.getScheduledMessagesForClient);

router.get("/search", ctrl.searchMessages);

router.get("/frequent-emojis", ctrl.getFrequentEmojis);

router.get("/client/:clientId/seen-status", ctrl.getClientMessagesSeenStatus);
router.patch("/client/:clientId/mark-all-seen", ctrl.markAllMessagesAsSeen);

router.get("/:id/attachments", ctrl.listAttachments);
router.post(
  "/:id/attachments",
  upload.array("files", 10),
  ctrl.uploadAttachments
);
router.delete("/:id/attachments/:attId", ctrl.deleteAttachment);

router.patch("/:id/approve", ctrl.approveMessage);
router.patch("/:id/disapprove", ctrl.disapproveMessage);

router.post("/:id/schedule", ctrl.scheduleMessage);
router.post("/:id/unschedule", ctrl.unscheduleMessage);
router.post("/:id/reschedule", ctrl.rescheduleMessage);

router.get("/:id", ctrl.getMessage);
router.patch("/:id", ctrl.updateMessage);
router.patch("/:id/edit", ctrl.editMessage);
router.delete("/:id", ctrl.deleteMessage);
router.patch("/:id/seen", ctrl.markAsSeen);

// Read receipts — which employees have read this message (for the info dialog)
router.get("/:id/seen-by", ctrl.getSeenBy);

router.post("/:messageId/reactions", ctrl.toggleMessageReaction);

router.get(
  "/:messageId/mentionable",
  commentController.getMentionableUsers
);
router.post("/:messageId/comments", commentController.addComment);
router.get("/:messageId/comments", commentController.getComments);
router.put("/:messageId/comments/:commentId", commentController.editComment);
router.delete(
  "/:messageId/comments/:commentId",
  commentController.deleteComment
);
router.post(
  "/:messageId/comments/:commentId/reactions",
  commentController.addReaction
);
router.get("/:messageId/comments/stats", commentController.getCommentStats);

module.exports = router;
