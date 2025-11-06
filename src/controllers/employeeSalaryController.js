const Employee = require('../models/Employees');
const SalarySlip = require('../models/Salaries');
const Shift = require('../models/Shift');
const { encrypt, decrypt } = require('../utils/encryption');
const { sendCompleteProfileLink } = require('../services/profileEmailService');
const path = require('path');
const fs = require('fs');
/** --- helpers --- */
const isValidObjectId = (id) => /^[0-9a-fA-F]{24}$/.test(id);
const CNIC_REGEX = /^\d{5}-\d{7}-\d$/;

const COMP_FIELDS = [
  'basic','dearnessAllowance','houseRentAllowance','conveyanceAllowance',
  'medicalAllowance','utilityAllowance','overtimeCompensation','dislocationAllowance',
  'leaveEncashment','bonus','arrears','autoAllowance','incentive',
  'fuelAllowance','othersAllowances','grossSalary'
];

const safeNumber = (v, def = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
};

exports.getEmployeeAndSalarySlip = async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({ error: "Invalid employee ID format" });
    }

    const employee = await Employee.findById(req.params.id);
    if (!employee) {
      return res.status(404).json({ error: "Employee not found" });
    }

    const salarySlip = await SalarySlip.findOne({ employee: req.params.id });

    // fetch shifts (by owner)
    let shifts = [];
    if (employee.owner) {
      shifts = await Shift.find({ owner: employee.owner })
        .select('_id name start end timezone');
    }

    // build employee object with safe defaults for nested structs only
    let employeeObj = employee.toObject ? employee.toObject() : employee;
    employeeObj.compensation = employeeObj.compensation ?? {};
    employeeObj.providentFund = employeeObj.providentFund ?? {};
    employeeObj.leaveEntitlement = {
      total: employeeObj.leaveEntitlement?.total ?? 0,
      usedPaid: employeeObj.leaveEntitlement?.usedPaid ?? 0,
      usedUnpaid: employeeObj.leaveEntitlement?.usedUnpaid ?? 0,
      manuallySet: !!employeeObj.leaveEntitlement?.manuallySet,
    };
    // ensure numeric comp fields exist (frontend safety)
    for (const f of COMP_FIELDS) {
      if (employeeObj.compensation[f] === undefined || employeeObj.compensation[f] === null) {
        employeeObj.compensation[f] = 0;
      }
    }
    employeeObj.providentFund.override = !!employeeObj.providentFund.override;

    // salary slip -> decrypted view for FE
    let decryptedSalarySlip = salarySlip ? { ...salarySlip.toObject() } : {};
    if (salarySlip) {
      for (const field of COMP_FIELDS) {
        if (decryptedSalarySlip[field]) {
          try {
            const dv = await decrypt(decryptedSalarySlip[field], req.query.key);
            decryptedSalarySlip[field] = safeNumber(dv, 0);
          } catch (err) {
            console.warn(`Failed to decrypt ${field}:`, err);
            decryptedSalarySlip[field] = 0;
          }
        } else {
          decryptedSalarySlip[field] = 0;
        }
      }
      decryptedSalarySlip.isActive = decryptedSalarySlip.isActive ?? true;
    } else {
      // default view if no slip yet
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
      for (const f of COMP_FIELDS) decryptedSalarySlip[f] = 0;
    }

    res.status(200).json({
      employee: employeeObj,
      salarySlip: decryptedSalarySlip,
      shifts,
    });
  } catch (err) {
    console.error("Error in getEmployeeAndSalarySlip:", err);
    res.status(500).json({ error: "Internal server error", details: err.message });
  }
};

