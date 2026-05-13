const express = require("express");
const router = express.Router();
const loanRequestController = require("../controllers/loanRequestController");
const UnifiedAuth = require("../middleware/unifiedAuth");

// Apply for a loan
router.post("/apply", UnifiedAuth, loanRequestController.applyLoan);

// Get my loan requests (for employee)
router.get("/my-requests", UnifiedAuth, loanRequestController.getMyLoanRequests);

// Get all loan requests (for admin/HR)
router.get("/all", UnifiedAuth, loanRequestController.getAllLoanRequests);

// Update status (approve/reject)
router.put("/:id/status", UnifiedAuth, loanRequestController.updateLoanRequestStatus);

// Delete loan request
router.delete("/:id", UnifiedAuth, loanRequestController.deleteLoanRequest);

module.exports = router;
