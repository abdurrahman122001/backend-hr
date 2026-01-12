// routes/penaltyRoutes.js
const router = require("express").Router();
const penaltyController = require("../controllers/penaltyController");
const auth = require("../middleware/auth");
const { checkPermission, checkPermissions } = require("../middleware/permissions");
const unifiedAuth = require("../middleware/unifiedAuth"); // Changed from auth

router.use(unifiedAuth);
// All routes require specific permissions
router.post("/", 
  checkPermission("canCreatePenalties"), 
  penaltyController.createPenalty
);

router.get("/", 
  checkPermission("canAccessPenalties"), 
  penaltyController.getAllPenalties
);

router.get("/stats", 
  checkPermission("canAccessPenalties"), 
  penaltyController.getPenaltyStats
);

router.put("/:id", 
  checkPermission("canApprovePenalties"), 
  penaltyController.updatePenalty
);

router.delete("/:id", 
  checkPermission("canApprovePenalties"), 
  penaltyController.deletePenalty
);

router.get("/employee/:employeeId", 
  checkPermission("canAccessPenalties"), 
  penaltyController.getEmployeePenalties
);

router.get("/my-penalties", 
  penaltyController.getMyPenalties
);

module.exports = router;