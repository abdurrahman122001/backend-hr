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
// router.get("/self", requireAuth, ctrl.getSelfTasks); // 🔥 new endpoint (only my assigned tasks)

// Update & delete a task
router.patch("/:taskId", requireAuth, ctrl.updateTask);
router.delete("/:taskId", requireAuth, ctrl.deleteTask);
router.get("/:taskId/attachments", requireAuth, ctrl.listAttachments);
router.post("/:taskId/attachments", requireAuth, ctrl.uploadAttachments); // multipart
router.delete("/:taskId/attachments/:attachmentId", requireAuth, ctrl.deleteAttachment);
module.exports = router;
