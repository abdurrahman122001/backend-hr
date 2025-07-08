// backend/src/routes/fontSetting.js

const express = require("express");
const router = express.Router();
const requireAuth = require("../middleware/auth");
const FontSetting = require("../models/FontSetting");

// GET current user's font setting
router.get("/me", requireAuth, async (req, res) => {
  try {
    let setting = await FontSetting.findOne({ owner: req.user._id });
    if (!setting) {
      // Default setting if not set
      setting = await FontSetting.create({ owner: req.user._id });
    }
    res.json({ fontFamily: setting.fontFamily });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT/POST update user's font setting
router.post("/me", requireAuth, async (req, res) => {
  try {
    const { fontFamily } = req.body;
    if (!fontFamily) return res.status(400).json({ error: "fontFamily is required" });

    const setting = await FontSetting.findOneAndUpdate(
      { owner: req.user._id },
      { fontFamily },
      { new: true, upsert: true }
    );
    res.json({ fontFamily: setting.fontFamily });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
