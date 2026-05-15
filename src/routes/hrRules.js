const express = require("express");
const router = express.Router();
const hrRulesController = require("../controllers/hrRulesController");

// Get HR rules
router.get("/", hrRulesController.getHrRules);

// Create or update HR rules
router.post("/", hrRulesController.updateHrRules);
router.put("/", hrRulesController.updateHrRules); // Support both POST and PUT for upsert

// Delete HR rules
router.delete("/", hrRulesController.deleteHrRules);

module.exports = router;
