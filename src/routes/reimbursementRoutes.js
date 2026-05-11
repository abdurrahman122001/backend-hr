const express = require("express");
const router = express.Router();
const reimbursementController = require("../controllers/reimbursementController");
const UnifiedAuth = require("../middleware/unifiedAuth");

// Employee routes
router.post("/apply", UnifiedAuth, reimbursementController.applyReimbursement);
router.get("/my-requests", UnifiedAuth, reimbursementController.getMyRequests);

// Admin routes
router.get("/all", UnifiedAuth, reimbursementController.getAllRequests);
router.put("/update-status/:id", UnifiedAuth, reimbursementController.updateStatus);

module.exports = router;
