const express = require("express");
const router = express.Router();
const { enableTaxForOwner } = require("../controllers/taxController");
const requireAuth = require("../middleware/auth"); // your existing auth middleware

// Secure route — auto uses req.user._id
router.post("/enable", requireAuth, enableTaxForOwner);

module.exports = router;
