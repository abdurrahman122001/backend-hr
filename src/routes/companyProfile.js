const express = require("express");
const router = express.Router();
const companyProfileController = require("../controllers/companyProfileController");
const requireAuth = require("../middleware/auth"); // Your JWT/auth middleware

// All routes are protected
router.get("/me", requireAuth, companyProfileController.getMyProfile);
router.post("/upsert", requireAuth, companyProfileController.upsertProfile);

module.exports = router;
