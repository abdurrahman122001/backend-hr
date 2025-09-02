// backend/src/routes/manager.js
const express = require("express");
const router = express.Router();

const requireEmpAuth = require("../middleware/empAuth");
const managerCtrl = require("../controllers/managerController")
// All routes require employee auth
router.use(requireEmpAuth);

router.get("/roster", managerCtrl.getRoster);
router.post("/assign", managerCtrl.assignClient);

module.exports = router;
