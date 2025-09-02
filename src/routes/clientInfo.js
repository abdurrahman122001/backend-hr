const express = require("express");
const router = express.Router();
const requireAuth = require("../middleware/empAuth");
const clientInfoCtrl = require("../controllers/clientInfoController");

// Manager creates client info
router.post("/", requireAuth, clientInfoCtrl.createClientInfo);

// Owner or employee (assigned) fetch clients
router.get("/", requireAuth, clientInfoCtrl.getClientInfo);

// Employee only → fetch my assigned clients
router.get("/my", requireAuth, clientInfoCtrl.getMyClients);

module.exports = router;
