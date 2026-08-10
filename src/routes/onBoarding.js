const express = require("express");
const router = express.Router();
const onboardingController = require("../controllers/onboardingController");

// POST /api/onboarding/request-cnic-cv
router.post("/request-cnic-cv", onboardingController.requestCnicAndCv);

// GET /api/onboarding/:employeeId/log — the candidate's onboarding timeline
// (what was sent, when, and whether it went out).
router.get("/:employeeId/log", onboardingController.getOnboardingLog);

module.exports = router;
