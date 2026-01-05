const router = require("express").Router();
const requireAuth = require("../middleware/auth");
const admin = require("../controllers/adminWorkSpaceManagementContoller");

// Workspace
router.post("/workspace", requireAuth, admin.createWorkspace);
router.get("/workspace", requireAuth, admin.getWorkspaces);
router.put("/workspace/:id", requireAuth, admin.updateWorkspace);
router.delete("/workspace/:id", requireAuth, admin.deleteWorkspace);
router.post("/workspace/member", requireAuth, admin.updateWorkspaceMember);

// Space
router.post("/space", requireAuth, admin.createSpace);
router.get("/space/:workspaceId", requireAuth, admin.getSpaces);
router.put("/space/:id", requireAuth, admin.updateSpace);
router.delete("/space/:id", requireAuth, admin.deleteSpace);
router.post("/space/visibility", requireAuth, admin.updateSpaceVisibility);

// Employees
router.get("/employees", requireAuth, admin.getEmployees);

module.exports = router;
