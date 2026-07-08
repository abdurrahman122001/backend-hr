const express = require("express");
const router = express.Router();
const requireAuth = require("../middleware/empAuth");
const clientInfoCtrl = require("../controllers/clientInfoController");

// Flat list of all client employees across the clients the logged-in employee
// can see. Backs the WhatsApp group member picker (GET /api/client-employees/all).
router.get("/all", requireAuth, clientInfoCtrl.getAllCompanyEmployees);

module.exports = router;
