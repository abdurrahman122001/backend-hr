const Shift = require("../models/Shift");

// Get shift by ID
exports.getShiftById = async (req, res) => {
  try {
    const shift = await Shift.findById(req.params.id);
    if (!shift) {
      return res.status(404).json({ error: "Shift not found" });
    }
    res.json(shift);
  } catch (err) {
    console.error("Get shift error:", err);
    res.status(500).json({ error: "Server error" });
  }
};

// Get shifts for an employee
exports.getEmployeeShifts = async (req, res) => {
  try {
    const { employeeId } = req.params;
    
    // First get employee to get their shift IDs
    const Employee = require("../models/Employees");
    const employee = await Employee.findById(employeeId).select("shifts");
    
    if (!employee) {
      return res.status(404).json({ error: "Employee not found" });
    }
    
    if (!employee.shifts || employee.shifts.length === 0) {
      return res.json({ shifts: [] });
    }
    
    // Get all shifts for this employee
    const shifts = await Shift.find({ _id: { $in: employee.shifts } });
    
    res.json({ shifts });
  } catch (err) {
    console.error("Get employee shifts error:", err);
    res.status(500).json({ error: "Server error" });
  }
};

// Get current employee's shift
exports.getMyShift = async (req, res) => {
  try {
    const employeeId = req.employee._id || req.employee.id;
    
    const Employee = require("../models/Employees");
    const employee = await Employee.findById(employeeId)
      .select("shifts name companyEmail")
      .populate("shifts");
    
    if (!employee) {
      return res.status(404).json({ error: "Employee not found" });
    }
    
    if (!employee.shifts || employee.shifts.length === 0) {
      return res.status(404).json({ 
        error: "Shift not assigned",
        message: "No shift assigned to this employee" 
      });
    }
    
    // Return primary shift (first one)
    const primaryShift = employee.shifts[0];
    
    res.json({
      shift: primaryShift,
      employee: {
        name: employee.name,
        email: employee.companyEmail
      }
    });
  } catch (err) {
    console.error("Get my shift error:", err);
    res.status(500).json({ error: "Server error" });
  }
};

// Get all shifts (for admin)
exports.getAllShifts = async (req, res) => {
  try {
    const shifts = await Shift.find().sort({ name: 1 });
    res.json({ shifts });
  } catch (err) {
    console.error("Get all shifts error:", err);
    res.status(500).json({ error: "Server error" });
  }
};