// backend/src/controllers/userController.js
const User = require('../models/Users'); // <--- Correct way!
const bcrypt = require('bcrypt');

exports.createUser = async (req, res) => {
  try {
    const { username, email, password, role } = req.body;
    if (!username || !email || !password || !role)
      return res.status(400).json({ error: 'All fields required' });
    if (!['admin', 'hr'].includes(role))
      return res.status(400).json({ error: 'Invalid role' });

    // DIRECTLY use req.user._id for createdBy
    const createdBy = req.user._id;

    const hash = await bcrypt.hash(password, 10);
    const user = await User.create({ username, email, password: hash, role, createdBy });
    res.json({ success: true, user: { ...user.toObject(), password: undefined } });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

exports.getMe = async (req,res) => {
  // req.user is set by your requireAuth middleware
  const { username, email, timeZone, tzMode } = req.user;
  res.json({ username, email, timeZone, tzMode });
};

exports.updateMe = async (req,res) => {
  const { timeZone, tzMode } = req.body;
  if (tzMode==='manual' && !timeZone)
    return res.status(400).json({ error:'manual mode requires timeZone' });
  req.user.timeZone = timeZone || req.user.timeZone;
  req.user.tzMode   = tzMode;
  await req.user.save();
  res.json({ timeZone: req.user.timeZone, tzMode: req.user.tzMode });
};
