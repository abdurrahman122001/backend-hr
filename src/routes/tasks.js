const express = require("express");
const router = express.Router();
const requireAuth = require("../middleware/empAuth");
const ctrl = require("../controllers/tasksController");

// Manager: list all clients under the same owner (for dropdown)
router.get("/manager/clients", requireAuth, ctrl.clientsForManager);

// Manager: create a task for a client
router.post("/", requireAuth, ctrl.createTask);

// Get tasks for a specific client
router.get("/client/:clientId", requireAuth, ctrl.getTasksForClient);

// Employee: my tasks
router.get("/my", requireAuth, ctrl.getMyTasks);

// Update & delete a task
router.patch("/:taskId", requireAuth, ctrl.updateTask);
router.delete("/:taskId", requireAuth, ctrl.deleteTask);

module.exports = router;
