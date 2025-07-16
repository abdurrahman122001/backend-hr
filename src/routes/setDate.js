const express = require("express");
const router = express.Router();
const DateSettings = require("../models/SetDate");

// GET: Fetch current settings (single document)
router.get("/date-settings", async (req, res) => {
  try {
    let settings = await DateSettings.findOne();
    if (!settings) {
      settings = await DateSettings.create({});
    }
    res.json(settings);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch settings" });
  }
});

// POST: Update settings (joiningDateDays and/or confirmationDeadlineDays)
router.post("/date-settings", async (req, res) => {
  try {
    const { joiningDateDays, confirmationDeadlineDays } = req.body;
    let settings = await DateSettings.findOne();
    if (!settings) settings = await DateSettings.create({});
    if (typeof joiningDateDays === "number" && joiningDateDays > 0) {
      settings.joiningDateDays = joiningDateDays;
    }
    if (typeof confirmationDeadlineDays === "number" && confirmationDeadlineDays > 0) {
      settings.confirmationDeadlineDays = confirmationDeadlineDays;
    }
    await settings.save();
    res.json(settings);
  } catch (err) {
    res.status(500).json({ error: "Failed to update settings" });
  }
});

module.exports = router;
