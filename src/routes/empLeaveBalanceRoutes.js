const express = require("express");
const router = express.Router();
const empAuth = require("../middleware/empAuth");
const Employee = require("../models/Employees");
const leaveYearBalanceController = require("../controllers/leaveYearBalanceController");

router.get(
  "/my-leave-balance",
  empAuth,
  leaveYearBalanceController.getMyLeaveBalance
);

module.exports = router;
