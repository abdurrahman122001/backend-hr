const express = require("express");
const router = express.Router();
const chatController = require("../controllers/chatController");
const empAuth = require("../middleware/empAuth");

// ✅ IMPORTANT: Import multer configuration from chatController
const upload = chatController.upload;

// Search and basic routes
router.get("/search", empAuth, chatController.searchMessages);
// Employee lookup for mentions
router.get("/employees/:userId", empAuth, chatController.getEmployeeForMention);
router.get("/conversations", empAuth, chatController.getConversations);
router.get("/direct-messages", empAuth, chatController.getDirectMessages);
router.get(
  "/space-conversations",
  empAuth,
  chatController.getSpaceConversations
);
router.get("/spaces", empAuth, chatController.getSpaces);
router.get(
  "/conversations/:conversationId/pinned-messages",
  empAuth,
  chatController.getPinnedMessages
);

// Message routes
router.get(
  "/conversations/:conversationId/messages",
  empAuth,
  chatController.getMessages
);
router.post(
  "/messages/:messageId/forward",
  empAuth,
  chatController.forwardMessage
);
router.post("/messages/:messageId/star", empAuth, chatController.starMessage);
router.delete(
  "/messages/:messageId/unstar",
  empAuth,
  chatController.unstarMessage
);
router.get("/messages/starred", empAuth, chatController.getStarredMessages);
router.get(
  "/messages/:messageId/views",
  empAuth,
  chatController.getMessageViews
);

// Message pinning routes
router.post(
  "/conversations/:conversationId/messages/:messageId/pin",
  empAuth,
  chatController.pinMessage
);
router.delete(
  "/conversations/:conversationId/messages/:messageId/unpin",
  empAuth,
  chatController.unpinMessage
);

// ✅ ADDED: Global pinned messages route (across all conversations)
router.get(
  "/pinned-messages/all",
  empAuth,
  chatController.getAllPinnedMessages
);

// ✅ ADDED: Conversation pinning routes
router.post(
  "/conversations/:conversationId/pin",
  empAuth,
  chatController.pinConversation
);
router.delete(
  "/conversations/:conversationId/unpin",
  empAuth,
  chatController.unpinConversation
);
router.get(
  "/conversations/pinned",
  empAuth,
  chatController.getPinnedConversations
);

// Rest of your existing routes...
router.delete(
  "/conversations/:conversationId",
  empAuth,
  chatController.deleteConversation
);
router.post("/conversations/start", empAuth, chatController.startConversation);

router.post(
  "/conversations/:conversationId/messages",
  empAuth,
  upload.array("attachments", 20),
  chatController.sendMessage
);

router.post(
  "/conversations/:conversationId/hide",
  empAuth,
  chatController.hideConversation
);
router.post(
  "/conversations/:conversationId/unhide",
  empAuth,
  chatController.unhideConversation
);
router.get(
  "/conversations/hidden",
  empAuth,
  chatController.getHiddenConversations
);

router.post(
  "/messages/direct",
  empAuth,
  upload.array("attachments", 20),
  chatController.sendDirectMessage
);

router.get("/mentions/messages", empAuth, chatController.getMentionedMessages);
router.get(
  "/mentions/unread-count",
  empAuth,
  chatController.getUnreadMentionsCount
);

// File serving
router.get("/uploads/:filename", chatController.serveFile);

// Read status
router.put(
  "/conversations/:conversationId/read",
  empAuth,
  chatController.markAsRead
);

// Conversation participants
router.get(
  "/conversations/participant/:participantId",
  empAuth,
  chatController.getConversationByParticipant
);
router.get(
  "/conversations/:conversationId/members/simple",
  empAuth,
  chatController.getConversationMembersSimple
);

// Space management
router.post("/spaces", empAuth, chatController.createSpace);
router.delete("/spaces/:spaceId", empAuth, chatController.deleteSpace);
// PIN space
router.post(
  "/spaces/:spaceId/pin",
  empAuth,
  chatController.pinSpace
);

