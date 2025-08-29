const router = require("express").Router();
const tax = require("../controllers/taxController");
const auth = require("../middleware/auth");

router.post("/enable", auth, tax.enableTaxForOwner);     // legacy
router.post("/update", auth, tax.updateTaxForOwner);     // NEW (all / selected / disable)
router.get("/owner-slips", auth, tax.getOwnerSlipSummaries);

module.exports = router;
