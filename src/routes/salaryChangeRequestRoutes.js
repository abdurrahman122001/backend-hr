const express = require("express");
const router = express.Router();
const salaryChangeRequestController = require("../controllers/salaryChangeRequestController");
const UnifiedAuth = require("../middleware/unifiedAuth");
const { payrollReviewGuard } = require("../services/payrollRequestHierarchyService");
const SalaryChangeRequest = require("../models/SalaryChangeRequest");

// Employee routes
router.post("/submit", UnifiedAuth, salaryChangeRequestController.submitSalaryChangeRequest);
router.get("/my-requests", UnifiedAuth, salaryChangeRequestController.getMySalaryChangeRequests);

// Admin routes
router.get("/all", UnifiedAuth, salaryChangeRequestController.getAllSalaryChangeRequests);
router.put("/update-status/:id", UnifiedAuth, payrollReviewGuard(SalaryChangeRequest), salaryChangeRequestController.updateSalaryChangeStatus);

module.exports = router;
