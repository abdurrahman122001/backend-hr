const express = require("express");
const router = express.Router();

const requireEmployeeAuth = require("../middleware/empAuth");
const bugController = require("../controllers/bugController");

// Create new bug
router.post("/create", requireEmployeeAuth, bugController.createBug);

// Fetch bugs
router.get("/", requireEmployeeAuth, bugController.getBugs);

// Resolve bug
router.put("/resolve/:id", requireEmployeeAuth, bugController.resolveBug);
router.patch("/:id/approve", requireEmployeeAuth, bugController.approveBug);
router.patch("/:id/priority", requireEmployeeAuth, bugController.updatePriority);

module.exports = router;
