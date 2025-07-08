  // backend/src/controllers/salarySettingsController.js

const SalarySettings = require("../models/SalarySettings");

// GET /salary-settings
exports.getForLoggedInUser = async (req, res) => {
  try {
    const owner = req.user._id;
    const doc = await SalarySettings.findOne({ owner })
      .lean()
      .select("enabledPersonalFields enabledEmploymentFields enabledSalaryFields enabledDeductionFields enabledExtraFields");
    return res.json({
      enabledPersonalFields: doc?.enabledPersonalFields || [],
      enabledEmploymentFields: doc?.enabledEmploymentFields || [],
      enabledSalaryFields: doc?.enabledSalaryFields || [],
      enabledDeductionFields: doc?.enabledDeductionFields || [],
      enabledExtraFields: doc?.enabledExtraFields || [], // <-- Add this!
    });
  } catch (error) {
    return res.status(500).json({ error: "Server error" });
  }
};


// POST /salary-settings
exports.updateForLoggedInUser = async (req, res) => {
  try {
    const owner = req.user._id;
    const {
      enabledPersonalFields,
      enabledEmploymentFields,
      enabledSalaryFields,
      enabledDeductionFields,
      enabledExtraFields // <-- Add this!
    } = req.body;
    if (
      !Array.isArray(enabledPersonalFields) ||
      !Array.isArray(enabledEmploymentFields) ||
      !Array.isArray(enabledSalaryFields) ||
      !Array.isArray(enabledDeductionFields) ||
      !Array.isArray(enabledExtraFields) // <-- Add this!
    ) {
      return res.status(400).json({ error: "Invalid payload" });
    }
    const doc = await SalarySettings.findOneAndUpdate(
      { owner },
      {
        $setOnInsert: { owner, createdAt: new Date() },
        $set: {
          enabledPersonalFields,
          enabledEmploymentFields,
          enabledSalaryFields,
          enabledDeductionFields,
          enabledExtraFields, // <-- Add this!
          updatedAt: new Date(),
        },
      },
      {
        upsert: true,
        new: true,
        lean: true,
        select: "enabledPersonalFields enabledEmploymentFields enabledSalaryFields enabledDeductionFields enabledExtraFields",
      }
    );
    return res.json({
      enabledPersonalFields: doc.enabledPersonalFields,
      enabledEmploymentFields: doc.enabledEmploymentFields,
      enabledSalaryFields: doc.enabledSalaryFields,
      enabledDeductionFields: doc.enabledDeductionFields,
      enabledExtraFields: doc.enabledExtraFields, // <-- Add this!
    });
  } catch (error) {
    return res.status(500).json({ error: "Server error" });
  }
};

