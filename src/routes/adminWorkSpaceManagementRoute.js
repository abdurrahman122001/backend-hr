const router = require("express").Router();
const requireAuth = require("../middleware/auth");
const requireAdmin = require("../middleware/requireAdmin");
const admin = require("../controllers/adminWorkSpaceManagementContoller");

// All workspace/space management is admin-only (company admin or employee-admin)
router.use(requireAuth, requireAdmin);

// Workspace
router.post("/workspace", admin.createWorkspace);
router.get("/workspace", admin.getWorkspaces);
router.put("/workspace/:id", admin.updateWorkspace);
router.delete("/workspace/:id", admin.deleteWorkspace);
router.post("/workspace/member", admin.updateWorkspaceMember);

// Space
router.post("/space", admin.createSpace);
router.get("/space/:workspaceId", admin.getSpaces);
router.put("/space/:id", admin.updateSpace);
router.delete("/space/:id", admin.deleteSpace);
router.post("/space/visibility", admin.updateSpaceVisibility);

// Employees
router.get("/employees", admin.getEmployees);

module.exports = router;
