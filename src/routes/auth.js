// backend/src/routes/auth.js
const express = require("express");
const jwt = require("jsonwebtoken");
const User = require("../models/Users");
const requireAuth = require("../middleware/auth"); // Make sure this is correct

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET;
const authCtrl = require("../controllers/authController");
const REFRESH_SECRET = process.env.REFRESH_SECRET || "refreshsecret123";

const ACCESS_TTL = process.env.ACCESS_TTL || "30m";      // Access token expiry
const REFRESH_TTL = process.env.REFRESH_TTL || "7d";      // Refresh token expiry
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
    const user = await User.findOne({ username });
    if (!user || !(await user.comparePassword(password))) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

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
      refreshToken: refreshToken,
      user: {
        id: user._id,
        username: user.username,
      },
    });
  } catch (err) {
    console.error(err);
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
