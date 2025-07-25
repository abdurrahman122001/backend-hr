const express = require("express");
const router = express.Router();
const gratCtrl = require("../controllers/gratuitySettingsController");

// Company-wide routes
router.get("/", gratCtrl.getGlobalGratuityDays);
router.post("/", gratCtrl.setGlobalGratuityDays);

// Per-employee routes
router.get("/employee/:employeeId", gratCtrl.getEmployeeGratuityDays);
router.post("/employee/:employeeId", gratCtrl.setEmployeeGratuityDays);

// All employees gratuity data
router.get("/employees", gratCtrl.getAllEmployeesGratuity);

// Decrypt basic salary
router.post("/gross-salary/:empId", gratCtrl.decryptBasicSalary);

module.exports = router;