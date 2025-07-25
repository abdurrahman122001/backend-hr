const CompanySetting = require("../models/GratuitySetting");
const Employee = require("../models/Employees");
const SalarySlip = require("../models/SalarySlip");
const { encrypt, decrypt } = require("../utils/encryption");

// Helper to get company default gratuity days
async function getGlobalGratuityDaysForOwner(owner) {
  const settings = await CompanySetting.findOne({ owner });
  return settings?.gratuityDaysPaid ?? 21;
}

// Get global gratuity days for company
exports.getGlobalGratuityDays = async (req, res) => {
  const owner = req.user?._id;
  let settings = await CompanySetting.findOne({ owner });
  if (!settings) {
    settings = await CompanySetting.create({ owner, gratuityDaysPaid: 21 });
  }
  res.json({ gratuityDaysPaid: settings.gratuityDaysPaid });
};

// Set global gratuity days
exports.setGlobalGratuityDays = async (req, res) => {
  const owner = req.user?._id;
  const { gratuityDaysPaid } = req.body;
  if (
    !gratuityDaysPaid ||
    gratuityDaysPaid < 1 ||
    gratuityDaysPaid > 30
  ) {
    return res.status(400).json({ error: "Value must be 1-30" });
  }

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

  // Verify ownership
  if (emp.owner.toString() !== req.user._id.toString()) {
    return res.status(403).json({ error: "Unauthorized: Not your employee" });
  }

  // Get global as fallback
  const settings = await CompanySetting.findOne({ owner: emp.owner });
  const globalDays = settings?.gratuityDaysPaid || 21;
  res.json({
    gratuityDaysPaid: emp.gratuityDaysPaid ?? globalDays,
    override: emp.gratuityDaysPaid !== null,
    globalGratuityDays: globalDays,
  });
};

// Set per-employee gratuity days (set to null to use global)
// Also update the salary slip's gratuityFundDeduction for the selected month
exports.setEmployeeGratuityDays = async (req, res) => {
  const { employeeId } = req.params;
  const { gratuityDaysPaid, month, salaryKey } = req.body;

  if (
    gratuityDaysPaid !== null &&
    (gratuityDaysPaid < 1 || gratuityDaysPaid > 30)
  ) {
    return res.status(400).json({ error: "Value must be 1-30 or null" });
  }

  const emp = await Employee.findById(employeeId);
  if (!emp) return res.status(404).json({ error: "Employee not found" });

  // Verify ownership
  if (emp.owner.toString() !== req.user._id.toString()) {
    return res.status(403).json({ error: "Unauthorized: Not your employee" });
  }

  // Update employee gratuity days
  emp.gratuityDaysPaid = gratuityDaysPaid;
  await emp.save();

  // Update Salary Slip's gratuityFundDeduction for this month if given
  if (month && salaryKey) {
    const start = new Date(month + "-01T00:00:00Z");
    const end = new Date(start);
    end.setMonth(end.getMonth() + 1);

    const slip = await SalarySlip.findOne({
      employee: employeeId,
      createdAt: { $gte: start, $lt: end },
    });

    if (slip) {
      let basic = "";
      try {
        basic = decrypt(slip.basic, salaryKey);
        // Validate that decrypted basic is a string
        if (typeof basic !== "string") {
          console.error(
            "Decrypted basic salary is not a string in setEmployeeGratuityDays:",
            typeof basic,
            basic,
            "for employee:",
            employeeId
          );
          return res.status(400).json({
            error: "Decrypted basic salary is not a valid string.",
            decryptedType: typeof basic,
          });
        }
        // Trim whitespace and check for empty string
        const trimmedBasic = basic.trim();
        if (trimmedBasic === "") {
          console.error(
            "Decrypted basic salary is empty in setEmployeeGratuityDays for employee:",
            employeeId
          );
          return res.status(400).json({ error: "Decrypted basic salary is empty." });
        }
        // Convert to number and validate
        const basicNumber = Number(trimmedBasic);
        if (isNaN(basicNumber) || !isFinite(basicNumber)) {
          console.error(
            "Invalid decrypted basic salary value:",
            trimmedBasic,
            "for employee:",
            employeeId
          );
          return res.status(400).json({
            error: "Decrypted basic salary is not a valid number.",
            decryptedValue: trimmedBasic,
          });
        }
        // Ensure non-negative
        if (basicNumber < 0) {
          console.error(
            "Decrypted basic salary is negative:",
            basicNumber,
            "for employee:",
            employeeId
          );
          return res.status(400).json({ error: "Decrypted basic salary cannot be negative." });
        }
        basic = basicNumber;
      } catch (e) {
        console.error("Decryption failed in setEmployeeGratuityDays:", e.message, "for employee:", employeeId);
        return res.status(400).json({ error: "Invalid salary key" });
      }

      const effectiveDays =
        gratuityDaysPaid !== undefined && gratuityDaysPaid !== null
          ? gratuityDaysPaid
          : await getGlobalGratuityDaysForOwner(emp.owner);

      let gratuityAmount = "";
      if (!isNaN(basic)) {
        gratuityAmount = ((basic * effectiveDays) / 30).toFixed(2);
      } else {
        console.error("Unexpected: basic is not a number after validation:", basic, "for employee:", employeeId);
        gratuityAmount = "0";
      }

      const encrypted = encrypt(gratuityAmount, salaryKey);
      slip.gratuityFundDeduction = encrypted;
      await slip.save();
    }
  }

  res.json({ gratuityDaysPaid: emp.gratuityDaysPaid });
};

