// routes/managerRoutes.js
const express = require("express");
const router = express.Router();
const requireAuth = require("../middleware/empAuth");
const { uploadAssignments } = require("../middleware/upload");
const managerCtrl = require("../controllers/managerController");

// Roster (employees + clients for same owner)
router.get("/roster", requireAuth, managerCtrl.getRoster);
router.patch("/:id/supervision", requireAuth, managerCtrl.updateEmployeeSupervision);
// Assign (JSON or multipart). If uploading files, use multipart/form-data with 'files'
router.post(
  "/assign",
  requireAuth,
  (req, res, next) => {
    // Detect multipart by content-type; only call multer when needed to avoid errors with JSON
    const ct = (req.headers["content-type"] || "").toLowerCase();
    if (ct.startsWith("multipart/form-data")) {
      return uploadAssignments.array("files", 10)(req, res, next);
    }
    next();
  },
  managerCtrl.assignClient
);

module.exports = router;
