const User = require('../models/Users');
const bcrypt = require('bcrypt');

// Create user (for admin/hr - not public signup)
exports.createUser = async (req, res) => {
  try {
    const { username, email, password, role } = req.body;
    if (!username || !email || !password || !role)
      return res.status(400).json({ error: 'All fields required' });

    if (!['admin', 'hr'].includes(role))
      return res.status(400).json({ error: 'Invalid role' });

    // Set who created this user (e.g., admin)
    const createdBy = req.user?._id || null;

    // Password hash (you can rely on pre-save, but this is fine too)
    const hash = await bcrypt.hash(password, 10);
    const user = await User.create({ username, email, password: hash, role, createdBy });

    const userObj = user.toObject();
    delete userObj.password;
    res.json({ success: true, user: userObj });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

// GET /api/users/me
exports.getMe = async (req, res) => {
  const { username, email, role, timeZone, tzMode, _id } = req.user;
  res.json({ _id, username, email, role, timeZone, tzMode });
};

// PUT /api/users/me
exports.updateMe = async (req, res) => {
  const { timeZone, tzMode } = req.body;
  if (tzMode === 'manual' && !timeZone)
    return res.status(400).json({ error: 'Manual mode requires timeZone' });

  req.user.timeZone = timeZone || req.user.timeZone;
  req.user.tzMode = tzMode || req.user.tzMode;
  await req.user.save();

  res.json({ timeZone: req.user.timeZone, tzMode: req.user.tzMode });
};

// GET /api/users/profile
exports.getProfile = async (req, res) => {
  const user = await User.findById(req.user._id).lean();
  if (!user) return res.status(404).json({ error: "User not found" });

  // Never send password hash!
  delete user.password;
  res.json({
    _id: user._id,
    username: user.username,
    email: user.email,
    role: user.role,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt
  });
};

// PUT /api/users/profile
exports.updateProfile = async (req, res) => {
  const user = await User.findById(req.user._id);
  if (!user) return res.status(404).json({ error: "User not found" });

  const { username, email, oldPassword, newPassword } = req.body;

  if (username) user.username = username;
  if (email) user.email = email;

  // Handle password change if requested
  if (oldPassword || newPassword) {
    if (!oldPassword || !newPassword)
      return res.status(400).json({ error: "To change password, provide both oldPassword and newPassword." });

    const match = await bcrypt.compare(oldPassword, user.password);
    if (!match) return res.status(400).json({ error: "Old password incorrect" });
    user.password = newPassword; // Will be hashed by pre-save hook
  }

  await user.save();

  // Return updated profile, not password
  res.json({
    success: true,
    user: {
      _id: user._id,
      username: user.username,
      email: user.email,
      role: user.role,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt
    }
  });
};
