// routes/managerRoutes.js
const express = require("express");
const router = express.Router();
const requireAuth = require("../middleware/empAuth");
const { uploadAssignments } = require("../middleware/upload");
const managerCtrl = require("../controllers/managerController");
const clientCtrl = require("../controllers/clientInfoController");

// Roster (employees + clients for same owner)
router.get("/roster", requireAuth, managerCtrl.getRoster);
router.get("/employee/roster", requireAuth, managerCtrl.getEmployeeRoster);
router.get("/employee/mentions", requireAuth, managerCtrl.getMentionedEmployees);
router.patch("/:id/supervision", requireAuth, managerCtrl.updateEmployeeSupervision);
router.get(
  "/employee/:id/supervision-status",
  requireAuth,
  managerCtrl.getEmployeeSupervisionStatus
);
// Client side supervision 
router.patch(
  "/client/:id/supervision",
  requireAuth,
  clientCtrl.updateClientSupervision
);

router.patch(
  "/employee/:employeeId/supervision-all",
  requireAuth,
  clientCtrl.updateAllClientSupervisionForEmployee
);


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

// Assign team members to a single business of a client (contacts panel).
router.post("/assign-business", requireAuth, managerCtrl.assignBusiness);

module.exports = router;
