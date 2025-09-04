// routes/assignmentMessage.routes.js
const express = require("express");
const router = express.Router();
const empAuth = require("../middleware/empAuth");
const { upload } = require("../utils/multer");
const ctrl = require("../controllers/assignmentMessageController");

// All endpoints require employee token (like your other /api pages)
router.use(empAuth);

router.get("/", ctrl.listMessages);
router.post("/", ctrl.createMessage);

router.get("/:id", ctrl.getMessage);
router.patch("/:id", ctrl.updateMessage);
router.delete("/:id", ctrl.deleteMessage);

router.get("/:id/attachments", ctrl.listAttachments);
router.post(
  "/:id/attachments",
  upload.array("files", 10), // allow up to 10 files
  ctrl.uploadAttachments
);
router.delete("/:id/attachments/:attId", ctrl.deleteAttachment);

module.exports = router;
