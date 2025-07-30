const User = require('../models/Users');
const { sendEmail } = require('../services/mailService'); // fixed: destructure for named export
const crypto = require('crypto');

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

/**
 * Forgot Password
 */
exports.forgotPassword = async (req, res) => {
  const { email } = req.body;
  try {
    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ message: 'No account with that email.' });

    // Generate token
    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    // Save hashed token & expiry on user
    user.resetPasswordToken = tokenHash;
    user.resetPasswordExpires = Date.now() + 3600000; // 1 hour

    await user.save();

    // Compose reset link
    const resetURL = `${process.env.APP_URL}/reset-password/${token}`;
    const html = `
      <p>You requested a password reset.</p>
      <p><a href="${resetURL}">Click here to reset your password</a></p>
      <p>This link will expire in 1 hour.</p>
    `;

    // Send email (object, not positional args!)
    await sendEmail({
      to: user.email,
      subject: 'Password Reset Request',
      html,
    });

    res.json({ message: 'Password reset link sent if email exists.' });
  } catch (err) {
    console.error('[ForgotPassword Error]', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

/**
 * Reset Password
 */
exports.resetPassword = async (req, res) => {
  const { token } = req.params;
  const { password } = req.body;

  try {
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    const user = await User.findOne({
      resetPasswordToken: tokenHash,
      resetPasswordExpires: { $gt: Date.now() },
    });

    if (!user) {
      return res.status(400).json({ message: 'Invalid or expired token.' });
    }

    user.password = password; // your pre-save hook will hash it
    user.resetPasswordToken = undefined;
    user.resetPasswordExpires = undefined;
    await user.save();

    res.json({ message: 'Password has been reset. Please login.' });
  } catch (err) {
    console.error('[ResetPassword Error]', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};
