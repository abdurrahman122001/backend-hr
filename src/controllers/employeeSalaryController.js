const Employee = require('../models/Employees');
const SalarySlip = require('../models/Salaries');
const Shift = require('../models/Shift');
const { encrypt, decrypt } = require('../utils/encryption');

exports.getEmployeeAndSalarySlip = async (req, res) => {
  try {
    // Validate employee ID
    if (!req.params.id || !req.params.id.match(/^[0-9a-fA-F]{24}$/)) {
      return res.status(400).json({ error: "Invalid employee ID format" });
    }

    // Fetch employee
    const employee = await Employee.findById(req.params.id);
    if (!employee) {
      return res.status(404).json({ error: "Employee not found" });
    }

    // Fetch single salary slip for the employee
    const salarySlip = await SalarySlip.findOne({ employee: req.params.id });

    // Fetch shifts by owner (employee.owner)
    let shifts = [];
    if (employee.owner) {
      shifts = await Shift.find({ owner: employee.owner }).select('_id name start end timezone');
    }

    // Prepare employee object with defaults for all required fields
    let employeeObj = employee.toObject ? employee.toObject() : employee;

    // Fill missing main fields
    const requiredEmployeeFields = [
      "cnic", "companyEmail", "email", "photographUrl",
      "department", "designation", "joiningDate", "shifts"
    ];
    for (const key of requiredEmployeeFields) {
      if (employeeObj[key] === undefined || employeeObj[key] === null) {
        employeeObj[key] = key === "shifts" ? [] : "";
      }
    }

    // Ensure nested objects exist and have defaults
    employeeObj.compensation = employeeObj.compensation ?? {};
    employeeObj.providentFund = employeeObj.providentFund ?? {};

    // For leaveEntitlement
    employeeObj.leaveEntitlement = {
      total: employeeObj.leaveEntitlement?.total ?? 0,
      usedPaid: employeeObj.leaveEntitlement?.usedPaid ?? 0,
      usedUnpaid: employeeObj.leaveEntitlement?.usedUnpaid ?? 0,
      manuallySet: !!employeeObj.leaveEntitlement?.manuallySet,
    };

    // Add required fields for compensation if missing
    const compFields = [
      'basic', 'dearnessAllowance', 'houseRentAllowance',
      'conveyanceAllowance', 'medicalAllowance', 'utilityAllowance',
      'overtimeCompensation', 'dislocationAllowance', 'leaveEncashment',
      'bonus', 'arrears', 'autoAllowance', 'incentive',
      'fuelAllowance', 'othersAllowances', 'grossSalary'
    ];
    for (const field of compFields) {
      if (employeeObj.compensation[field] === undefined || employeeObj.compensation[field] === null) {
        employeeObj.compensation[field] = 0;
      }
    }

    // For providentFund
    employeeObj.providentFund.override = !!employeeObj.providentFund.override;

    // Decrypt salary slip fields if available, ensure all fields present
    let decryptedSalarySlip = salarySlip ? { ...salarySlip.toObject() } : {};
    if (salarySlip) {
      for (const field of compFields) {
        if (decryptedSalarySlip[field]) {
          try {
            // Await the async decrypt function, pass key from query if present
            const decryptedValue = await decrypt(decryptedSalarySlip[field], req.query.key);
            decryptedSalarySlip[field] = isNaN(Number(decryptedValue)) ? 0 : Number(decryptedValue);
          } catch (err) {
            console.warn(`Failed to decrypt ${field}:`, err);
            decryptedSalarySlip[field] = 0;
          }
        } else {
          decryptedSalarySlip[field] = 0;
        }
      }
      // Set non-numeric fields
      decryptedSalarySlip.isActive = decryptedSalarySlip.isActive ?? true;
    } else {
      // Provide default salary slip if none exists
      decryptedSalarySlip = {
        candidateName: employeeObj.name || '',
        candidateEmail: employeeObj.email || '',
        position: employeeObj.designation || '',
        department: employeeObj.department || '',
        startDate: employeeObj.joiningDate || '',
        reportingTime: employeeObj.rt || '',
        month: new Date().toLocaleString("en-US", { month: "long" }),
        year: new Date().getFullYear().toString(),
        isActive: true
      };
      for (const field of compFields) {
        decryptedSalarySlip[field] = 0;
      }
    }

    res.status(200).json({
      employee: employeeObj,
      salarySlip: decryptedSalarySlip,
      shifts,
    });
  } catch (err) {
    console.error('Error in getEmployeeAndSalarySlip:', err);
    res.status(500).json({ 
      error: 'Internal server error', 
      details: err.message 
    });
  }
};

