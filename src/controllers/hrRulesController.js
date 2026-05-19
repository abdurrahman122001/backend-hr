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
        graceMinutes: 15,
        halfDayLateArrivalHours: 3,
        halfDayEarlyDepartureHours: 3,
        lateMarksForDayOff: 3,
        nonWorkingDays: ["saturday", "sunday"],
        probationMonths: 3,
        probationExtensionMonths: 3,
        noticePeriodDays: 30,
        annualPaidLeaves: 22,
        leaveApprovalNoticeDays: 7,
        dressCode: "Monday to Wednesday: Dress shirts in light corporate shades and dress pants in dark corporate colors are mandatory.\nThursday: Corporate casual attire is allowed but must remain professional.\nFriday: Traditional wear (shalwar kameez) is permitted, but a waistcoat must be worn.",
        checkedPoints: ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13"]
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
