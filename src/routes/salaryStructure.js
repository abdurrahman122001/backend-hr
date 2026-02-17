const express = require("express");
const router = express.Router();
const salaryStructureController = require("../controllers/salaryStructureController");
const requireAuth = require("../middleware/auth");

// All routes require authentication
router.use(requireAuth);

// Get all structures for the owner
router.get("/", salaryStructureController.getAllStructures);

// Get default structure
router.get("/default", salaryStructureController.getDefaultStructure);

// Get single structure by ID
router.get("/:id", salaryStructureController.getStructureById);

// Create or update structure
router.post("/", salaryStructureController.upsertStructure);

// Delete structure
router.delete("/:id", salaryStructureController.deleteStructure);

// Calculate salary breakdown
router.post("/calculate", salaryStructureController.calculateBreakdown);

module.exports = router;
