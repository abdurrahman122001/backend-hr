const NoticePeriod = require("../models/NoticePeriod");

// ============================
// Create or Update Notice Period
// ============================
exports.setNoticePeriod = async (req, res) => {
  try {
    const ownerId = req.user._id;   // From your requireAuth middleware
    const { noticePeriodInDays } = req.body;

    if (noticePeriodInDays === undefined || noticePeriodInDays === null) {
      return res.status(400).json({
        status: "error",
        message: "noticePeriodInDays is required",
      });
    }

    // Check if owner already created a notice period
    let record = await NoticePeriod.findOne({ ownerId });

    if (!record) {
      // Create new
      record = await NoticePeriod.create({
        ownerId,
        noticePeriodInDays,
      });
    } else {
      // Update existing
      record.noticePeriodInDays = noticePeriodInDays;
      await record.save();
    }

    return res.json({
      status: "success",
      data: record,
    });
  } catch (err) {
    console.error("Error saving notice period:", err);
    return res.status(500).json({
      status: "error",
      message: "Internal server error",
    });
  }
};

// ============================
// Fetch Notice Period of Owner
// ============================
exports.getNoticePeriod = async (req, res) => {
  try {
    const ownerId = req.user._id;

    const record = await NoticePeriod.findOne({ ownerId });

    if (!record) {
      return res.status(404).json({
        status: "error",
        message: "No notice period found for this owner",
      });
    }

    return res.json({
      status: "success",
      data: record,
    });
  } catch (err) {
    console.error("Error fetching notice period:", err);
    return res.status(500).json({
      status: "error",
      message: "Internal server error",
    });
  }
};
