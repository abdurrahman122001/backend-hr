const express = require("express");
const router = express.Router();
const commissionController = require("../controllers/commissionController");
const UnifiedAuth = require("../middleware/unifiedAuth");
const { payrollReviewGuard } = require("../services/payrollRequestHierarchyService");
const CommissionRequest = require("../models/CommissionRequest");

// Employee routes
router.post("/apply", UnifiedAuth, commissionController.applyCommission);
router.get("/my-requests", UnifiedAuth, commissionController.getMyRequests);

// Admin routes
router.get("/all", UnifiedAuth, commissionController.getAllRequests);
router.put("/update-status/:id", UnifiedAuth, payrollReviewGuard(CommissionRequest), commissionController.updateStatus);
router.delete("/:id", UnifiedAuth, commissionController.deleteRequest);

module.exports = router;
