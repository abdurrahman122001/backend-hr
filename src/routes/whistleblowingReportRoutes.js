const express = require("express");
const router = express.Router();
const controller = require("../controllers/whistleblowingReportController");
const empAuth = require("../middleware/empAuth");
const unifiedAuth = require("../middleware/unifiedAuth");

// Employee routes
router.post("/apply", empAuth, controller.applyReport);
router.get("/my-requests", empAuth, controller.getMyReports);

// Admin routes
router.get("/all", unifiedAuth, controller.getAllReports);
router.put("/update-status/:id", unifiedAuth, controller.updateStatus);
router.delete("/:id", unifiedAuth, controller.deleteReport);

module.exports = router;
