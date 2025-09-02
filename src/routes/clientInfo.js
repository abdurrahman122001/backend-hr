const express = require("express");
const router = express.Router();
const requireAuth = require("../middleware/empAuth");
const ctrl = require("../controllers/clientInfoController");

// All routes need auth
router.use(requireAuth);

// Manager creates client info
router.post("/", ctrl.createClientInfo);

// Owner fetches their client info
router.get("/my", ctrl.getClientInfoByOwner);

module.exports = router;
