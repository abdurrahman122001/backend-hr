const Settings = require('../models/SetDate');

// Set allowed days for confirmation deadline
exports.setConfirmationDeadlineDays = async (req, res) => {
  try {
    const { days } = req.body;
    if (!days || isNaN(days) || days < 1) {
      return res.status(400).json({ error: "Days must be a positive number" });
    }
    const setting = await Settings.findOneAndUpdate(
      { key: 'confirmationDeadlineDays' },
      { value: Number(days) },
      { upsert: true, new: true }
    );
    res.json({ days: setting.value });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

// Get allowed days for confirmation deadline
exports.getConfirmationDeadlineDays = async (req, res) => {
  try {
    const setting = await Settings.findOne({ key: 'confirmationDeadlineDays' });
    res.json({ days: setting?.value || 3 }); // default 3 days if not set
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

// Given a joining date, return the suggested confirmation deadline (joiningDate + allowedDays)
exports.getSuggestedConfirmationDeadline = async (req, res) => {
  try {
    const { joiningDate } = req.query;
    if (!joiningDate) return res.status(400).json({ error: "Missing joiningDate param" });

    const setting = await Settings.findOne({ key: 'confirmationDeadlineDays' });
    const allowedDays = setting?.value || 3;

    const join = new Date(joiningDate);
    if (isNaN(join.getTime())) return res.status(400).json({ error: "Invalid joiningDate" });

    join.setDate(join.getDate() + allowedDays);
    res.json({ confirmationDeadline: join.toISOString().slice(0, 10), allowedDays });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