exports.updateEmployeeAndSalarySlip = async (req, res) => {
  try {
    const { employee: employeeData = {}, salarySlip: salarySlipData = {} } = req.body;

    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({ error: "Invalid employee ID format" });
    }

    // Fetch existing docs
    const existingEmployee = await Employee.findById(req.params.id);
    if (!existingEmployee) {
      return res.status(404).json({ error: "Employee not found" });
    }
    const existingSalarySlip = await SalarySlip.findOne({ employee: req.params.id });

    /** Build $set for employee (partial, tolerant) */
    const employeeSet = {};
    // Shallow keys
    const shallowKeys = [
      'name','owner','cnic','email','companyEmail','password',
      'fatherOrHusbandName','photographUrl','dateOfBirth','gender','nationality',
      'cnicIssueDate','cnicExpiryDate','maritalStatus','religion',
      'latestQualification','fieldOfQualification','otherQualification','otherFieldOfQualification',
      'phone','permanentAddress','presentAddress','bankName','bankAccountNumber',
      'nomineeName','nomineeRelation','nomineeCnic','nomineeNo',
      'rt','department','designation','joiningDate','leavingDate', // <-- added leavingDate
      'isHR','isAdmin','userAccount', 'role'
    ];
    for (const k of shallowKeys) {
      if (k in employeeData && employeeData[k] !== undefined) {
        if (k === 'cnic') {
          // Ignore invalid CNIC rather than fail
          if (typeof employeeData.cnic === 'string' && CNIC_REGEX.test(employeeData.cnic)) {
            employeeSet.cnic = employeeData.cnic;
          }
        } else {
          employeeSet[k] = employeeData[k];
        }
      }
    }

    // shifts (ensure array)
    if ('shifts' in employeeData && employeeData.shifts !== undefined) {
      employeeSet.shifts = Array.isArray(employeeData.shifts) ? employeeData.shifts : [];
    }

    // leaveEntitlement (clamp numbers, partial)
    if ('leaveEntitlement' in employeeData && employeeData.leaveEntitlement) {
      const le = employeeData.leaveEntitlement || {};
      employeeSet['leaveEntitlement.total']      = Math.max(0, safeNumber(le.total, 0));
      employeeSet['leaveEntitlement.usedPaid']   = Math.max(0, safeNumber(le.usedPaid, 0));
      employeeSet['leaveEntitlement.usedUnpaid'] = Math.max(0, safeNumber(le.usedUnpaid, 0));
      employeeSet['leaveEntitlement.manuallySet']= !!le.manuallySet;
    }

    // compensation (partial numeric merge)
    if ('compensation' in employeeData && employeeData.compensation) {
      for (const f of COMP_FIELDS) {
        if (f in employeeData.compensation && employeeData.compensation[f] !== undefined) {
          employeeSet[`compensation.${f}`] = safeNumber(employeeData.compensation[f], 0);
        }
      }
      // if no explicit gross provided, we can sum the provided pieces we are updating
      // but to keep this tolerant (no surprise overwrites), only set gross if user sent it.
      if ('grossSalary' in employeeData.compensation) {
        employeeSet['compensation.grossSalary'] = safeNumber(employeeData.compensation.grossSalary, 0);
      }
    }

    // Update employee (no validator-based 400s)
    const updatedEmployee = await Employee.findByIdAndUpdate(
      req.params.id,
      { $set: employeeSet },
      { new: true, runValidators: false } // tolerant
    );

    /** Build $set for salary slip (partial, tolerant) */
    let updatedSalarySlip;
    if (salarySlipData && Object.keys(salarySlipData).length > 0) {
      const slipSet = {};

      // copy non-comp fields directly if provided
      const nonCompKeys = [
        'candidateName','candidateEmail','position','department',
        'startDate','reportingTime','month','year','isActive'
      ];
      for (const k of nonCompKeys) {
        if (k in salarySlipData && salarySlipData[k] !== undefined) {
          slipSet[k] = salarySlipData[k];
        }
      }

      // encrypt only provided comp fields (partial)
      const providedComp = [];
      for (const f of COMP_FIELDS) {
        if (f in salarySlipData && salarySlipData[f] !== undefined) {
          const val = safeNumber(salarySlipData[f], 0);
          try {
            slipSet[f] = await encrypt(String(val));
            providedComp.push(f);
          } catch (err) {
            console.warn(`Failed to encrypt ${f}:`, err);
            // skip this field (don’t fail whole request)
          }
        }
      }

      // If grossSalary wasn't explicitly provided but some components were provided:
      if (!('grossSalary' in salarySlipData) && providedComp.some(f => f !== 'grossSalary')) {
        // Best-effort re-calc: If we have a key and existing slip, merge old+new to compute.
        if (existingSalarySlip && req.query.key) {
          try {
            // Build merged numeric view for sum
            const merged = {};
            // start from existing decrypted (where possible)
            for (const f of COMP_FIELDS) {
              if (f === 'grossSalary') continue;
              let base = 0;
              if (existingSalarySlip[f]) {
                try {
                  base = safeNumber(await decrypt(existingSalarySlip[f], req.query.key), 0);
                } catch { base = 0; }
              }
              merged[f] = base;
            }
            // overlay with newly provided numeric values
            for (const f of providedComp) {
              if (f !== 'grossSalary') {
                merged[f] = safeNumber(salarySlipData[f], 0);
              }
            }
            // sum
            let gross = 0;
            for (const f of COMP_FIELDS) {
              if (f !== 'grossSalary') gross += safeNumber(merged[f], 0);
            }
            slipSet['grossSalary'] = await encrypt(String(gross));
          } catch (err) {
            console.warn('Failed to recompute/encrypt grossSalary, leaving unchanged:', err);
          }
        }
        // if no key or no existing slip, we leave grossSalary unchanged (tolerant).
      }

      // upsert/update salary slip
      if (existingSalarySlip) {
        updatedSalarySlip = await SalarySlip.findOneAndUpdate(
          { employee: req.params.id },
          { $set: { ...slipSet, employee: req.params.id } },
          { new: true, runValidators: false }
        );
      } else {
        updatedSalarySlip = await SalarySlip.create({ ...slipSet, employee: req.params.id });
      }
    } else {
      updatedSalarySlip = existingSalarySlip || null;
    }

    // Build decrypted salary slip response (tolerant if no key)
    let decryptedSalarySlip = null;
    if (updatedSalarySlip) {
      const raw = updatedSalarySlip.toObject();
      decryptedSalarySlip = { ...raw };
      for (const f of COMP_FIELDS) {
        if (raw[f]) {
          try {
            const dv = await decrypt(raw[f], req.query.key);
            decryptedSalarySlip[f] = safeNumber(dv, 0);
          } catch (err) {
            decryptedSalarySlip[f] = 0;
          }
        } else {
          decryptedSalarySlip[f] = 0;
        }
      }
    }

    res.status(200).json({
      employee: updatedEmployee,
      salarySlip: decryptedSalarySlip,
      message: 'Employee and salary slip updated successfully (tolerant update).'
    });
  } catch (err) {
    console.error('Error in updateEmployeeAndSalarySlip:', err);
    res.status(500).json({ error: 'Internal server error', details: err.message });
  }
};

