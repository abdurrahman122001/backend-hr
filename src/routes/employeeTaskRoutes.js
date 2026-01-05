// routes/employeeTaskRoutes.js
const express = require("express");
const router = express.Router();

const empAuth = require("../middleware/empAuth");
const controller = require("../controllers/employeeTaskController");

/* =========================
   EMPLOYEE TASK ROUTES
========================= */

// Get all workspaces for the employee
router.get("/workspaces", empAuth, controller.getMyWorkspaces);

// Get all spaces within a workspace
router.get("/spaces/:workspaceId", empAuth, controller.getMySpaces);

// Get all tasks within a space
router.get("/tasks/:spaceId", empAuth, controller.getMyTasks);

// Create a new task
router.post("/tasks", empAuth, controller.createTask);

// Update task assignee
router.patch("/tasks/:taskId/assign", empAuth, controller.updateTaskAssignee);

// Update task details (status, title, description, priority, dueDate)
router.patch("/tasks/:taskId", empAuth, controller.updateTask);

// Delete a task
router.delete("/tasks/:taskId", empAuth, controller.deleteTask);

// Get all employees who have access to a space
router.get("/employees/:spaceId", empAuth, controller.getEmployeesForSpace);

// Get task statistics for a space (new endpoint)
router.get("/stats/:spaceId", empAuth, controller.getTaskStats);

// Create a new space (new endpoint)
router.post("/spaces", empAuth, controller.createSpace);

module.exports = router;