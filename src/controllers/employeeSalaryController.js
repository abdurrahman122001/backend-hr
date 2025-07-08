const Employee = require('../models/Employees');
const SalarySlip = require('../models/SalarySlip');
const Shift = require('../models/Shift'); // <-- Add your Shift model import

// GET: Fetch employee, latest salary slip, and available shifts (by owner)
exports.getEmployeeAndSalarySlip = async (req, res) => {
  try {
    const employee = await Employee.findById(req.params.id);
    if (!employee) return res.status(404).json({ error: "Employee not found" });

    const salarySlip = await SalarySlip.findOne({ employee: req.params.id }).sort({ createdAt: -1 });

    // Fetch shifts by owner (employee.owner)
    let shifts = [];
    if (employee.owner) {
      shifts = await Shift.find({ owner: employee.owner });
    }

    res.json({
      employee,
      salarySlip: salarySlip || null,
      shifts, // Add to response
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// PUT: Update both employee and latest salary slip (no change needed here)
exports.updateEmployeeAndSalarySlip = async (req, res) => {
  try {
    const employeeId = req.params.id;
    const { employee: employeeData, salarySlip: slipData } = req.body;

    // Update Employee (all fields)
    const updatedEmployee = await Employee.findByIdAndUpdate(
      employeeId,
      employeeData,
      { new: true, runValidators: true }
    );
    if (!updatedEmployee) return res.status(404).json({ error: "Employee not found" });

    // Find latest salary slip, update or create if not found
    let salarySlip = await SalarySlip.findOne({ employee: employeeId }).sort({ createdAt: -1 });
    if (salarySlip) {
      Object.assign(salarySlip, slipData);
      await salarySlip.save();
    } else {
      salarySlip = new SalarySlip({ ...slipData, employee: employeeId });
      await salarySlip.save();
    }

    res.json({
      employee: updatedEmployee,
      salarySlip,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};
