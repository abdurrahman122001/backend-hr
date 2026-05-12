const express = require("express");
const router = express.Router();
const salaryChangeRequestController = require("../controllers/salaryChangeRequestController");
const UnifiedAuth = require("../middleware/unifiedAuth");

// Employee routes
router.post("/submit", UnifiedAuth, salaryChangeRequestController.submitSalaryChangeRequest);
router.get("/my-requests", UnifiedAuth, salaryChangeRequestController.getMySalaryChangeRequests);

// Admin routes
router.get("/all", UnifiedAuth, salaryChangeRequestController.getAllSalaryChangeRequests);
router.put("/update-status/:id", UnifiedAuth, salaryChangeRequestController.updateSalaryChangeStatus);

module.exports = router;
