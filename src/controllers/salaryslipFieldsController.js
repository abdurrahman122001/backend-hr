// backend/src/controllers/salarylipFieldsController.js

const SalarySlipFields = require("../models/SalarySlipFields");
const User = require("../models/Users");

// Utility to get correct owner for settings (super-admin for admins, else self)
async function getFieldsOwner(req) {
  // If it's an employee (unifiedAuth or employee-token fallback), resolve through
  // their company owner, applying the same admin -> createdBy mapping the owner gets
  if (req.user.isEmployee || req.user.isEmployeeFallback) {
    const ownerId = req.user.owner;
    if (ownerId) {
      const ownerUser = await User.findById(ownerId).select("role createdBy").lean();
      if (ownerUser?.role === "admin" && ownerUser.createdBy) {
        return ownerUser.createdBy;
      }
      return ownerId;
    }
  }
  // Admin logic
  if (req.user.role === "admin" && req.user.createdBy) {
    return req.user.createdBy;
  }
  return req.user.owner || req.user._id;
}

exports.getForLoggedInUser = async (req, res) => {
  try {
    const owner = await getFieldsOwner(req);
    const doc = await SalarySlipFields.findOne({ owner })
      .lean()
      .select(
        "enabledPersonalFields enabledEmploymentFields enabledSalaryFields enabledDeductionFields enabledNetSalaryFields enabledLeaveRecords showProvidentFund showGratuityFund showLoanDetails headerOption showHeaderAddress showHeaderGeneratedDate tableOrder"
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
      headerOption: doc?.headerOption || "both",
      showHeaderAddress: typeof doc?.showHeaderAddress === "boolean" ? doc.showHeaderAddress : true,
      showHeaderGeneratedDate: typeof doc?.showHeaderGeneratedDate === "boolean" ? doc.showHeaderGeneratedDate : true,
      tableOrder: doc?.tableOrder?.length ? doc.tableOrder : ["loan", "pf", "gf", "leaves"],
    });
  } catch (error) {
    return res.status(500).json({ error: "Server error" });
  }
};


exports.updateForLoggedInUser = async (req, res) => {
  try {
    const owner = await getFieldsOwner(req);
    const {
      enabledPersonalFields,
      enabledEmploymentFields,
      enabledSalaryFields,
      enabledDeductionFields,
      enabledNetSalaryFields,
      enabledLeaveRecords,
      showProvidentFund,
      showGratuityFund,
      showLoanDetails,
      headerOption,
      showHeaderAddress,
      showHeaderGeneratedDate,
      tableOrder,
    } = req.body;

    if (
      !Array.isArray(enabledPersonalFields) ||
      !Array.isArray(enabledEmploymentFields) ||
      !Array.isArray(enabledSalaryFields) ||
      !Array.isArray(enabledDeductionFields)
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
          headerOption,
          showHeaderAddress,
          showHeaderGeneratedDate,
          ...(Array.isArray(tableOrder) && tableOrder.length ? { tableOrder } : {}),
          updatedAt: new Date(),
        },
      },
      {
        upsert: true,
        new: true,
        lean: true,
        select:
          "enabledPersonalFields enabledEmploymentFields enabledSalaryFields enabledDeductionFields enabledNetSalaryFields enabledLeaveRecords showProvidentFund showGratuityFund showLoanDetails headerOption showHeaderAddress showHeaderGeneratedDate tableOrder",
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
      headerOption: doc.headerOption,
      showHeaderAddress: doc.showHeaderAddress,
      showHeaderGeneratedDate: doc.showHeaderGeneratedDate,
      tableOrder: doc?.tableOrder?.length ? doc.tableOrder : ["loan", "pf", "gf", "leaves"],
    });
  } catch (error) {
    return res.status(500).json({ error: "Server error" });
  }
};
