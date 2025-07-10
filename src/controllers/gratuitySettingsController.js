const CompanySetting = require("../models/GratuitySetting");
const Employee = require("../models/Employees");
const SalarySlip = require("../models/SalarySlip"); // <-- ADD THIS
const { encryptSalary, decryptSalary } = require("../utils/encryption"); // <-- ADD THIS

// Get global gratuity days for company
exports.getGlobalGratuityDays = async (req, res) => {
  const owner = req.user?._id;
  let settings = await CompanySetting.findOne({ owner });
  if (!settings) {
    settings = await CompanySetting.create({ owner, gratuityDaysPaid: 21 });
  }
  res.json({ gratuityDaysPaid: settings.gratuityDaysPaid });
};

exports.setGlobalGratuityDays = async (req, res) => {
  const owner = req.user?._id;
  const { gratuityDaysPaid } = req.body;
  if (!gratuityDaysPaid || gratuityDaysPaid < 1 || gratuityDaysPaid > 30)
    return res.status(400).json({ error: "Value must be 1-30" });

  let settings = await CompanySetting.findOneAndUpdate(
    { owner },
    { gratuityDaysPaid },
    { new: true, upsert: true }
  );
  res.json({ gratuityDaysPaid: settings.gratuityDaysPaid });
};

// Get per-employee gratuity days (returns override or global)
exports.getEmployeeGratuityDays = async (req, res) => {
  const { employeeId } = req.params;
  const emp = await Employee.findById(employeeId);
  if (!emp) return res.status(404).json({ error: "Employee not found" });

  // Get global as fallback
  const settings = await CompanySetting.findOne({ owner: emp.owner });
  const globalDays = settings?.gratuityDaysPaid || 21;
  res.json({
    gratuityDaysPaid: emp.gratuityDaysPaid ?? globalDays,
    override: emp.gratuityDaysPaid !== null,
    globalGratuityDays: globalDays
  });
};

// Set per-employee gratuity days (set to null to use global)
// Also update the salary slip's gratuityFundDeduction for the selected month
exports.setEmployeeGratuityDays = async (req, res) => {
  const { employeeId } = req.params;
  const { gratuityDaysPaid, month, salaryKey } = req.body;
  // month should be e.g. "2025-07", salaryKey is required for update

  if (gratuityDaysPaid !== null && (gratuityDaysPaid < 1 || gratuityDaysPaid > 30))
    return res.status(400).json({ error: "Value must be 1-30 or null" });

  const emp = await Employee.findByIdAndUpdate(
    employeeId,
    { gratuityDaysPaid },
    { new: true }
  );
  if (!emp) return res.status(404).json({ error: "Employee not found" });

  // ---- Update Salary Slip's gratuityFundDeduction for this month if given ----
  if (month && salaryKey) {
    // Find the slip for this employee in this month
    const start = new Date(month + "-01T00:00:00Z");
    const end = new Date(start);
    end.setMonth(end.getMonth() + 1);

    // Find the slip in the correct date range
    const slip = await SalarySlip.findOne({
      employee: employeeId,
      createdAt: { $gte: start, $lt: end }
    });

    if (slip) {
      // Decrypt the basic salary using the provided key
      let basic = "";
      try {
        basic = decryptSalary(slip.basic, salaryKey);
      } catch (e) {
        basic = "";
      }

      // Use the new gratuityDaysPaid, or fall back to global
      const effectiveDays =
        gratuityDaysPaid !== undefined && gratuityDaysPaid !== null
          ? gratuityDaysPaid
          : await getGlobalGratuityDaysForOwner(emp.owner);

      let gratuityAmount = "";
      if (basic && !isNaN(Number(basic))) {
        gratuityAmount = ((Number(basic) * effectiveDays) / 30).toFixed(2);
      } else {
        gratuityAmount = "0";
      }

      // Encrypt before saving!
      const encrypted = encryptSalary(gratuityAmount, salaryKey);

      slip.gratuityFundDeduction = encrypted;
      await slip.save();
    }
  }

  res.json({ gratuityDaysPaid: emp.gratuityDaysPaid });
};

// Helper to get company default gratuity days
async function getGlobalGratuityDaysForOwner(owner) {
  const settings = await CompanySetting.findOne({ owner });
  return settings?.gratuityDaysPaid ?? 21;
}
