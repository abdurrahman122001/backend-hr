const express = require("express");
const router = express.Router();
const taxAdjustmentRequestController = require("../controllers/taxAdjustmentRequestController");
const UnifiedAuth = require("../middleware/unifiedAuth");
const { upload } = require("../utils/multer");
const { payrollReviewGuard } = require("../services/payrollRequestHierarchyService");
const TaxAdjustmentRequest = require("../models/TaxAdjustmentRequest");

// Employee routes
router.post("/apply", UnifiedAuth, upload.single("attachment"), taxAdjustmentRequestController.submitTaxAdjustmentRequest);
router.get("/my-requests", UnifiedAuth, taxAdjustmentRequestController.getMyTaxAdjustmentRequests);

// Admin routes
router.get("/all", UnifiedAuth, taxAdjustmentRequestController.getAllTaxAdjustmentRequests);
router.put("/update-status/:id", UnifiedAuth, payrollReviewGuard(TaxAdjustmentRequest), taxAdjustmentRequestController.updateTaxAdjustmentStatus);

module.exports = router;
