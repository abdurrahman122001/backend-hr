const express = require('express');
const router = express.Router();
const {
  createEvent,
  getAllEvents,
  getEventById,
  updateEvent,
  deleteEvent
} = require('../controllers/eventController');

// Apply requireAuth middleware to all event routes
router.post('/create', createEvent);
router.get('/', getAllEvents);
router.get('/:id', getEventById);
router.put('/:id', updateEvent);
router.delete('/:id', deleteEvent);

module.exports = router;