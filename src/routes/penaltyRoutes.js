const router = require("express").Router();
const penaltyController = require("../controllers/penaltyController");
const auth = require("../middleware/auth");

router.use(auth);

router.post("/", penaltyController.createPenalty);
router.get("/", penaltyController.getAllPenalties);
router.get("/stats", penaltyController.getPenaltyStats);
router.get("/employee/:employeeId", penaltyController.getEmployeePenalties);
router.put("/:id", penaltyController.updatePenalty);
router.delete("/:id", penaltyController.deletePenalty);

module.exports = router;
