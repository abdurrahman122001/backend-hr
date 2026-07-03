const express = require("express");
const router = express.Router();
const ctrl = require("../controllers/overtimeRequestController");
const empAuth = require("../middleware/empAuth");
const unifiedAuth = require("../middleware/unifiedAuth");

// Employee routes
router.post("/apply", empAuth, ctrl.applyOvertimeRequest);
router.get("/my-requests", empAuth, ctrl.getMyRequests);
router.get("/eligible-days", empAuth, ctrl.getEligibleEarlyDays);

// Admin / HR routes
router.get("/all", unifiedAuth, ctrl.getAllRequests);
router.put("/update-status/:id", unifiedAuth, ctrl.updateStatus);
router.delete("/:id", unifiedAuth, ctrl.deleteRequest);

module.exports = router;
