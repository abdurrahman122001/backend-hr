const express = require("express");
const router = express.Router();
const requireAuth = require("../middleware/auth"); // must set req.user._id or req.req_id
const ctrl = require("../controllers/offerEmailController");

router.use(requireAuth);

// Template CRUD (simple)
router.get("/", ctrl.getTemplate);
router.post("/", ctrl.saveTemplate);

// Optional: fetch latest generated content per candidate
router.get("/latest", ctrl.getLatestGenerated);

module.exports = router;
