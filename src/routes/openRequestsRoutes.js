const express = require("express");
const router = express.Router();
const controller = require("../controllers/openRequestsController");
const empAuth = require("../middleware/empAuth");

router.get("/", empAuth, controller.getMyOpenRequests);
router.get("/approvals", empAuth, controller.getLeaveApprovals);
router.put("/edit/:type/:id", empAuth, controller.editPayrollRequest);
router.put("/withdraw/:type/:id", empAuth, controller.withdrawPayrollRequest);

module.exports = router;
