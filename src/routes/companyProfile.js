const express = require("express");
const router = express.Router();
const companyProfileController = require("../controllers/companyProfileController");

// All routes are protected
router.get("/me", companyProfileController.getMyProfile);
router.post("/upsert", companyProfileController.upsertProfile);

module.exports = router;
