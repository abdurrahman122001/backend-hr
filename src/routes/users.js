// backend/src/routes/users.js
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { getMe, updateMe } = require('../controllers/userController');
const router = express.Router();

router.get('/me',    requireAuth, getMe);
router.put('/me',    requireAuth, updateMe);

module.exports = router;
