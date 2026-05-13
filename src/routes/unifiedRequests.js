const express = require("express");
const router = express.Router();
const unifiedRequestController = require("../controllers/unifiedRequestController");
const requireAuth = require("../middleware/auth");

// Unified requests route for admin/HR
router.get("/all", requireAuth, unifiedRequestController.getUnifiedToDoList);

module.exports = router;
