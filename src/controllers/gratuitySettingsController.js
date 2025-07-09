const CompanySetting = require("../models/GratuitySetting");
const Employee = require("../models/Employees");

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
exports.setEmployeeGratuityDays = async (req, res) => {
  const { employeeId } = req.params;
  const { gratuityDaysPaid } = req.body;
  if (gratuityDaysPaid !== null && (gratuityDaysPaid < 1 || gratuityDaysPaid > 30))
    return res.status(400).json({ error: "Value must be 1-30 or null" });

  const emp = await Employee.findByIdAndUpdate(
    employeeId,
    { gratuityDaysPaid }, // if null, removes override
    { new: true }
  );
  if (!emp) return res.status(404).json({ error: "Employee not found" });
  res.json({ gratuityDaysPaid: emp.gratuityDaysPaid });
};