exports.updateEmployeePhoto = async (req, res) => {
  try {
    const { id } = req.params;

    if (!req.file) {
      return res.status(400).json({ success: false, message: "No photo uploaded" });
    }

    // New photo URL
    const photoUrl = `/uploads/photos/${req.file.filename}`;

    // Fetch employee to delete old photo if it exists
    const employee = await Employee.findById(id);
    if (!employee) {
      return res.status(404).json({ success: false, message: "Employee not found" });
    }

    // Delete old photo from disk if it exists
    if (employee.photographUrl) {
      const oldPath = path.join(__dirname, "..", employee.photographUrl);
      fs.unlink(oldPath, (err) => {
        if (err && err.code !== "ENOENT") {
          console.warn("Failed to delete old photo:", err);
        }
      });
    }

    // Update new photo URL
    employee.photographUrl = photoUrl;
    await employee.save();

    res.json({
      success: true,
      message: "Employee photo updated successfully",
      photoUrl,
    });
  } catch (err) {
    console.error("Photo upload error:", err);
    res.status(500).json({
      success: false,
      message: "Failed to upload photo",
      error: err.message,
    });
  }
};

exports.resendCompleteProfileLink = async (req, res) => {
  try {
    const { id } = req.params;
    if (!/^[0-9a-fA-F]{24}$/.test(id)) {
      return res.status(400).json({ message: "Invalid employee ID format" });
    }
    const emp = await Employee.findById(id);
    if (!emp) return res.status(404).json({ message: "Employee not found" });
    if (!emp.email) return res.status(400).json({ message: "Employee email is missing" });

    const ownerId = emp.owner || DEFAULT_OWNER_ID;
    await sendCompleteProfileLink({
      id: emp._id.toString(),
      to: emp.email,
      employeeName: emp.name || "Employee",
      ownerId,
    });

    return res.json({ success: true, message: "Complete-profile email resent." });
  } catch (err) {
    console.error("resendCompleteProfileLink error:", err);
    return res.status(500).json({ message: err.message || "Failed to resend profile email" });
  }
};
