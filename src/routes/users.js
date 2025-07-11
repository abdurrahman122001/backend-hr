const express = require("express");
const router = express.Router();
const { getMe, updateMe, getProfile, updateProfile } = require('../controllers/userController');

router.get('/me', getMe);
router.put('/me', updateMe);
router.get('/profile', getProfile);
router.put('/profile', updateProfile);

module.exports = router;
