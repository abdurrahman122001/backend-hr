const Employee = require("../models/Employee");
const SalarySlip = require("../models/SalarySlip");

// ...your other methods...

exports.updateEmployeeAndSalarySlip = async (req, res) => {
  try {
    const { id } = req.params;
    const { employee: employeeData, salarySlip: salarySlipData } = req.body;

    // Find employee
    const employee = await Employee.findById(id);
    if (!employee) return res.status(404).json({ error: "Employee not found" });

    // Update employee fields (iterate keys in employeeData)
    Object.keys(employeeData).forEach((key) => {
      if (key === "shifts") {
        // Ensure shifts is always an array of IDs
        if (Array.isArray(employeeData.shifts)) {
          employee.shifts = employeeData.shifts;
        } else if (employeeData.shifts) {
          employee.shifts = [employeeData.shifts];
        } else {
          employee.shifts = [];
        }
      } else {
        employee[key] = employeeData[key];
      }
    });

    await employee.save();

    // Update latest salary slip (if any salarySlipData provided)
    let salarySlip = await SalarySlip.findOne({ employee: id }).sort({ createdAt: -1 });
    if (salarySlip && salarySlipData) {
      Object.keys(salarySlipData).forEach((key) => {
        if (key === "loanDeductions" && typeof salarySlipData.loanDeductions === "object") {
          salarySlip.loanDeductions = {
            ...salarySlip.loanDeductions,
            ...salarySlipData.loanDeductions,
          };
        } else {
          salarySlip[key] = salarySlipData[key];
        }
      });
      await salarySlip.save();
    }

    res.json({ success: true, employee, salarySlip });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update employee or salary slip" });
  }
};
