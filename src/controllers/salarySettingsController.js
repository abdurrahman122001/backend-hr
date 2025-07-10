// backend/src/controllers/salarySettingsController.js

const SalarySettings = require("../models/SalarySettings");

// Utility to determine which owner's settings to use for this user
function getSettingsOwner(req) {
  // Super admin uses their own _id
  // Admin uses createdBy (the main super-admin who created them)
  // All others use their own _id
  if (req.user.role === "admin" && req.user.createdBy) {
    return req.user.createdBy;
  }
  return req.user._id;
}

// GET /salary-settings
exports.getForLoggedInUser = async (req, res) => {
  try {
    const owner = getSettingsOwner(req);
    const doc = await SalarySettings.findOne({ owner })
      .lean()
      .select(
        "enabledPersonalFields enabledEmploymentFields enabledSalaryFields enabledDeductionFields enabledExtraFields"
      );
    return res.json({
      enabledPersonalFields: doc?.enabledPersonalFields || [],
      enabledEmploymentFields: doc?.enabledEmploymentFields || [],
      enabledSalaryFields: doc?.enabledSalaryFields || [],
      enabledDeductionFields: doc?.enabledDeductionFields || [],
      enabledExtraFields: doc?.enabledExtraFields || [],
    });
  } catch (error) {
    return res.status(500).json({ error: "Server error" });
  }
};

// POST /salary-settings
exports.updateForLoggedInUser = async (req, res) => {
  try {
    const owner = getSettingsOwner(req);
    const {
      enabledPersonalFields,
      enabledEmploymentFields,
      enabledSalaryFields,
      enabledDeductionFields,
      enabledExtraFields,
    } = req.body;
    if (
      !Array.isArray(enabledPersonalFields) ||
      !Array.isArray(enabledEmploymentFields) ||
      !Array.isArray(enabledSalaryFields) ||
      !Array.isArray(enabledDeductionFields) ||
      !Array.isArray(enabledExtraFields)
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
          enabledExtraFields,
          updatedAt: new Date(),
        },
      },
      {
        upsert: true,
        new: true,
        lean: true,
        select:
          "enabledPersonalFields enabledEmploymentFields enabledSalaryFields enabledDeductionFields enabledExtraFields",
      }
    );
    return res.json({
      enabledPersonalFields: doc.enabledPersonalFields,
      enabledEmploymentFields: doc.enabledEmploymentFields,
      enabledSalaryFields: doc.enabledSalaryFields,
      enabledDeductionFields: doc.enabledDeductionFields,
      enabledExtraFields: doc.enabledExtraFields,
    });
  } catch (error) {
    return res.status(500).json({ error: "Server error" });
  }
};