// Get all employees with gratuity data
exports.getAllEmployeesGratuity = async (req, res) => {
  try {
    const owner = req.user?._id;
    const employees = await Employee.find(
      { owner },
      { name: 1, gratuityDaysPaid: 1, _id: 1 }
    ).lean();

    // Get global gratuity settings
    const settings = await CompanySetting.findOne({ owner }).lean();
    const globalDays = settings?.gratuityDaysPaid ?? 21;

    // Get latest salary slips for all employees
    const slips = await SalarySlip.aggregate([
      { $match: { employee: { $in: employees.map(emp => emp._id) } } },
      { $sort: { createdAt: -1 } },
      {
        $group: {
          _id: "$employee",
          basic: { $first: "$basic" },
          createdAt: { $first: "$createdAt" },
        },
      },
    ]);
    const slipMap = {};
    for (const slip of slips) {
      slipMap[slip._id.toString()] = {
        basic: slip.basic,
        createdAt: slip.createdAt,
      };
    }

    const list = employees.map((emp) => ({
      _id: emp._id,
      name: emp.name || "Unnamed",
      gratuityDaysPaid: emp.gratuityDaysPaid ?? null,
      override: emp.gratuityDaysPaid !== null,
      basicSalary: slipMap[emp._id.toString()]?.basic ?? null,
      salarySlipDate: slipMap[emp._id.toString()]?.createdAt ?? null,
    }));

    res.json({
      status: "success",
      data: list,
      globalGratuityDays: globalDays,
    });
  } catch (err) {
    console.error("Error in getAllEmployeesGratuity:", err);
    res.status(500).json({ error: "Failed to fetch employees gratuity data" });
  }
};

// Decrypt basic salary for employee with user-provided key
exports.decryptBasicSalary = async (req, res) => {
  const { key } = req.body;
  if (!key) return res.status(400).json({ error: "Decryption key required." });

  try {
    const empId = req.params.empId;
    const emp = await Employee.findById(empId);
    if (!emp) return res.status(404).json({ error: "Employee not found" });

    // Verify ownership
    if (emp.owner.toString() !== req.user._id.toString()) {
      return res.status(403).json({ error: "Unauthorized: Not your employee" });
    }

    const slip = await SalarySlip.findOne({ employee: empId }).sort({
      createdAt: -1,
    });
    if (!slip || !slip.basic) {
      return res.status(404).json({ error: "No salary slip found for this employee." });
    }

    try {
      const decryptedSalary = decrypt(slip.basic, key);
      // Validate that decryptedSalary is a string
      if (typeof decryptedSalary !== "string") {
        console.error(
          "Decrypted salary is not a string in decryptBasicSalary:",
          typeof decryptedSalary,
          decryptedSalary,
          "for employee:",
          empId
        );
        return res.status(400).json({
          error: "Decrypted salary is not a valid string.",
          decryptedType: typeof decryptedSalary,
          decryptedValue: JSON.stringify(decryptedSalary), // Stringify for safety
        });
      }
      // Trim whitespace and check for empty string
      const trimmedSalary = decryptedSalary.trim();
      if (trimmedSalary === "") {
        console.error("Decrypted salary is empty in decryptBasicSalary for employee:", empId);
        return res.status(400).json({ error: "Decrypted salary is empty." });
      }
      // Convert to number and validate
      const basicSalary = Number(trimmedSalary);
      if (isNaN(basicSalary) || !isFinite(basicSalary)) {
        console.error(
          "Invalid decrypted salary value:",
          trimmedSalary,
          "for employee:",
          empId
        );
        return res.status(400).json({
          error: "Decrypted salary is not a valid number.",
          decryptedValue: trimmedSalary,
        });
      }
      // Ensure the number is non-negative
      if (basicSalary < 0) {
        console.error(
          "Decrypted salary is negative:",
          basicSalary,
          "for employee:",
          empId
        );
        return res.status(400).json({ error: "Decrypted salary cannot be negative." });
      }
      return res.json({ basicSalary });
    } catch (err) {
      console.error("Decryption error in decryptBasicSalary for employee:", empId, err.message);
      return res.status(401).json({ error: "Invalid decryption key." });
    }
  } catch (err) {
    console.error("Server error in decryptBasicSalary for employee:", empId, err);
    res.status(500).json({ error: "Failed to decrypt basic salary." });
  }
};