// routes/assignmentMessage.routes.js
const express = require("express");
const router = express.Router();
const empAuth = require("../middleware/empAuth");
const { upload } = require("../utils/multer");
const ctrl = require("../controllers/assignmentMessageController");

// All endpoints require employee token
router.use(empAuth);

/** Specific paths before any :id */
router.get("/messages", ctrl.listMessagesForManager);
router.get("/messages/:clientId", ctrl.listMessagesForManager);

/** Resource routes */
router.get("/", ctrl.listMessages);
router.post("/", ctrl.createMessage);

router.get("/:id/attachments", ctrl.listAttachments);
router.post("/:id/attachments", upload.array("files", 10), ctrl.uploadAttachments);
router.delete("/:id/attachments/:attId", ctrl.deleteAttachment);

router.get("/:id", ctrl.getMessage);
router.patch("/:id", ctrl.updateMessage);
router.delete("/:id", ctrl.deleteMessage);

module.exports = router;
