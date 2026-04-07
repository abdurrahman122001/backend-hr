const express = require("express");
const router  = express.Router();
const auth    = require("../middleware/auth");
const unifiedAuth = require("../middleware/unifiedAuth");
const ctrl    = require("../controllers/salaryslipFieldsController");

router.get("/", unifiedAuth, ctrl.getForLoggedInUser);
router.post("/", auth, ctrl.updateForLoggedInUser);

module.exports = router;
