const express = require("express");
const router = express.Router();

const requireEmployeeAuth = require("../middleware/empAuth");
const bugController = require("../controllers/bugController");
const { upload } = require("../utils/multer");

// @route   POST /api/bugs/create
// @desc    Create new bug with image upload
// @access  Private (Employee)
router.post(
  "/create",
  requireEmployeeAuth,
  upload.array("images", 10), // Allow up to 5 images
  bugController.createBug
);

// @route   GET /api/bugs
// @desc    Get all bugs (R&D sees all, others see only their own)
// @access  Private (Employee)
router.get("/", requireEmployeeAuth, bugController.getBugs);

// @route   GET /api/bugs/:id
// @desc    Get single bug by ID
// @access  Private (Employee)
router.get("/:id", requireEmployeeAuth, bugController.getBugById);

// REMOVED: Image API route since we're serving statically

// @route   DELETE /api/bugs/:id/images/:imageId
// @desc    Delete specific image from bug
// @access  Private (Employee - Reporter or R&D)
router.delete(
  "/:id/images/:imageId",
  requireEmployeeAuth,
  bugController.deleteImage
);

// @route   PUT /api/bugs/resolve/:id
// @desc    Resolve a bug (reporter directly, R&D requires approval)
// @access  Private (Employee)
router.put("/resolve/:id", requireEmployeeAuth, bugController.resolveBug);

// @route   PATCH /api/bugs/:id/approve
// @desc    Approve bug resolution (reporter only)
// @access  Private (Employee - Reporter)
router.patch("/:id/approve", requireEmployeeAuth, bugController.approveBug);

// @route   PATCH /api/bugs/:id/priority
// @desc    Update bug priority
// @access  Private (Employee - Reporter or R&D)
router.patch("/:id/priority", requireEmployeeAuth, bugController.updatePriority);

// @route   DELETE /api/bugs/:id
// @desc    Delete a bug and its images
// @access  Private (Employee - Reporter or R&D)
router.delete("/:id", requireEmployeeAuth, bugController.deleteBug);

module.exports = router;