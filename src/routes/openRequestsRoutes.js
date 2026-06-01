const express = require("express");
const router = express.Router();
const controller = require("../controllers/openRequestsController");
const empAuth = require("../middleware/empAuth");

router.get("/", empAuth, controller.getMyOpenRequests);
router.get("/approvals", empAuth, controller.getLeaveApprovals);

module.exports = router;
