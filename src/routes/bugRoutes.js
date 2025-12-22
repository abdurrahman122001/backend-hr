// routes/bugRoutes.js
const express = require("express");
const router = express.Router();

const requireEmployeeAuth = require("../middleware/empAuth");
const bugController = require("../controllers/bugController");
const { upload } = require("../utils/multer");
const requireAuth = require("../middleware/auth"); // Make sure this is correct

// @route   POST /api/bugs/create
// @desc    Create new bug with image upload
// @access  Private (Employee)
router.post(
  "/create",
  requireEmployeeAuth,
  upload.array("images", 10), // Allow up to 10 images
  bugController.createBug
);

// @route   GET /api/bugs
// @desc    Get all bugs with filtering options
// @access  Private (Employee/Owner/Admin)
router.get("/", requireEmployeeAuth, bugController.getBugs);

// @route   GET /api/bugs/owner
// @desc    Get bugs reported by employees owned by current user
// @access  Private (Owner)
router.get("/owner", requireAuth, bugController.getBugsByOwner);

// @route   GET /api/bugs/owner/dashboard
// @desc    Get owner dashboard with statistics
// @access  Private (Owner)
router.get("/owner/dashboard", requireEmployeeAuth, bugController.getOwnerDashboard);

// @route   GET /api/bugs/:id
// @desc    Get single bug by ID
// @access  Private (Employee/Owner/Admin)
router.get("/:id", requireEmployeeAuth, bugController.getBugById);

// @route   PUT /api/bugs/:id
// @desc    Update bug (title, description, priority, add new images)
// @access  Private (Employee/Owner/Admin)
router.put(
  "/:id",
  requireEmployeeAuth,
  upload.array("images", 10),
  bugController.updateBug
);

// @route   DELETE /api/bugs/:id/images/:imageId
// @desc    Delete specific image from bug
// @access  Private (Employee/Owner/Admin)
router.delete(
  "/:id/images/:imageId",
  requireEmployeeAuth,
  bugController.deleteImage
);

// @route   PUT /api/bugs/resolve/:id
// @desc    Resolve a bug (reporter directly, R&D requires approval, Owner can resolve)
// @access  Private (Employee/Owner/Admin)
router.put("/resolve/:id", requireEmployeeAuth, bugController.resolveBug);

// @route   PATCH /api/bugs/:id/approve
// @desc    Approve bug resolution (reporter only)
// @access  Private (Employee - Reporter)
router.patch("/:id/approve", requireEmployeeAuth, bugController.approveBug);

// @route   PATCH /api/bugs/:id/priority
// @desc    Update bug priority
// @access  Private (Employee/Owner/Admin)
router.patch("/:id/priority", requireEmployeeAuth, bugController.updatePriority);

// @route   DELETE /api/bugs/:id
// @desc    Delete a bug and its images
// @access  Private (Employee/Owner/Admin)
router.delete("/:id", requireEmployeeAuth, bugController.deleteBug);

// @route   GET /api/bugs/balance/my
// @desc    Get current employee's balance
// @access  Private (Employee)
router.get("/balance/my", requireEmployeeAuth, bugController.getEmployeeBalance);

// @route   PATCH /api/bugs/balance/:employeeId
// @desc    Update employee's balance (Owner/Admin/R&D only)
// @access  Private (Owner/Admin/R&D)
router.patch("/balance/:employeeId", requireEmployeeAuth, bugController.updateEmployeeBalance);

// @route   GET /api/bugs/balance/all
// @desc    Get all employees' balances with permissions
// @access  Private (Employee/Owner/Admin)
router.get("/balance/all", requireEmployeeAuth, bugController.getAllEmployeeBalances);

module.exports = router;