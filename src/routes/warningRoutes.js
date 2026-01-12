// routes/warningRoutes.js
const router = require("express").Router();
const warningController = require("../controllers/warningController");
const auth = require("../middleware/auth");
const {
  checkPermission,
  checkPermissions,
} = require("../middleware/permissions");
const unifiedAuth = require("../middleware/unifiedAuth"); // Changed from auth
router.use(unifiedAuth);

// Warning Configurations
router.post(
  "/config",
  checkPermission("canManageWarningConfig"),
  warningController.createWarningConfig
);

router.get(
  "/config",
  checkPermissions(["canAccessWarnings", "canManageWarningConfig"]),
  warningController.getWarningConfigs
);

router.put(
  "/config/:id",
  checkPermission("canManageWarningConfig"),
  warningController.updateWarningConfig
);

router.delete(
  "/config/:id",
  checkPermission("canManageWarningConfig"),
  warningController.deleteWarningConfig
);

// Employee Warnings
router.post(
  "/",
  checkPermission("canCreateWarnings"),
  warningController.imposeWarning
);

router.get(
  "/",
  checkPermission("canAccessWarnings"),
  warningController.getAllWarnings
);

router.get(
  "/employee/:employeeId",
  checkPermission("canAccessWarnings"),
  warningController.getEmployeeWarnings
);

router.get(
  "/stats",
  checkPermission("canAccessWarnings"),
  warningController.getWarningStats
);

router.put(
  "/:id/resolve",
  checkPermission("canCreateWarnings"),
  warningController.resolveWarning
);

module.exports = router;
