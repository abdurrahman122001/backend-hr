const PayrollEstimate = require("../models/PayrollEstimate");
const TaxOverride = require("../models/TaxOverride");
const { encrypt, decrypt } = require("../utils/encryption");

/**
 * Upsert a payroll estimate (temporary table)
 */
exports.upsertEstimate = async (req, res) => {
  try {
    const { employeeId, month, year, field, value, encryptionKey, workingDays } = req.body;
    const owner = req.user._id;

    if (!employeeId || !month || !year || !field) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Encrypt the value if it's not already encrypted (though usually it's plain text from UI)
    const encryptedValue = await encrypt(String(value), encryptionKey);

    let estimate = await PayrollEstimate.findOne({
      employee: employeeId,
      month,
      year,
      owner
    });

    if (!estimate) {
      estimate = new PayrollEstimate({
        employee: employeeId,
        month,
        year,
        owner,
        overrides: {},
        manuallyEditedFields: {},
        workingDays
      });
    }

    // Update the specific field override
    estimate.overrides.set(field, encryptedValue);
    estimate.manuallyEditedFields.set(field, true);
    if (workingDays) estimate.workingDays = workingDays;

    await estimate.save();

    res.json({ success: true, message: "Estimate updated", estimate });
  } catch (err) {
    console.error("upsertEstimate error:", err);
    res.status(500).json({ error: "Failed to update estimate" });
  }
};

/**
 * Get all estimates for a month/year
 */
exports.getEstimates = async (req, res) => {
  try {
    const { month, year } = req.query;
    const owner = req.user._id;

    const estimates = await PayrollEstimate.find({ month, year, owner });

    // Decrypt overrides before sending to frontend if needed
    // Actually, it's better to send encrypted and let frontend decrypt with its key
    // But since the frontend sends its key, we could decrypt here too.
    // For now, let's just send the raw estimates.
    res.json({ estimates });
  } catch (err) {
    console.error("getEstimates error:", err);
    res.status(500).json({ error: "Failed to fetch estimates" });
  }
};

/**
 * Upsert a tax override (separate table)
 */
exports.upsertTaxOverride = async (req, res) => {
  try {
    const { employeeId, taxValue, encryptionKey } = req.body;
    const owner = req.user._id;

    if (!employeeId || taxValue === undefined) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const encryptedTaxValue = await encrypt(String(taxValue), encryptionKey);

    let override = await TaxOverride.findOne({
      employeeId,
      owner
    });

    if (!override) {
      override = new TaxOverride({
        employeeId,
        owner,
        taxValue: encryptedTaxValue
      });
    } else {
      override.taxValue = encryptedTaxValue;
    }

    await override.save();

    res.json({ success: true, message: "Tax override updated globally for this employee", override });
  } catch (err) {
    console.error("upsertTaxOverride error:", err);
    res.status(500).json({ error: "Failed to update tax override" });
  }
};

/**
 * Get all tax overrides for a month/year
 */
exports.getTaxOverrides = async (req, res) => {
  try {
    const owner = req.user._id;

    // Fetch all tax overrides for all employees (global for each)
    const overrides = await TaxOverride.find({ owner });
    res.json({ overrides });
  } catch (err) {
    console.error("getTaxOverrides error:", err);
    res.status(500).json({ error: "Failed to fetch tax overrides" });
  }
};

/**
 * Clear all estimates/overrides for a month/year
 */
exports.clearEstimates = async (req, res) => {
  try {
    const { month, year } = req.body;
    const owner = req.user._id;

    await Promise.all([
      PayrollEstimate.deleteMany({ month, year, owner })
    ]);

    res.json({ success: true, message: "Estimates and tax overrides cleared" });
  } catch (err) {
    console.error("clearEstimates error:", err);
    res.status(500).json({ error: "Failed to clear estimates" });
  }
};
