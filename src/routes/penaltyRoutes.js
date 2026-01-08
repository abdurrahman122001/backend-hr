const router = require("express").Router();
const penaltyController = require("../controllers/penaltyController");
const auth = require("../middleware/auth");
const empAuth = require("../middleware/empAuth");

router.post("/", auth, penaltyController.createPenalty);
router.get("/", auth, penaltyController.getAllPenalties);
router.get("/stats", auth, penaltyController.getPenaltyStats);
router.get(
  "/employee/:employeeId",
  auth,
  penaltyController.getEmployeePenalties
);
router.put("/:id", auth, penaltyController.updatePenalty);
router.delete("/:id", auth, penaltyController.deletePenalty);
router.get("/me", empAuth, penaltyController.getMyPenalties);

module.exports = router;
