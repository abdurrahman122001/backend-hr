const path = require("path");
const fs = require("fs");
const Employee = require("../models/Employees");

// [GET] List all employees with NDA generated
exports.getEmployeesWithNda = async (req, res) => {
  try {
    const employees = await Employee.find({ ndaGenerated: true }).lean();
    return res.json(employees.map(emp => ({
      _id: emp._id,
      name: emp.name,
      email: emp.email,
      cnic: emp.cnic,
    })));
  } catch (err) {
    return res.status(500).json({ error: "Server error" });
  }
};

// [GET] Serve NDA PDF file for an employee if exists
exports.getNdaPdf = (req, res) => {
  const employeeId = req.params.employeeId;
  const ndaPath = path.join(__dirname, "../ndas", `${employeeId}.pdf`);
  if (!fs.existsSync(ndaPath)) {
    return res.status(404).json({ error: "NDA PDF not available for this employee." });
  }
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", "inline; filename=NDA.pdf");
  fs.createReadStream(ndaPath).pipe(res);
};
