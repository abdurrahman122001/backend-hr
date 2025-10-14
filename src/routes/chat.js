const express = require("express");
const router = express.Router();
const chatController = require("../controllers/chatController");
const empAuth = require("../middleware/empAuth");

// Get all conversations for current user
router.get("/conversations", empAuth, chatController.getConversations);
router.get("/direct-messages", empAuth, chatController.getDirectMessages);
router.get(
  "/space-conversations",
  empAuth,
  chatController.getSpaceConversations
);
router.get("/spaces", empAuth, chatController.getSpaces);
// Get messages for a specific conversation
router.get(
  "/conversations/:conversationId/messages",
  empAuth,
  chatController.getMessages
);
// ✅ Delete a conversation
router.delete(
  "/conversations/:conversationId",
  empAuth,
  chatController.deleteConversation
);

// Start new conversation or get existing one
router.post("/conversations/start", empAuth, chatController.startConversation);

// ✅ FIXED: Use chatController's upload middleware for file uploads
router.post(
  "/conversations/:conversationId/messages",
  empAuth,
  chatController.upload.array("attachments", 10),
  chatController.sendMessage
);
// Add these routes to your chat routes
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

// Send direct message (creates conversation if needed)
router.post(
  "/messages/direct",
  empAuth,
  chatController.upload.array("attachments", 10),
  chatController.sendDirectMessage
);

// ✅ FIXED: Serve files from chat-attachments directory
router.get("/uploads/:filename", chatController.serveFile);

// Mark messages as read
router.put(
  "/conversations/:conversationId/read",
  empAuth,
  chatController.markAsRead
);

// Get conversation by participant
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
// Create new space
router.post("/spaces", empAuth, chatController.createSpace);
router.delete("/spaces/:spaceId", empAuth, chatController.deleteSpace);

// Add this route to your chat routes file
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

// Add members to space
router.post(
  "/spaces/:spaceId/members",
  empAuth,
  chatController.addSpaceMembers
);
// Space members management routes
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
// Space details routes
router.get("/spaces/:spaceId/details", empAuth, chatController.getSpaceDetails);
router.post("/spaces/:spaceId/leave", empAuth, chatController.leaveSpace);
router.post(
  "/spaces/:spaceId/transfer-ownership",
  empAuth,
  chatController.transferSpaceOwnership
);
// ✅ FIXED: Use chatController's upload middleware for space file uploads
router.post(
  "/spaces/:spaceId/messages",
  empAuth,
  chatController.upload.array("attachments", 10),
  chatController.sendSpaceMessage
);

// Get space messages
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

// Mark conversation as unread
router.put(
  "/conversations/:conversationId/unread",
  empAuth,
  chatController.markAsUnread
);
// Change to:
router.put(
  "/spaces/:spaceId/unread",
  empAuth,
  chatController.spaceMarkAsUnread
);
router.put("/spaces/:spaceId/read", empAuth, chatController.spaceMarkAsRead);
// Block routes
router.post("/block", empAuth, chatController.blockUser);
router.post("/unblock", empAuth, chatController.unblockUser);
router.get("/blocked-users", empAuth, chatController.getBlockedUsers);
router.get("/block-status/:userId", empAuth, chatController.checkBlockStatus);
// Delete message
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

// Add these routes to your chat routes
router.post(
  "/conversations/:conversationId/pin",
  empAuth,
  chatController.pinConversation
);
router.delete(
  "/conversations/:conversationId/pin",
  empAuth,
  chatController.unpinConversation
);
router.get(
  "/conversations/pinned",
  empAuth,
  chatController.getPinnedConversations
);
module.exports = router;