// UNPIN space
router.delete(
  "/spaces/:spaceId/pin",
  empAuth,
  chatController.unpinSpace
);

// Shared content
router.get(
  "/conversations/:conversationId/shared-content",
  empAuth,
  chatController.getSharedContent
);
router.get(
  "/spaces/:spaceId/shared-content",
  empAuth,
  chatController.getSpaceSharedContent
);

// Space members
router.get("/spaces/:spaceId/members", empAuth, chatController.getSpaceMembers);
router.post(
  "/spaces/:spaceId/members",
  empAuth,
  chatController.addSpaceMembers
);
router.delete(
  "/spaces/:spaceId/members/:memberId",
  empAuth,
  chatController.removeSpaceMember
);
router.patch(
  "/spaces/:spaceId/members/:memberId/role",
  empAuth,
  chatController.updateMemberRole
);
router.get(
  "/spaces/:spaceId/search-employees",
  empAuth,
  chatController.searchEmployees
);

// Space details
router.get("/spaces/:spaceId/details", empAuth, chatController.getSpaceDetails);
router.post("/spaces/:spaceId/leave", empAuth, chatController.leaveSpace);
router.post(
  "/spaces/:spaceId/transfer-ownership",
  empAuth,
  chatController.transferSpaceOwnership
);

router.post(
  "/spaces/:spaceId/messages",
  empAuth,
  upload.array("attachments", 20),
  chatController.sendSpaceMessage
);

// Space messages and details
router.get(
  "/spaces/:spaceId/messages",
  empAuth,
  chatController.getSpaceMessages
);
router.put(
  "/spaces/:spaceId/details",
  empAuth,
  chatController.updateSpaceDetails
);

// Typing indicators
router.post("/typing", empAuth, chatController.typing);

// Unread status
router.put(
  "/conversations/:conversationId/unread",
  empAuth,
  chatController.markAsUnread
);
router.put(
  "/spaces/:spaceId/unread",
  empAuth,
  chatController.spaceMarkAsUnread
);
router.put("/spaces/:spaceId/read", empAuth, chatController.spaceMarkAsRead);
// Add to your chat routes
router.post(
  "/conversations/:conversationId/mute",
  empAuth,
  chatController.muteConversation
);
router.post(
  "/conversations/:conversationId/unmute",
  empAuth,
  chatController.unmuteConversation
);
// Block functionality
router.post("/block", empAuth, chatController.blockUser);
router.post("/unblock", empAuth, chatController.unblockUser);
router.get("/blocked-users", empAuth, chatController.getBlockedUsers);
router.get("/block-status/:userId", empAuth, chatController.checkBlockStatus);

// Message operations
router.delete("/messages/:messageId", empAuth, chatController.deleteMessage);
router.post(
  "/messages/:messageId/reactions",
  empAuth,
  chatController.addReaction
);
router.get(
  "/messages/:messageId/reactions",
  empAuth,
  chatController.getMessageReactions
);
router.delete(
  "/messages/:messageId",
  empAuth,
  chatController.deleteSingleMessage
);

router.put(
  "/messages/:messageId",
  empAuth,
  upload.array("files", 20),
  chatController.updateMessage
);

// File upload routes
router.post("/upload", empAuth, chatController.uploadFile);
router.post("/upload-multiple", empAuth, chatController.uploadFiles);
router.get(
  "/conversations/unread/count",
  empAuth,
  chatController.getChatUnreadCount
);

// ── Space tasks (Tasks side-panel) ──────────────────────────────────────────
const chatTaskController = require("../controllers/chatTaskController");
router.get("/spaces/:chatId/tasks", empAuth, chatTaskController.getTasks);
router.post("/spaces/:chatId/tasks", empAuth, chatTaskController.createTask);
router.patch("/tasks/:taskId", empAuth, chatTaskController.updateTask);
router.delete("/tasks/:taskId", empAuth, chatTaskController.deleteTask);
router.get("/tasks/:taskId/comments", empAuth, chatTaskController.getTaskComments);
router.post("/tasks/:taskId/comments", empAuth, chatTaskController.addTaskComment);

module.exports = router;
