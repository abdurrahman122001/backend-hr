const express = require("express");
const router = express.Router();
const leaveEncashmentController = require("../controllers/leaveEncashmentController");
const empAuth = require("../middleware/empAuth");
const unifiedAuth = require("../middleware/unifiedAuth");
const { payrollReviewGuard } = require("../services/payrollRequestHierarchyService");
const LeaveEncashmentRequest = require("../models/LeaveEncashmentRequest");

router.post("/apply", empAuth, leaveEncashmentController.applyLeaveEncashment);
router.get("/my-requests", empAuth, leaveEncashmentController.getMyRequests);
router.get("/all", unifiedAuth, leaveEncashmentController.getAllRequests);
router.put("/update-status/:id", unifiedAuth, payrollReviewGuard(LeaveEncashmentRequest), leaveEncashmentController.updateStatus);
router.delete("/:id", unifiedAuth, leaveEncashmentController.deleteRequest);

module.exports = router;
