// backend/src/routes/auth.js
const express = require("express");
const jwt = require("jsonwebtoken");
const speakeasy = require("speakeasy");
const QRCode = require("qrcode");
const User = require("../models/Users");
const requireAuth = require("../middleware/auth");

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET;
const authCtrl = require("../controllers/authController");
const REFRESH_SECRET = process.env.REFRESH_SECRET || "refreshsecret123";

const ACCESS_TTL = process.env.ACCESS_TTL || "30m";
const REFRESH_TTL = process.env.REFRESH_TTL || "7d";
const TWO_FA_PENDING_TTL = "5m"; // short-lived token during 2FA verification step
const APP_NAME = process.env.APP_NAME || "HR Dashboard";
// ————— Sign-up —————
router.post("/signup", async (req, res) => {
  try {
    const { username, email, password } = req.body;
    // basic validation
    if (!username || !email || !password) {
      return res
        .status(400)
        .json({ error: "username, email and password are required" });
    }
    // create & hash via your pre('save') hook
    const newUser = new User({ username, email, password });
    await newUser.save();

    // generate token immediately so the user is logged-in on signup
    const token = jwt.sign({ id: newUser._id }, JWT_SECRET, {
      expiresIn: "2h",
    });
    res.status(201).json({
      token,
      user: { id: newUser._id, username: newUser.username },
    });
  } catch (err) {
    // handle duplicate‐key errors
    if (err.code === 11000) {
      return res.status(409).json({ error: "Username or email already taken" });
    }
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});
router.post("/hr-login", async (req, res) => {
  try {
    const { username, password } = req.body;

    // HR can log in by username or email too
    const query = username.includes("@") ? { email: username } : { username };
    const user = await User.findOne(query);

    if (!user) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    // must be role hr
    if (user.role !== "hr") {
      return res.status(403).json({ error: "Forbidden: not an HR account" });
    }

    const ok = await user.comparePassword(password);
    if (!ok) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const token = jwt.sign({ id: user._id, role: user.role }, JWT_SECRET, {
      expiresIn: "2h",
    });
    res.json({
      token,
      user: { id: user._id, username: user.username, role: user.role },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

router.post("/login", async (req, res) => {
  const { username, password } = req.body;

  try {
    const user = await User.findOne({ username }).select("+twoFactorSecret +twoFactorEnabled");
    if (!user || !(await user.comparePassword(password))) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    // If 2FA is enabled, issue a short-lived pending token and ask for OTP
    if (user.twoFactorEnabled) {
      const pendingToken = jwt.sign(
        { id: user._id, twoFactorPending: true },
        JWT_SECRET,
        { expiresIn: TWO_FA_PENDING_TTL }
      );
      return res.json({
        requiresTwoFactor: true,
        pendingToken,
        user: { id: user._id, username: user.username },
      });
    }

    // No 2FA — issue full tokens directly
    const accessToken = jwt.sign(
      { id: user._id, tv: user.tokenVersion || 0 },
      JWT_SECRET,
      { expiresIn: ACCESS_TTL }
    );
    const refreshToken = jwt.sign(
      { id: user._id, tv: user.tokenVersion || 0 },
      REFRESH_SECRET,
      { expiresIn: REFRESH_TTL }
    );

    return res.json({
      token: accessToken,
      refreshToken,
      user: { id: user._id, username: user.username },
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: "Server error" });
  }
});

// ── 2FA: Verify OTP during login ──────────────────────────────────
router.post("/2fa/verify", async (req, res) => {
  const { pendingToken, code } = req.body;
  if (!pendingToken || !code) {
    return res.status(400).json({ message: "pendingToken and code are required" });
  }

  try {
    let payload;
    try {
      payload = jwt.verify(pendingToken, JWT_SECRET);
    } catch {
      return res.status(401).json({ message: "Session expired. Please log in again." });
    }

    if (!payload.twoFactorPending) {
      return res.status(401).json({ message: "Invalid token type" });
    }

    const user = await User.findById(payload.id).select("+twoFactorSecret +twoFactorEnabled");
    if (!user || !user.twoFactorEnabled || !user.twoFactorSecret) {
      return res.status(401).json({ message: "2FA not configured for this account" });
    }

    const isValid = speakeasy.totp.verify({
      secret: user.twoFactorSecret,
      encoding: "base32",
      token: String(code).replace(/\s/g, ""),
      window: 1, // allow 1 step tolerance (~30 seconds)
    });

    if (!isValid) {
      return res.status(401).json({ message: "Invalid authenticator code. Please try again." });
    }

    // OTP valid — issue full auth tokens
    const accessToken = jwt.sign(
      { id: user._id, tv: user.tokenVersion || 0 },
      JWT_SECRET,
      { expiresIn: ACCESS_TTL }
    );
    const refreshToken = jwt.sign(
      { id: user._id, tv: user.tokenVersion || 0 },
      REFRESH_SECRET,
      { expiresIn: REFRESH_TTL }
    );

    return res.json({
      token: accessToken,
      refreshToken,
      user: { id: user._id, username: user.username },
    });
  } catch (err) {
    console.error("[2fa/verify]", err);
    return res.status(500).json({ message: "Server error" });
  }
});

// ── 2FA: Begin setup — generate secret + QR code ─────────────────
router.post("/2fa/setup", requireAuth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select("+twoFactorEnabled +twoFactorPendingSecret");
    if (!user) return res.status(404).json({ message: "User not found" });

    if (user.twoFactorEnabled) {
      return res.status(400).json({ message: "2FA is already enabled on this account" });
    }

    // Generate a new TOTP secret
    const secret = speakeasy.generateSecret({
      name: `${APP_NAME} (${user.username})`,
      length: 20,
    });

    // Save as pending (not yet confirmed)
    await User.findByIdAndUpdate(user._id, { twoFactorPendingSecret: secret.base32 });

    // Generate QR code data URL
    const qrDataUrl = await QRCode.toDataURL(secret.otpauth_url);

    return res.json({
      qrCode: qrDataUrl,
      secret: secret.base32, // shown as fallback text for manual entry
      otpauthUrl: secret.otpauth_url,
    });
  } catch (err) {
    console.error("[2fa/setup]", err);
    return res.status(500).json({ message: "Server error" });
  }
});

// ── 2FA: Confirm setup — verify OTP and activate ─────────────────
router.post("/2fa/confirm", requireAuth, async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ message: "OTP code is required" });

  try {
    const user = await User.findById(req.user._id).select("+twoFactorEnabled +twoFactorPendingSecret +twoFactorSecret");
    if (!user) return res.status(404).json({ message: "User not found" });

    if (!user.twoFactorPendingSecret) {
      return res.status(400).json({ message: "No pending 2FA setup found. Start setup first." });
    }

    const isValid = speakeasy.totp.verify({
      secret: user.twoFactorPendingSecret,
      encoding: "base32",
      token: String(code).replace(/\s/g, ""),
      window: 1,
    });

    if (!isValid) {
      return res.status(401).json({ message: "Invalid code. Make sure your authenticator time is synced." });
    }

    // Activate 2FA
    await User.findByIdAndUpdate(user._id, {
      twoFactorSecret: user.twoFactorPendingSecret,
      twoFactorEnabled: true,
      twoFactorPendingSecret: undefined,
    });

    return res.json({ success: true, message: "Two-factor authentication has been enabled." });
  } catch (err) {
    console.error("[2fa/confirm]", err);
    return res.status(500).json({ message: "Server error" });
  }
});

// ── 2FA: Disable ─────────────────────────────────────────────────
router.post("/2fa/disable", requireAuth, async (req, res) => {
  const { password, code } = req.body;
  if (!password || !code) {
    return res.status(400).json({ message: "Password and authenticator code are required" });
  }

  try {
    const user = await User.findById(req.user._id).select("+twoFactorSecret +twoFactorEnabled +password");
    if (!user) return res.status(404).json({ message: "User not found" });

    if (!user.twoFactorEnabled) {
      return res.status(400).json({ message: "2FA is not enabled on this account" });
    }

    // Verify password
    const pwOk = await user.comparePassword(password);
    if (!pwOk) return res.status(401).json({ message: "Incorrect password" });

    // Verify current OTP
    const isValid = speakeasy.totp.verify({
      secret: user.twoFactorSecret,
      encoding: "base32",
      token: String(code).replace(/\s/g, ""),
      window: 1,
    });

    if (!isValid) {
      return res.status(401).json({ message: "Invalid authenticator code" });
    }

    await User.findByIdAndUpdate(user._id, {
      twoFactorEnabled: false,
      twoFactorSecret: undefined,
      twoFactorPendingSecret: undefined,
    });

    return res.json({ success: true, message: "Two-factor authentication has been disabled." });
  } catch (err) {
    console.error("[2fa/disable]", err);
    return res.status(500).json({ message: "Server error" });
  }
});

// ── 2FA: Status ──────────────────────────────────────────────────
router.get("/2fa/status", requireAuth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select("twoFactorEnabled");
    if (!user) return res.status(404).json({ message: "User not found" });
    return res.json({ twoFactorEnabled: user.twoFactorEnabled });
  } catch (err) {
    return res.status(500).json({ message: "Server error" });
  }
});
// POST /auth/refresh
router.post("/refresh", async (req, res) => {
  const { refreshToken } = req.body;

  if (!refreshToken) {
    return res.status(401).json({ message: "Refresh token missing" });
  }

  try {
    const payload = jwt.verify(refreshToken, REFRESH_SECRET);

    const user = await User.findById(payload.id);
    if (!user) {
      return res.status(401).json({ message: "User not found" });
    }

    // Re-issue new tokens
    const newAccessToken = jwt.sign(
      { id: user._id, tv: user.tokenVersion || 0 },
      JWT_SECRET,
      { expiresIn: ACCESS_TTL }
    );

    const newRefreshToken = jwt.sign(
      { id: user._id, tv: user.tokenVersion || 0 },
      REFRESH_SECRET,
      { expiresIn: REFRESH_TTL }
    );

    return res.json({
      token: newAccessToken,
      refreshToken: newRefreshToken,
    });
  } catch (err) {
    console.error(err);
    return res.status(401).json({ message: "Invalid refresh token" });
  }
});

router.get("/me", requireAuth, authCtrl.getMe);

router.post("/forgot-password", authCtrl.forgotPassword);
router.post("/reset-password/:token", authCtrl.resetPassword);

module.exports = router;
