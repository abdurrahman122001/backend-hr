const express = require("express");
const router = express.Router();
const leaveController = require("../controllers/leaveController");
const UnifiedAuth = require("../middleware/unifiedAuth");

const requireAuth = require("../middleware/auth"); // Make sure this is correct

router.post("/", UnifiedAuth, leaveController.applyLeave);

// Get all leaves (with filters)
router.get("/", UnifiedAuth, leaveController.getLeaves);

// Get leaves pending approval
router.get("/pending", UnifiedAuth, leaveController.getPendingLeaves);
router.get("/my-leaves", UnifiedAuth, leaveController.getMyLeaves); // Add this line

// Get leave statistics
router.get("/stats", UnifiedAuth, leaveController.getLeaveStats);

// NEW ROUTES FOR POLICY-BASED AUTO-DECISION
// Check leave against HR policy
router.post("/check-policy", UnifiedAuth, leaveController.checkLeavePolicy);

// Get HR policy rules for leave
router.get("/policy-rules", UnifiedAuth, leaveController.getLeavePolicyRules);

// Get single leave
router.get("/:id", UnifiedAuth, leaveController.getLeaveById);

// Update leave
router.put("/:id", UnifiedAuth, leaveController.updateLeave);

// Approve leave
router.put("/:id/approve", UnifiedAuth, leaveController.approveLeave);

// Reject leave
router.put("/:id/reject", UnifiedAuth, leaveController.rejectLeave);

// Cancel leave
router.put("/:id/cancel", UnifiedAuth, leaveController.cancelLeave);

// Delete leave (soft delete)
router.delete("/:id", UnifiedAuth, leaveController.deleteLeave);



module.exports = router;