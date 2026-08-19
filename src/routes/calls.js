const express = require("express");
const router = express.Router();
const requireAuth = require("../middleware/empAuth");
const ctrl = require("../controllers/callLogController");

// Call history for the signed-in employee (optionally with one person).
router.get("/history", requireAuth, ctrl.getCallHistory);
router.post("/history/clear", requireAuth, ctrl.clearCallHistory);
router.get("/missed-count", requireAuth, ctrl.getMissedCount);
router.post("/missed-seen", requireAuth, ctrl.markMissedSeen);

module.exports = router;
