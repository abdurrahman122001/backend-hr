const express = require("express");
const router = express.Router();
const ctrl = require("../controllers/probationLeaveApprovalController");

// Get all approvals (query ?status=pending|approved|rejected|extended|all)
router.get("/", ctrl.getPendingApprovals);

// Get stats
router.get("/stats", ctrl.getApprovalStats);

// Get single approval
router.get("/:id", ctrl.getApprovalById);

// Approve leave credit
router.put("/:id/approve", ctrl.approveLeaveCredit);

// Reject leave credit
router.put("/:id/reject", ctrl.rejectLeaveCredit);

// Extend probation
router.put("/:id/extend", ctrl.extendProbation);

module.exports = router;
