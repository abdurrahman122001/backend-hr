const express = require("express");
const router = express.Router();
const gratCtrl = require("../controllers/gratuitySettingsController");

// Company-wide
router.get("/", gratCtrl.getGlobalGratuityDays);
router.post("/", gratCtrl.setGlobalGratuityDays);

// Per-employee
router.get("/employee/:employeeId", gratCtrl.getEmployeeGratuityDays);
router.post("/employee/:employeeId", gratCtrl.setEmployeeGratuityDays);

module.exports = router;
