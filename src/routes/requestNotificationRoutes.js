const express = require("express");
const router = express.Router();
const UnifiedAuth = require("../middleware/unifiedAuth");
const requestNotificationController = require("../controllers/requestNotificationController");

router.get("/", UnifiedAuth, requestNotificationController.listNotifications);
router.patch("/read", UnifiedAuth, requestNotificationController.markNotificationsRead);
router.delete("/", UnifiedAuth, requestNotificationController.clearNotifications);

module.exports = router;
