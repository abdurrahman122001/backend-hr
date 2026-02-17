const express = require("express");
const router = express.Router();
const promotionController = require("../controllers/promotionController");
const requireAuth = require("../middleware/auth");

// All promotion routes require authentication
router.use(requireAuth);

// Get all active employees for promotion selection
router.get("/employees", promotionController.getAllEmployeesForPromotion);

// Get specific employee salary details
router.get("/employee/:employeeId/salary", promotionController.getEmployeeSalaryDetails);

// Promote single employee
router.post("/promote", promotionController.promoteEmployee);

// Bulk promote employees
router.post("/bulk-promote", promotionController.bulkPromoteEmployees);

module.exports = router;
