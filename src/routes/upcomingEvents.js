const express = require('express');
const router = express.Router();

const {
  getUpcomingEventsForEmployee
} = require('../controllers/eventController');

// ✅ Employee — Get upcoming events next 30 days (owner based)
router.get("/", getUpcomingEventsForEmployee);

module.exports = router;
