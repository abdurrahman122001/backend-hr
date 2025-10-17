const express = require("express");
const router = express.Router();
const requireAuth = require("../middleware/empAuth");
const clientInfoCtrl = require("../controllers/clientInfoController");

// Manager/Team Lead creates client info
router.post("/", requireAuth, clientInfoCtrl.createClientInfo);

// Fetch client info (based on role: Owner, Manager/Team Lead, or Employee)
router.get("/", requireAuth, clientInfoCtrl.getClientInfo);

// Fetch only the logged-in employee's assigned clients
router.get("/my", requireAuth, clientInfoCtrl.getMyClients);

// Update specific client info (Owner/Manager/Team Lead/Assigned Employee)
router.put("/:id", requireAuth, clientInfoCtrl.updateClientInfo);

// Delete specific client info (Owner/Manager/Team Lead/Creator)
router.delete("/:id", requireAuth, clientInfoCtrl.deleteClientInfo);

router.get("/:id", requireAuth, clientInfoCtrl.getClientById);

module.exports = router;
