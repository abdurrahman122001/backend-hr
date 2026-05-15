const HrRules = require("../models/HrRules");

// Create or update HR rules (Upsert)
exports.updateHrRules = async (req, res) => {
  try {
    const ownerId = req.user._id;
    const updateData = req.body;

    // We only want one HR rules document per owner
    const rules = await HrRules.findOneAndUpdate(
      { owner: ownerId },
      { ...updateData, owner: ownerId },
      { new: true, upsert: true, runValidators: true }
    );

    res.status(200).json(rules);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Get HR rules for the owner
exports.getHrRules = async (req, res) => {
  try {
    const ownerId = req.user._id;
    const rules = await HrRules.findOne({ owner: ownerId });

    if (!rules) {
      // Return default rules if none exist yet
      return res.status(200).json({
        graceMinutes: 0,
        halfDayLateArrivalHours: 4,
        halfDayEarlyDepartureHours: 4,
        applyThreeLatesDeduction: false,
        nonWorkingDays: ["saturday", "sunday"],
      });
    }

    res.status(200).json(rules);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// Delete HR rules (though might not be needed if we always want defaults)
exports.deleteHrRules = async (req, res) => {
  try {
    const ownerId = req.user._id;
    await HrRules.findOneAndDelete({ owner: ownerId });
    res.status(200).json({ message: "HR rules deleted successfully" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
