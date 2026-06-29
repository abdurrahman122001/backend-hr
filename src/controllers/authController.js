const User = require('../models/Users');
const { sendEmail } = require('../services/mailService'); // fixed: destructure for named export
const crypto = require('crypto');

// /api/auth/me
exports.getMe = async (req, res) => {
  try {
    // Employee-admin tokens (opened from the Employee/Connect header via ?token=)
    // carry the employee's id in req.user._id — not a User. Return the employee's
    // identity so the dashboard greets them by name instead of a generic "Admin".
    if (req.user.isEmployeeFallback || req.user.isEmployee) {
      const Employee = require('../models/Employees');
      const emp = await Employee.findById(req.user.employeeId || req.user._id)
        .select('name companyEmail role photographUrl department designation employeeId rt reportingTime reportingTimeRange joiningDate graceTime graceMinutes');
      if (emp) {
        return res.json({
          _id: emp._id,
          name: emp.name,
          username: emp.name,
          email: emp.companyEmail,
          role: req.user.role || emp.role,
          photographUrl: emp.photographUrl || null,
          department: emp.department || "",
          designation: emp.designation || "",
          employeeId: emp.employeeId || "",
          empId: emp.employeeId || emp._id.toString(),
          rt: emp.rt || emp.reportingTime || emp.reportingTimeRange || "",
          reportingTime: emp.reportingTime || emp.rt || emp.reportingTimeRange || "",
          reportingTimeRange: emp.reportingTimeRange || "",
          joiningDate: emp.joiningDate || null,
          graceTime: emp.graceTime || emp.graceMinutes,
          isEmployee: true,
        });
      }
    }

    // req.user is set by your requireAuth middleware
    const user = await User.findById(req.user._id).select('username name email role');
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({
      _id: user._id,
      username: user.username,
      name: user.name || user.username,
      email: user.email,
      role: user.role,
      isEmployee: false,
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
    const appName = "HR"; // Use your app name/brand
    const primaryColor = "#2563eb"; // Your main brand color
    const accentColor = "#a5b4fc";
    const html = `
    <!DOCTYPE html>
    <html lang="en" style="background: #f4f4ff;">
      <head>
        <meta charset="UTF-8" />
        <title>Password Reset</title>
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <style>
          @import url('https://fonts.googleapis.com/css2?family=Inter:wght@500;700;900&family=Montserrat:wght@600;800&display=swap');
          body {
            font-family: 'Inter', 'Montserrat', 'Segoe UI', Arial, sans-serif;
            background: linear-gradient(130deg, #f4f4ff 60%, #f9fafc 100%, #e0e7ff 0%) fixed;
            min-height: 100vh;
            margin: 0;
            padding: 0;
          }
          .container {
            max-width: 480px;
            margin: 44px auto;
            background: #fff;
            border-radius: 22px;
            box-shadow: 0 8px 40px 0 #0033ff15, 0 2px 8px 0 #1e40af12;
            padding: 34px 30px 30px 30px;
            text-align: center;
            position: relative;
            border: 1px solid #eef2ff;
            animation: pop-in 0.7s cubic-bezier(0.23,1,0.32,1);
          }
          @keyframes pop-in {
            0% { transform: translateY(30px) scale(0.97); opacity: 0.1; }
            100% { transform: none; opacity: 1; }
          }
          h1 {
            font-family: 'Montserrat', 'Inter', Arial, sans-serif;
            font-size: 2.1rem;
            color: ${primaryColor};
            font-weight: 800;
            margin-bottom: 10px;
            letter-spacing: -1px;
          }
          .subtitle {
            font-size: 1.13rem;
            color: #3d4266;
            margin-bottom: 30px;
            background: linear-gradient(90deg, #e0e7ff 30%, #fff 100%);
            padding: 8px 0 10px 0;
            border-radius: 10px;
            box-shadow: 0 2px 8px #2563eb08;
          }
          .btn {
            display: inline-block;
            background: #2563eb;
            color: #fff !important;
            font-family: 'Montserrat', 'Inter', Arial, sans-serif;
            font-size: 1.12rem;
            font-weight: 800;
            text-decoration: none;
            border-radius: 10px;
            padding: 16px 38px;
            letter-spacing: 0.04em;
            margin: 25px 0 14px 0;
            box-shadow: 0 4px 18px -3px #2563eb33;
            border: none;
            transition: background 0.2s, transform 0.13s;
          }
          .btn:hover {
            background: linear-gradient(90deg, #003ecf, #2563eb 70%);
            color: #fff !important;
            transform: translateY(-2px) scale(1.03);
            box-shadow: 0 8px 24px -6px #2563eb4a;
          }
          .info {
            font-size: 1.04rem;
            color: #61677c;
            margin: 22px 0 0 0;
          }
          .expire {
            font-size: 1rem;
            color: #d60000;
            margin-top: 8px;
            font-weight: 600;
            display: block;
          }
          .footer {
            color: #b4b9c6;
            font-size: 1rem;
            margin: 42px 0 0 0;
            text-align: center;
            letter-spacing: 0.01em;
            border-top: 1px solid #f4f4ff;
            padding-top: 17px;
          }
          .card-accent {
            width: 100%;
            height: 6px;
            background: linear-gradient(90deg, #4f46e5, #2563eb 60%, #22d3ee 100%);
            border-radius: 11px 11px 0 0;
            margin: -34px 0 26px 0;
          }
          @media (max-width: 540px) {
            .container { padding: 18px 4vw 22px 4vw; }
            h1 { font-size: 1.28rem; }
            .btn { padding: 14px 2vw; font-size: 1rem; }
            .card-accent { margin-top: -18px; }
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="card-accent"></div>
          <h1>Reset Your Password</h1>
          <div class="subtitle">
            Hi there,<br/>
            You requested to reset your password for your <b>${appName}</b> account.
          </div>
          <a class="btn" href="${resetURL}" target="_blank">Reset Password</a>
          <div class="info">
            Didn’t request this? It’s safe to ignore this email.<br/>
            <span class="expire">This link will expire in 1 hour.</span>
          </div>
          <div class="footer">
            &copy; ${new Date().getFullYear()} ${appName} &mdash; All rights reserved.
          </div>
        </div>
      </body>
    </html>
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
