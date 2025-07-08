const express = require("express");
const router = express.Router();
const requireAuth = require("../middleware/auth"); // your authentication middleware
const ctrl = require("../controllers/probationPeriodController");

router.use(requireAuth);

router.post("/", ctrl.createProbationPeriod);
router.get("/", ctrl.getProbationPeriods);
router.get("/:id", ctrl.getProbationPeriod);
router.put("/:id", ctrl.updateProbationPeriod);
router.delete("/:id", ctrl.deleteProbationPeriod);

module.exports = router;