exports.updateEmployeeAndSalarySlip = async (req, res) => {
  try {
    const { employee: employeeData, salarySlip: salarySlipData } = req.body;

    // Validate employee ID
    if (!req.params.id || !req.params.id.match(/^[0-9a-fA-F]{24}$/)) {
      return res.status(400).json({ error: "Invalid employee ID format" });
    }

    // Validate required employee fields
    if (!employeeData.name || !employeeData.cnic) {
      return res.status(400).json({ error: "Employee name and CNIC are required" });
    }

    // Validate CNIC format
    if (!/^\d{5}-\d{7}-\d$/.test(employeeData.cnic)) {
      return res.status(400).json({ error: "Invalid CNIC format (expected: 12345-1234567-1)" });
    }

    // Validate leave entitlement
    if (employeeData.leaveEntitlement && employeeData.leaveEntitlement.total < 0) {
      return res.status(400).json({ error: "Leave entitlement total cannot be negative" });
    }

    // Fetch existing employee
    const existingEmployee = await Employee.findById(req.params.id);
    if (!existingEmployee) {
      return res.status(404).json({ error: "Employee not found" });
    }

    // Prepare employee update
    const employeeUpdate = {
      ...employeeData,
      compensation: {
        ...employeeData.compensation,
        grossSalary: Object.keys(employeeData.compensation || {})
          .filter(key => [
            'basic', 'dearnessAllowance', 'houseRentAllowance',
            'conveyanceAllowance', 'medicalAllowance', 'utilityAllowance',
            'overtimeCompensation', 'dislocationAllowance', 'leaveEncashment',
            'bonus', 'arrears', 'autoAllowance', 'incentive',
            'fuelAllowance', 'othersAllowances'
          ].includes(key))
          .reduce((sum, key) => sum + Number(employeeData.compensation[key] || 0), 0)
      }
    };

    // Update employee
    const updatedEmployee = await Employee.findByIdAndUpdate(
      req.params.id,
      { $set: employeeUpdate },
      { new: true, runValidators: true }
    );

    // Prepare salary slip update
    let salarySlipUpdate = { ...salarySlipData, employee: req.params.id };

    // Encrypt sensitive salary fields
    const compFields = [
      'basic', 'dearnessAllowance', 'houseRentAllowance',
      'conveyanceAllowance', 'medicalAllowance', 'utilityAllowance',
      'overtimeCompensation', 'dislocationAllowance', 'leaveEncashment',
      'bonus', 'arrears', 'autoAllowance', 'incentive',
      'fuelAllowance', 'othersAllowances', 'grossSalary'
    ];

    for (const field of compFields) {
      if (salarySlipUpdate[field] !== undefined && salarySlipUpdate[field] !== null) {
        try {
          salarySlipUpdate[field] = await encrypt(salarySlipUpdate[field].toString());
        } catch (err) {
          console.warn(`Failed to encrypt ${field}:`, err);
          return res.status(500).json({ error: `Failed to encrypt ${field}` });
        }
      }
    }

    // Calculate gross salary for salary slip
    let grossSalarySum = 0;
    for (const field of compFields.filter(field => field !== 'grossSalary')) {
      try {
        const decryptedValue = salarySlipUpdate[field]
          ? Number(await decrypt(salarySlipUpdate[field], req.query.key))
          : 0;
        grossSalarySum += isNaN(decryptedValue) ? 0 : decryptedValue;
      } catch (err) {
        console.warn(`Failed to decrypt ${field} for gross salary calculation:`, err);
      }
    }
    salarySlipUpdate.grossSalary = grossSalarySum;

    // Encrypt gross salary
    try {
      salarySlipUpdate.grossSalary = await encrypt(salarySlipUpdate.grossSalary.toString());
    } catch (err) {
      console.warn('Failed to encrypt grossSalary:', err);
      return res.status(500).json({ error: 'Failed to encrypt grossSalary' });
    }

    // Update or create salary slip
    const existingSalarySlip = await SalarySlip.findOne({ employee: req.params.id });
    let updatedSalarySlip;
    if (existingSalarySlip) {
      updatedSalarySlip = await SalarySlip.findOneAndUpdate(
        { employee: req.params.id },
        { $set: salarySlipUpdate },
        { new: true, runValidators: true }
      );
    } else {
      updatedSalarySlip = await SalarySlip.create(salarySlipUpdate);
    }

    // Decrypt salary slip fields for response
    let decryptedSalarySlip = updatedSalarySlip.toObject();
    for (const field of compFields) {
      if (decryptedSalarySlip[field]) {
        try {
          const decryptedValue = await decrypt(decryptedSalarySlip[field], req.query.key);
          decryptedSalarySlip[field] = isNaN(Number(decryptedValue)) ? 0 : Number(decryptedValue);
        } catch (err) {
          console.warn(`Failed to decrypt ${field}:`, err);
          decryptedSalarySlip[field] = 0;
        }
      } else {
        decryptedSalarySlip[field] = 0;
      }
    }

    res.status(200).json({
      employee: updatedEmployee,
      salarySlip: decryptedSalarySlip,
      message: 'Employee and salary slip updated successfully'
    });
  } catch (err) {
    console.error('Error in updateEmployeeAndSalarySlip:', err);
    res.status(500).json({ 
      error: 'Internal server error', 
      details: err.message 
    });
  }
};