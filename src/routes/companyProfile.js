const express = require("express");
const router = express.Router();
const companyProfileController = require("../controllers/companyProfileController");
const { upload } = require("../utils/multer");

// All routes are protected
router.get("/me", companyProfileController.getMyProfile);
router.post("/upsert", upload.single("logo"), companyProfileController.upsertProfile);

module.exports = router;
