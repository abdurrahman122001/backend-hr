const express = require("express");
const router = express.Router();
const onboardingController = require("../controllers/onboardingController");

// POST /api/onboarding/request-cnic-cv
router.post("/request-cnic-cv", onboardingController.requestCnicAndCv);

module.exports = router;
