const express = require("express");
const router = express.Router();
const requireAuth = require("../middleware/empAuth");
const clientInfoCtrl = require("../controllers/clientInfoController");
const { upload } = require("../utils/multer");
// Add to your routes

// Manager/Team Lead creates client info
router.post("/", requireAuth, clientInfoCtrl.createClientInfo);

// Fetch client info (based on role: Owner, Manager/Team Lead, or Employee)
router.get("/", requireAuth, clientInfoCtrl.getClientInfo);

// Fetch only the logged-in employee's assigned clients
router.get("/my", requireAuth, clientInfoCtrl.getMyClients);

// Update specific client info (Owner/Manager/Team Lead/Assigned Employee)
router.put("/:id", requireAuth, clientInfoCtrl.updateClientInfo);
// Partial update — used by CRM for toggling isActive and other field-level patches
router.patch("/:id", requireAuth, clientInfoCtrl.updateClientInfo);

// Delete specific client info (Owner/Manager/Team Lead/Creator)
router.delete("/:id", requireAuth, clientInfoCtrl.deleteClientInfo);

router.get("/has-new-clients", requireAuth, clientInfoCtrl.hasNewClients);
router.post("/:id/read", requireAuth, clientInfoCtrl.markClientRead);
// Get client by ID
router.get("/:id", requireAuth, clientInfoCtrl.getClientById);

router.get("/search/client-by-email", requireAuth, clientInfoCtrl.searchClientByEmail);
router.get(
  "/search/client-by-name",
  requireAuth,
  clientInfoCtrl.searchClientByName
);
router.get("/search/company-employee-by-email", requireAuth, clientInfoCtrl.searchCompanyEmployeeByEmail);
router.get(
  "/search/team-members",
  requireAuth,
  clientInfoCtrl.searchTeamMembers
);
// Manage company employees
router.post("/:id/company-employees", requireAuth, clientInfoCtrl.addCompanyEmployee);
router.delete("/:id/company-employees/:employeeIndex", requireAuth, clientInfoCtrl.removeCompanyEmployee);
router.put("/:id/company-employees/:employeeIndex", requireAuth, clientInfoCtrl.updateCompanyEmployee);

// Photo uploads
router.post("/:id/upload-photo", requireAuth, upload.single("photo"), clientInfoCtrl.uploadClientPhoto);
router.post("/:id/company-employees/:employeeIndex/upload-photo", requireAuth, upload.single("photo"), clientInfoCtrl.uploadCompanyEmployeePhoto);

// WhatsApp flags
router.patch(
    "/:id/toggle-whatsapp/:flag", requireAuth, clientInfoCtrl.toggleWhatsAppFlag
);
router.get("/:id/whatsapp-flags", requireAuth, clientInfoCtrl.getWhatsAppFlags);

module.exports = router;