// backend/src/routes/auth.js
const express = require('express');
const jwt     = require('jsonwebtoken');
const User    = require('../models/Users');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET;

// ————— Sign-up —————
router.post('/signup', async (req, res) => {
  try {
    const { username, email, password } = req.body;
    // basic validation
    if (!username || !email || !password) {
      return res.status(400).json({ error: 'username, email and password are required' });
    }
    // create & hash via your pre('save') hook
    const newUser = new User({ username, email, password });
    await newUser.save();

    // generate token immediately so the user is logged-in on signup
    const token = jwt.sign({ id: newUser._id }, JWT_SECRET, { expiresIn: '2h' });
    res.status(201).json({
      token,
      user: { id: newUser._id, username: newUser.username }
    });
  } catch (err) {
    // handle duplicate‐key errors
    if (err.code === 11000) {
      return res.status(409).json({ error: 'Username or email already taken' });
    }
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/login', async (req, res) => {
    const { username, password } = req.body;
  try {
    const user = await User.findOne({ username });
    if (!user || !(await user.comparePassword(password))) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const token = jwt.sign({ id: user._id }, JWT_SECRET, { expiresIn: '2h' });
    res.json({ token, user: { id: user._id, username: user.username } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
