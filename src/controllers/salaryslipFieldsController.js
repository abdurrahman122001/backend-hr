// backend/src/controllers/salarylipFieldsController.js

const SalarySlipFields = require("../models/SalarySlipFields");

// GET /salaryslip-settings
exports.getForLoggedInUser = async (req, res) => {
  try {
    const owner = req.user._id;
    const doc = await SalarySlipFields.findOne({ owner })
      .lean()
      .select("enabledPersonalFields enabledEmploymentFields enabledSalaryFields enabledDeductionFields enabledNetSalaryFields");
    return res.json({
      enabledPersonalFields: doc?.enabledPersonalFields || [],
      enabledEmploymentFields: doc?.enabledEmploymentFields || [],
      enabledSalaryFields: doc?.enabledSalaryFields || [],
      enabledDeductionFields: doc?.enabledDeductionFields || [],
      enabledNetSalaryFields: doc?.enabledNetSalaryFields || [],
    });
  } catch (error) {
    return res.status(500).json({ error: "Server error" });
  }
};

// POST /salaryslip-settings
exports.updateForLoggedInUser = async (req, res) => {
  try {
    const owner = req.user._id;
    const {
      enabledPersonalFields,
      enabledEmploymentFields,
      enabledSalaryFields,
      enabledDeductionFields,
      enabledNetSalaryFields
    } = req.body;
    if (
      !Array.isArray(enabledPersonalFields) ||
      !Array.isArray(enabledEmploymentFields) ||
      !Array.isArray(enabledSalaryFields) ||
      !Array.isArray(enabledDeductionFields) ||
      !Array.isArray(enabledNetSalaryFields)
    ) {
      return res.status(400).json({ error: "Invalid payload" });
    }
    const doc = await SalarySlipFields.findOneAndUpdate(
      { owner },
      {
        $setOnInsert: { owner, createdAt: new Date() },
        $set: {
          enabledPersonalFields,
          enabledEmploymentFields,
          enabledSalaryFields,
          enabledDeductionFields,
          enabledNetSalaryFields,
          updatedAt: new Date(),
        },
      },
      {
        upsert: true,
        new: true,
        lean: true,
        select: "enabledPersonalFields enabledEmploymentFields enabledSalaryFields enabledDeductionFields enabledNetSalaryFields",
      }
    );
    return res.json({
      enabledPersonalFields: doc.enabledPersonalFields,
      enabledEmploymentFields: doc.enabledEmploymentFields,
      enabledSalaryFields: doc.enabledSalaryFields,
      enabledDeductionFields: doc.enabledDeductionFields,
      enabledNetSalaryFields: doc.enabledNetSalaryFields,
    });
  } catch (error) {
    return res.status(500).json({ error: "Server error" });
  }
};
