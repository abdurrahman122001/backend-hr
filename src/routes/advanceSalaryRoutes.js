const express = require("express");
const router = express.Router();
const advanceSalaryController = require("../controllers/advanceSalaryController");
const UnifiedAuth = require("../middleware/unifiedAuth");

// Employee routes
router.post("/apply", UnifiedAuth, advanceSalaryController.applyAdvanceSalary);
router.get("/my-requests", UnifiedAuth, advanceSalaryController.getMyRequests);

// Admin routes
router.get("/all", UnifiedAuth, advanceSalaryController.getAllRequests);
router.put("/update-status/:id", UnifiedAuth, advanceSalaryController.updateStatus);

module.exports = router;
