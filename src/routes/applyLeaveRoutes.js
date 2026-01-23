const express = require("express");
const router = express.Router();
const leaveController = require("../controllers/leaveController");
const UnifiedAuth = require("../middleware/unifiedAuth");
// All routes are protected
router.get("/debug/auth", UnifiedAuth, (req, res) => {
  console.log("🔐 [Debug] Auth successful for apply-leave route");
  res.json({
    success: true,
    message: "Authentication successful for apply-leave routes",
    user: {
      id: req.user.id,
      employeeId: req.user.employeeId,
      role: req.user.role,
      name: req.user.name,
      isEmployee: req.user.isEmployee,
      isAdmin: req.user.isAdmin,
    },
    route: "/api/apply-leave",
    timestamp: new Date().toISOString(),
  });
});

// Apply for leave
router.post("/", UnifiedAuth, leaveController.applyLeave);

// Get all leaves (with filters)
router.get("/", UnifiedAuth, leaveController.getLeaves);

// Get leaves pending approval
router.get("/pending", UnifiedAuth, leaveController.getPendingLeaves);

// Get leave statistics
router.get("/stats", UnifiedAuth, leaveController.getLeaveStats);

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