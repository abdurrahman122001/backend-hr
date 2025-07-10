const User = require('../models/Users');

// /api/auth/me
exports.getMe = async (req, res) => {
  try {
    // req.user is set by your requireAuth middleware
    const user = await User.findById(req.user._id).select('username email role');
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({
      _id: user._id,
      username: user.username,
      email: user.email,
      role: user.role
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
};
