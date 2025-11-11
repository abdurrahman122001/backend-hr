const express = require("express");
const router = express.Router();

const { getUpcomingAnniversaries } = require("../controllers/anniversariesController");

// ✅ GET /api/employees/upcoming-anniversaries
router.get(
  "/upcoming-anniversaries",
  getUpcomingAnniversaries
);

module.exports = router;
