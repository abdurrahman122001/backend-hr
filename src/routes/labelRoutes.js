const express = require("express");
const router = express.Router();
const emailLabelController = require("../controllers/emailLabelController");
const empAuth = require("../middleware/empAuth");

// All routes require authentication
router.use(empAuth);

// Label CRUD operations
router.get("/", emailLabelController.getLabels);
router.post("/", emailLabelController.createLabel);
router.put("/:id", emailLabelController.updateLabel);
router.delete("/:id", emailLabelController.deleteLabel);

// Label color management
router.patch("/:id/color", emailLabelController.updateLabelColor);

// Label reordering
router.patch("/reorder", emailLabelController.reorderLabels);

// Apply/remove labels to messages
router.post("/:id/apply", emailLabelController.applyLabelToMessages);
router.post("/:id/remove", emailLabelController.removeLabelFromMessages);

// Get messages with specific label
router.get("/:id/messages", emailLabelController.getMessagesByLabel);

// Get label statistics
router.get("/:id/count", emailLabelController.getLabelStatistics);

module.exports = router;