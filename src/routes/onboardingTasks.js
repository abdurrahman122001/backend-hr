const express = require("express");
const router = express.Router();
const empAuth = require("../middleware/empAuth");
const ctrl = require("../controllers/onboardingTaskController");

router.get("/", empAuth, ctrl.getMyOnboardingTasks);
router.put("/:id/done", empAuth, ctrl.completeOnboardingTask);

module.exports = router;
