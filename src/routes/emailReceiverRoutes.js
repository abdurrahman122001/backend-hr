// routes/emailRoutes.js
const express = require("express");
const router = express.Router();
const emailController = require("../controllers/emailController");
const auth = require("../middleware/empAuth");
// Email receiver management
router.post("/receiver/start", auth, emailController.startEmailReceiver);
router.post("/receiver/stop", auth, emailController.stopEmailReceiver);
router.get("/receiver/status", auth, emailController.getReceiverStatus);
router.post("/receiver/check", auth, emailController.manualCheckEmails);

// Client emails
router.get("/client/:clientId", auth, emailController.getClientEmails);

// Email actions
router.post("/forward", auth, emailController.forwardEmailToTeam);

module.exports = router;