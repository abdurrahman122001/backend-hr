const express = require("express");
const router = express.Router();
const shiftCtrl = require("../controllers/employeeShiftController");
const requireAuth = require("../middleware/empAuth");

// Get employee's shift
router.get("/employee/:employeeId", requireAuth, shiftCtrl.getEmployeeShifts);

// Get current employee's shift
router.get("/my-shift", requireAuth, shiftCtrl.getMyShift);

// Get shift by ID
router.get("/:id", requireAuth, shiftCtrl.getShiftById);

// Get all shifts (admin)
router.get("/", requireAuth, shiftCtrl.getAllShifts);

module.exports = router;