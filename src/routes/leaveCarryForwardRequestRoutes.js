const express = require("express");
const router = express.Router();
const leaveCarryForwardController = require("../controllers/leaveCarryForwardController");
const empAuth = require("../middleware/empAuth");
const unifiedAuth = require("../middleware/unifiedAuth");

router.post("/apply", empAuth, leaveCarryForwardController.applyLeaveCarryForward);
router.get("/my-requests", empAuth, leaveCarryForwardController.getMyRequests);
router.get("/all", unifiedAuth, leaveCarryForwardController.getAllRequests);
router.put("/update-status/:id", unifiedAuth, leaveCarryForwardController.updateStatus);
router.delete("/:id", unifiedAuth, leaveCarryForwardController.deleteRequest);

module.exports = router;