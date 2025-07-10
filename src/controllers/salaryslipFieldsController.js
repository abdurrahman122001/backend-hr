// backend/src/controllers/salarylipFieldsController.js

const SalarySlipFields = require("../models/SalarySlipFields");

// Utility to get correct owner for settings (super-admin for admins, else self)
function getFieldsOwner(req) {
  if (req.user.role === "admin" && req.user.createdBy) {
    return req.user.createdBy;
  }
  return req.user._id;
}

exports.getForLoggedInUser = async (req, res) => {
  try {
    const owner = getFieldsOwner(req);
    const doc = await SalarySlipFields.findOne({ owner })
      .lean()
      .select(
        "enabledPersonalFields enabledEmploymentFields enabledSalaryFields enabledDeductionFields enabledNetSalaryFields enabledLeaveRecords showProvidentFund showGratuityFund showLoanDetails"
      );
    return res.json({
      enabledPersonalFields: doc?.enabledPersonalFields || [],
      enabledEmploymentFields: doc?.enabledEmploymentFields || [],
      enabledSalaryFields: doc?.enabledSalaryFields || [],
      enabledDeductionFields: doc?.enabledDeductionFields || [],
      enabledNetSalaryFields: doc?.enabledNetSalaryFields || [],
      enabledLeaveRecords: doc?.enabledLeaveRecords || [],
      showProvidentFund: typeof doc?.showProvidentFund === "boolean" ? doc.showProvidentFund : true,
      showGratuityFund: typeof doc?.showGratuityFund === "boolean" ? doc.showGratuityFund : true,
      showLoanDetails : typeof doc?.showLoanDetails  === "boolean" ? doc.showLoanDetails  : true,
    });
  } catch (error) {
    return res.status(500).json({ error: "Server error" });
  }
};


exports.updateForLoggedInUser = async (req, res) => {
  try {
    const owner = getFieldsOwner(req);
    const {
      enabledPersonalFields,
      enabledEmploymentFields,
      enabledSalaryFields,
      enabledDeductionFields,
      enabledNetSalaryFields,
      enabledLeaveRecords,
      showProvidentFund, // add these two
      showGratuityFund,
      showLoanDetails 
    } = req.body;

    if (
      !Array.isArray(enabledPersonalFields) ||
      !Array.isArray(enabledEmploymentFields) ||
      !Array.isArray(enabledSalaryFields) ||
      !Array.isArray(enabledDeductionFields) ||
      !Array.isArray(enabledNetSalaryFields) ||
      !Array.isArray(enabledLeaveRecords)
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
          enabledLeaveRecords,
          showProvidentFund, 
          showGratuityFund, 
          showLoanDetails, 
          updatedAt: new Date(),
        },
      },
      {
        upsert: true,
        new: true,
        lean: true,
        select:
          "enabledPersonalFields enabledEmploymentFields enabledSalaryFields enabledDeductionFields enabledNetSalaryFields enabledLeaveRecords showProvidentFund showGratuityFund showLoanDetails ",
      }
    );

    return res.json({
      enabledPersonalFields: doc.enabledPersonalFields,
      enabledEmploymentFields: doc.enabledEmploymentFields,
      enabledSalaryFields: doc.enabledSalaryFields,
      enabledDeductionFields: doc.enabledDeductionFields,
      enabledNetSalaryFields: doc.enabledNetSalaryFields,
      enabledLeaveRecords: doc.enabledLeaveRecords,
      showProvidentFund: typeof doc?.showProvidentFund === "boolean" ? doc.showProvidentFund : true,
      showGratuityFund: typeof doc?.showGratuityFund === "boolean" ? doc.showGratuityFund : true,
      showLoanDetails: typeof doc?.showLoanDetails === "boolean" ? doc.showLoanDetails : true,
    });
  } catch (error) {
    return res.status(500).json({ error: "Server error" });
  }
};
