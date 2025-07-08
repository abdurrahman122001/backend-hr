// backend/src/routes/salarySettings.js
const express = require("express");
const router  = express.Router();
const auth    = require("../middleware/auth");
const ctrl    = require("../controllers/salarySettingsController");

router.get("/", auth, ctrl.getForLoggedInUser);
router.post("/", auth, ctrl.updateForLoggedInUser);

module.exports = router;
