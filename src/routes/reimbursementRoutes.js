const express = require("express");
const router = express.Router();
const reimbursementController = require("../controllers/reimbursementController");
const UnifiedAuth = require("../middleware/unifiedAuth");
const { payrollReviewGuard } = require("../services/payrollRequestHierarchyService");
const ReimbursementRequest = require("../models/ReimbursementRequest");

const { upload } = require("../utils/multer");

// Employee routes
router.post("/apply", UnifiedAuth, upload.single("receipt"), reimbursementController.applyReimbursement);
router.get("/my-requests", UnifiedAuth, reimbursementController.getMyRequests);

// Admin routes
router.get("/all", UnifiedAuth, reimbursementController.getAllRequests);
router.put("/update-status/:id", UnifiedAuth, payrollReviewGuard(ReimbursementRequest), reimbursementController.updateStatus);

module.exports = router;
