const Employee = require("../models/Employees");
const SalarySlip = require("../models/Salaries");
const SalaryRevisionHistory = require("../models/SalaryRevisionHistory");
const Shift = require("../models/Shift");
const TaxConfig = require("../models/TaxConfig");
const { encrypt, decrypt } = require("../utils/encryption");
const { sendCompleteProfileLink } = require("../services/profileEmailService");
const path = require("path");
const fs = require("fs");

/** --- helpers --- */
const isValidObjectId = (id) => /^[0-9a-fA-F]{24}$/.test(id);
const CNIC_REGEX = /^\d{5}-\d{7}-\d$/;

const COMP_FIELDS = [
  "basic",
  "dearnessAllowance",
  "houseRentAllowance",
  "conveyanceAllowance",
  "medicalAllowance",
  "utilityAllowance",
  "overtimeCompensation",
  "dislocationAllowance",
  "leaveEncashment",
  "bonus",
  "arrears",
  "autoAllowance",
  "incentive",
  "fuelAllowance",
  "othersAllowances",
  "grossSalary",
];

// Tax calculation fields
const TAX_FIELDS = [
  "taxDeduction",
  "annualTaxDeduction",
  "leaveDeductions",
  "totalAllowances",
  "totalDeductions",
  "netPayable",
];

const safeNumber = (v, def = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
};

/* ---------------------------- Tax Calculation Logic ---------------------------- */

const toNum = (v) => {
  if (v === null || v === undefined) return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const n = Number(String(v).replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : 0;
};

const toStr = (num) => Math.round(Number(num) || 0).toString();

/** Decrypt number from encrypted field */
const readEncNumberAsync = async (maybeEnc, fieldName = "") => {
  if (maybeEnc === null || maybeEnc === undefined) return 0;
  if (typeof maybeEnc === "number") return toNum(maybeEnc);
  const raw = String(maybeEnc).trim();
  if (!raw) return 0;
  try {
    const decMaybe = decrypt(raw);
    const dec =
      typeof decMaybe?.then === "function" ? await decMaybe : decMaybe;
    const num = toNum(dec);
    return num;
  } catch {
    const num = toNum(raw);
    return num;
  }
};

/** Encrypt and save value */
const writeEnc = async (doc, key, value) => {
  const encMaybe = encrypt(toStr(value));
  doc[key] = typeof encMaybe?.then === "function" ? await encMaybe : encMaybe;
};

/** Read first existing key */
const readFirstNumAsync = async (obj, keys) => {
  for (const k of keys) {
    const path = k.split(".");
    let cur = obj;
    for (const p of path) cur = cur?.[p];
    const n = await readEncNumberAsync(cur, k);
    if (n !== 0 || (cur !== undefined && cur !== "")) return n;
  }
  return 0;
};

function computeAnnualTaxBandOnly(annualTaxable, rawSlabs = []) {
  const A = Math.max(0, toNum(annualTaxable));

  const slabs = (rawSlabs || [])
    .map((s) => ({
      from: toNum(s.from),
      to: s.to == null ? Infinity : toNum(s.to),
      fixed: toNum(s.fixed),
      rate: toNum(s.rateOver) / 100,
    }))
    .filter((s) => Number.isFinite(s.from) && s.to >= s.from)
    .sort((a, b) => a.from - b.from);

  if (!slabs.length) return 0;

  for (const s of slabs) {
    if (A >= s.from && A <= s.to) {
      // ⭐ FIXED FORMULA:
      // annualTax = fixed + (A - s.from) * rate
      const over = Math.max(0, A - s.from);
      const tax = Math.round(s.fixed + over * s.rate);
      return tax;
    }
  }

  // If highest slab (open ended)
  const last = slabs[slabs.length - 1];
  if (last.to === Infinity) {
    const over = Math.max(0, A - last.from);
    const tax = Math.round(last.fixed + over * last.rate);

    return tax;
  }

  return 0;
}

async function calculateTaxForSalarySlip(salarySlip, taxCfg) {
  try {
    // 1) Calculate Gross Monthly Salary
    let grossMonthly = 0;
    for (const key of COMP_FIELDS) {
      if (key !== "grossSalary") {
        const value = await readFirstNumAsync(salarySlip, [key]);
        grossMonthly += value;
      }
    }

    const providedGross = await readFirstNumAsync(salarySlip, ["grossSalary"]);
    const finalGrossMonthly = providedGross > 0 ? providedGross : grossMonthly;

    const basic = await readFirstNumAsync(salarySlip, ["basic"]);
    const medMonthly = await readFirstNumAsync(salarySlip, [
      "medicalAllowance",
    ]);

    /* ------------------------------------------------------------
       2) MEDICAL EXEMPTION (Pakistan Law)
    ------------------------------------------------------------ */
    const medExemptMonthly = taxCfg?.enableMedicalExemption
      ? medMonthly   // FULL medical allowance exempt
      : 0;

    /* ------------------------------------------------------------
       3) TAXABLE MONTHLY INCOME
    ------------------------------------------------------------ */
    const taxableMonthly = Math.max(0, finalGrossMonthly - medExemptMonthly);

    /* ------------------------------------------------------------
       4) JOINING DATE BASED MONTH COUNT
    ------------------------------------------------------------ */

    // default fiscal year = July → June
    const fiscalStartMonth = 7; // July
    const fiscalEndMonth = 6; // June

    let joiningDate = null;
    if (salarySlip?.employee?.joiningDate) {
      joiningDate = new Date(salarySlip.employee.joiningDate);
    }

    const slipMonth = salarySlip.month;
    const slipYearNum = parseInt(salarySlip.year || new Date().getFullYear());
    
    // Month name to index lookup
    const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    const slipMonthIndex = monthNames.indexOf(slipMonth);

    const fiscalStart = new Date(slipYearNum, fiscalStartMonth - 1, 1);
    
    // If slip month is Jan–Jun, fiscal year started last calendar year
    if (slipMonthIndex !== -1 && slipMonthIndex + 1 <= fiscalEndMonth) {
      fiscalStart.setFullYear(fiscalStart.getFullYear() - 1);
    }

    const effectiveStart =
      joiningDate && joiningDate > fiscalStart ? joiningDate : fiscalStart;

    // Calculate remaining months including the joining month
    const fiscalEnd = new Date(
      fiscalStart.getFullYear() + 1,
      fiscalEndMonth - 1,
      1
    );
    fiscalEnd.setMonth(fiscalEnd.getMonth() + 1); // move to next month for full-cycle calculation

    let monthsRemaining =
      (fiscalEnd.getFullYear() - effectiveStart.getFullYear()) * 12 +
      (fiscalEnd.getMonth() - effectiveStart.getMonth());

    if (monthsRemaining < 1) monthsRemaining = 1; // Safety

    /* ------------------------------------------------------------
       5) Annual Taxable Income Using Remaining Months
    ------------------------------------------------------------ */
    const annualTaxable = taxableMonthly * monthsRemaining;

    /* ------------------------------------------------------------
       6) Slab Calculation (annual)
    ------------------------------------------------------------ */
    const annualTax = computeAnnualTaxBandOnly(
      annualTaxable,
      taxCfg?.slabs || []
    );

    // NOW DIVIDE TAX BASED ON REMAINING MONTHS (NOT 12)
    const monthlyTax = Math.round(annualTax / monthsRemaining);

    /* ------------------------------------------------------------
       7) Allowances & Net Payable
    ------------------------------------------------------------ */
    const leaveDeductions = await readFirstNumAsync(salarySlip, ["leaveDeductions"]);
    const totalAllowances = finalGrossMonthly - basic;
    const totalDeductions = monthlyTax + leaveDeductions;
    const netPayable = Math.max(0, finalGrossMonthly - totalDeductions);

    return {
      grossMonthly: finalGrossMonthly,
      annualGross: finalGrossMonthly * monthsRemaining,
      medExemptMonthly,
      taxableMonthly,
      monthsRemaining, // <-- NEW FIELD (important)
      annualTaxable,
      annualTax,
      monthlyTax,
      leaveDeductions,
      totalAllowances,
      totalDeductions,
      netPayable,
    };
  } catch (error) {
    console.error("Error in calculateTaxForSalarySlip:", error);
    throw error;
  }
}

async function autoCalculateAndSaveTax(salarySlip) {
  try {
    let taxCfg = await TaxConfig.findOne({ fiscalYear: "2025-26" }).lean();
    if (!taxCfg)
      taxCfg = await TaxConfig.findOne().sort({ createdAt: -1 }).lean();
    if (!taxCfg) return null;

    const taxCalculation = await calculateTaxForSalarySlip(salarySlip, taxCfg);

    await writeEnc(salarySlip, "grossSalary", taxCalculation.grossMonthly);
    await writeEnc(salarySlip, "taxDeduction", taxCalculation.monthlyTax);
    await writeEnc(salarySlip, "annualTaxDeduction", taxCalculation.annualTax);
    await writeEnc(salarySlip, "leaveDeductions", taxCalculation.leaveDeductions);
    await writeEnc(
      salarySlip,
      "totalAllowances",
      taxCalculation.totalAllowances
    );
    await writeEnc(
      salarySlip,
      "totalDeductions",
      taxCalculation.totalDeductions
    );
    await writeEnc(salarySlip, "netPayable", taxCalculation.netPayable);

    await salarySlip.save();

    return taxCalculation;
  } catch (err) {
    console.error("❌ Error in autoCalculateAndSaveTax:", err);
    return null;
  }
}
exports.autoCalculateAndSaveTax = autoCalculateAndSaveTax;

/* ---------------------- Existing Functions (Updated) ---------------------- */

exports.getEmployeeAndSalarySlip = async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({ error: "Invalid employee ID format" });
    }

    const employee = await Employee.findById(req.params.id)
      .populate("shifts", "_id name start end timezone");
    if (!employee) {
      return res.status(404).json({ error: "Employee not found" });
    }

    const salarySlip = await SalarySlip.findOne({ employee: req.params.id });

    // fetch shifts (by owner)
    let shifts = [];
    if (employee.owner) {
      shifts = await Shift.find({ owner: employee.owner }).select(
        "_id name start end timezone"
      );
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
      if (
        employeeObj.compensation[f] === undefined ||
        employeeObj.compensation[f] === null
      ) {
        employeeObj.compensation[f] = 0;
      }
    }
    employeeObj.providentFund.override = !!employeeObj.providentFund.override;

    // salary slip -> decrypted view for FE (including tax fields)
    let decryptedSalarySlip = salarySlip ? { ...salarySlip.toObject() } : {};
    const ALL_FIELDS = [...COMP_FIELDS, ...TAX_FIELDS];

    if (salarySlip) {
      for (const field of ALL_FIELDS) {
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
        candidateName: employeeObj.name || "",
        candidateEmail: employeeObj.email || "",
        position: employeeObj.designation || "",
        department: employeeObj.department || "",
        startDate: employeeObj.joiningDate || "",
        reportingTime: employeeObj.rt || "",
        month: new Date().toLocaleString("en-US", { month: "long" }),
        year: new Date().getFullYear().toString(),
        isActive: true,
      };
      for (const f of ALL_FIELDS) decryptedSalarySlip[f] = 0;
    }

    res.status(200).json({
      employee: employeeObj,
      salarySlip: decryptedSalarySlip,
      encryptedSalarySlip: salarySlip ? salarySlip.toObject() : null,
      shifts,
    });

  } catch (err) {
    console.error("Error in getEmployeeAndSalarySlip:", err);
    res
      .status(500)
      .json({ error: "Internal server error", details: err.message });
  }
};

exports.updateEmployeeAndSalarySlip = async (req, res) => {
  try {
    const { employee: employeeData = {}, salarySlip: salarySlipData = {} } =
      req.body;

    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({ error: "Invalid employee ID format" });
    }

    // Fetch existing employee
    const existingEmployee = await Employee.findById(req.params.id);
    if (!existingEmployee) {
      return res.status(404).json({ error: "Employee not found" });
    }

    // Fetch existing salary slip
    const existingSalarySlip = await SalarySlip.findOne({
      employee: req.params.id,
    });

    /* ------------------ EMPLOYEE UPDATE ------------------ */

    const employeeSet = {};
    const shallowKeys = [
      "name",
      "owner",
      "cnic",
      "email",
      "companyEmail",
      "password",
      "fatherOrHusbandName",
      "photographUrl",
      "dateOfBirth",
      "gender",
      "nationality",
      "cnicIssueDate",
      "cnicExpiryDate",
      "maritalStatus",
      "religion",
      "latestQualification",
      "fieldOfQualification",
      "otherQualification",
      "otherFieldOfQualification",
      "phone",
      "permanentAddress",
      "presentAddress",
      "bankName",
      "bankAccountNumber",
      "nomineeName",
      "nomineeRelation",
      "nomineeCnic",
      "nomineeNo",
      "rt",
      "department",
      "designation",
      "joiningDate",
      "leavingDate",
      "isHR",
      "isAdmin",
      "userAccount",
      "role",
      "status",
      "resignationDate",
      "noticePeriodEndDate",
      "terminationDate",
      "resignationReason",
    ];

    for (const k of shallowKeys) {
      if (k in employeeData && employeeData[k] !== undefined) {
        if (k === "cnic") {
          if (
            typeof employeeData.cnic === "string" &&
            CNIC_REGEX.test(employeeData.cnic)
          ) {
            employeeSet.cnic = employeeData.cnic;
          }
        } else {
          employeeSet[k] = employeeData[k];
        }
      }
    }

    if ("shifts" in employeeData && employeeData.shifts !== undefined) {
      employeeSet.shifts = Array.isArray(employeeData.shifts)
        ? employeeData.shifts
        : [];
    }

    if ("leaveEntitlement" in employeeData && employeeData.leaveEntitlement) {
      const le = employeeData.leaveEntitlement || {};
      employeeSet["leaveEntitlement.total"] = Math.max(
        0,
        safeNumber(le.total, 0)
      );
      employeeSet["leaveEntitlement.usedPaid"] = Math.max(
        0,
        safeNumber(le.usedPaid, 0)
      );
      employeeSet["leaveEntitlement.usedUnpaid"] = Math.max(
        0,
        safeNumber(le.usedUnpaid, 0)
      );
      employeeSet["leaveEntitlement.manuallySet"] = !!le.manuallySet;
    }

    if ("compensation" in employeeData && employeeData.compensation) {
      for (const f of COMP_FIELDS) {
        if (f in employeeData.compensation) {
          employeeSet[`compensation.${f}`] = safeNumber(
            employeeData.compensation[f],
            0
          );
        }
      }
    }

    const updatedEmployee = await Employee.findByIdAndUpdate(
      req.params.id,
      { $set: employeeSet },
      { new: true, runValidators: false }
    );

    /* ------------------ SALARY SLIP UPDATE ------------------ */

    let updatedSalarySlip;
    let taxCalculationResult = null;

    if (salarySlipData && Object.keys(salarySlipData).length > 0) {
      // --- SALARY REVISION HISTORY ---
      // If any compensation fields are being updated, save the current record to history
      let hasActualSalaryChange = false;
      const salaryFieldsToCheck = [...COMP_FIELDS];

      if (existingSalarySlip) {
        for (const field of salaryFieldsToCheck) {
          if (field in salarySlipData) {
            const newVal = safeNumber(salarySlipData[field], 0);
            const oldVal = await readEncNumberAsync(existingSalarySlip[field]);
            // If the values are different (ignoring minor precision issues), it's a change
            if (Math.abs(newVal - oldVal) >= 0.01) {
              hasActualSalaryChange = true;
              break;
            }
          }
        }
      }

      if (hasActualSalaryChange && existingSalarySlip) {
        try {
          await SalaryRevisionHistory.create({
            owner: existingSalarySlip.owner,
            employee: existingSalarySlip.employee,
            designation: existingEmployee.designation, // captured before update
            basic: existingSalarySlip.basic,
            dearnessAllowance: existingSalarySlip.dearnessAllowance,
            houseRentAllowance: existingSalarySlip.houseRentAllowance,
            conveyanceAllowance: existingSalarySlip.conveyanceAllowance,
            medicalAllowance: existingSalarySlip.medicalAllowance,
            utilityAllowance: existingSalarySlip.utilityAllowance,
            overtimeCompensation: existingSalarySlip.overtimeCompensation,
            dislocationAllowance: existingSalarySlip.dislocationAllowance,
            leaveEncashment: existingSalarySlip.leaveEncashment,
            bonus: existingSalarySlip.bonus,
            arrears: existingSalarySlip.arrears,
            autoAllowance: existingSalarySlip.autoAllowance,
            incentive: existingSalarySlip.incentive,
            fuelAllowance: existingSalarySlip.fuelAllowance,
            othersAllowances: existingSalarySlip.othersAllowances,
            grossSalary: existingSalarySlip.grossSalary,
            taxDeduction: existingSalarySlip.taxDeduction,
            netPayable: existingSalarySlip.netPayable,
          });
        } catch (historyErr) {
          console.error("Failed to save salary history:", historyErr);
        }
      }

      const slipSet = {};

      const nonCompKeys = [
        "candidateName",
        "candidateEmail",
        "position",
        "department",
        "startDate",
        "reportingTime",
        "month",
        "year",
        "isActive",
      ];

      for (const k of nonCompKeys) {
        if (k in salarySlipData) slipSet[k] = salarySlipData[k];
      }

      // encrypt updated compensation fields
      const providedComp = [];
      for (const f of COMP_FIELDS) {
        if (f in salarySlipData) {
          const val = safeNumber(salarySlipData[f], 0);
          slipSet[f] = await encrypt(String(val));
          providedComp.push(f);
        }
      }

      // REQUIRED FIELDS FIX
      const ownerId =
        req.user?.owner ||
        req.user?._id ||
        employeeData?.owner ||
        existingEmployee?.owner;

      slipSet.owner = ownerId;
      slipSet.month =
        salarySlipData.month ||
        existingSalarySlip?.month ||
        (new Date().getMonth() + 1).toString();
      slipSet.year =
        salarySlipData.year ||
        existingSalarySlip?.year ||
        new Date().getFullYear().toString();

      if (existingSalarySlip) {
        updatedSalarySlip = await SalarySlip.findOneAndUpdate(
          { employee: req.params.id },
          { $set: { ...slipSet, employee: req.params.id } },
          { new: true }
        );
      } else {
        updatedSalarySlip = await SalarySlip.create({
          ...slipSet,
          employee: req.params.id,
        });
      }

      if (updatedSalarySlip) {
        taxCalculationResult = await autoCalculateAndSaveTax(updatedSalarySlip);
      }
    } else {
      updatedSalarySlip = existingSalarySlip;
    }

    /* ------------------ RESPONSE ------------------ */

    let decryptedSalarySlip = null;
    if (updatedSalarySlip) {
      const raw = updatedSalarySlip.toObject();
      decryptedSalarySlip = { ...raw };
      const ALL_FIELDS = [...COMP_FIELDS, ...TAX_FIELDS];

      for (const f of ALL_FIELDS) {
        try {
          const dv = await decrypt(raw[f], req.query.key);
          decryptedSalarySlip[f] = safeNumber(dv, 0);
        } catch {
          decryptedSalarySlip[f] = 0;
        }
      }
    }

    res.status(200).json({
      employee: updatedEmployee,
      salarySlip: decryptedSalarySlip,
      encryptedSalarySlip: updatedSalarySlip ? updatedSalarySlip.toObject() : null,
      taxCalculation: taxCalculationResult
        ? {
          monthlyTax: taxCalculationResult.monthlyTax,
          annualTax: taxCalculationResult.annualTax,
          netPayable: taxCalculationResult.netPayable,
          annualTaxable: taxCalculationResult.annualTaxable,
          grossMonthly: taxCalculationResult.grossMonthly,
        }
        : null,
      message:
        "Employee and salary slip updated successfully with auto tax calculation.",
    });

  } catch (err) {
    console.error("Error in updateEmployeeAndSalarySlip:", err);
    res
      .status(500)
      .json({ error: "Internal server error", details: err.message });
  }
};

/* ---------------------- Manual Tax Calculation Endpoint ---------------------- */
exports.calculateTaxForEmployee = async (req, res) => {
  try {
    const { id } = req.params;
    const { fiscalYear = "2025-26" } = req.body;

    if (!isValidObjectId(id)) {
      return res.status(400).json({ error: "Invalid employee ID format" });
    }

    const salarySlip = await SalarySlip.findOne({ employee: id });
    if (!salarySlip) {
      return res
        .status(404)
        .json({ error: "Salary slip not found for this employee" });
    }

    const taxCfg = await TaxConfig.findOne({ fiscalYear }).lean();
    if (!taxCfg) {
      return res
        .status(404)
        .json({ error: `Tax config for ${fiscalYear} not found` });
    }

    const taxCalculation = await calculateTaxForSalarySlip(salarySlip, taxCfg);

    // Update the salary slip with calculated tax
    await writeEnc(salarySlip, "taxDeduction", taxCalculation.monthlyTax);
    await writeEnc(salarySlip, "annualTaxDeduction", taxCalculation.annualTax);
    await writeEnc(
      salarySlip,
      "totalDeductions",
      taxCalculation.totalDeductions
    );
    await writeEnc(salarySlip, "netPayable", taxCalculation.netPayable);

    await salarySlip.save();

    res.status(200).json({
      success: true,
      message: "Tax calculated and saved successfully",
      taxCalculation: {
        grossMonthly: taxCalculation.grossMonthly,
        monthlyTax: taxCalculation.monthlyTax,
        annualTax: taxCalculation.annualTax,
        netPayable: taxCalculation.netPayable,
        annualTaxable: taxCalculation.annualTaxable,
        medExemptMonthly: taxCalculation.medExemptMonthly,
      },
    });
  } catch (err) {
    console.error("Error in calculateTaxForEmployee:", err);
    res
      .status(500)
      .json({ error: "Failed to calculate tax", details: err.message });
  }
};

/* ---------------------- Get Tax Configuration ---------------------- */
exports.getTaxConfiguration = async (req, res) => {
  try {
    const { fiscalYear = "2025-26" } = req.query;

    const taxCfg = await TaxConfig.findOne({ fiscalYear }).lean();
    if (!taxCfg) {
      return res
        .status(404)
        .json({ error: `Tax configuration for ${fiscalYear} not found` });
    }

    res.status(200).json({
      success: true,
      taxConfig: taxCfg,
    });
  } catch (err) {
    console.error("Error in getTaxConfiguration:", err);
    res
      .status(500)
      .json({ error: "Failed to get tax configuration", details: err.message });
  }
};

/* ---------------------- Existing Functions (Unchanged) ---------------------- */

exports.updateEmployeePhoto = async (req, res) => {
  try {
    const { id } = req.params;

    if (!req.file) {
      return res
        .status(400)
        .json({ success: false, message: "No photo uploaded" });
    }

    // New photo URL
    const photoUrl = `/uploads/photos/${req.file.filename}`;

    // Fetch employee to delete old photo if it exists
    const employee = await Employee.findById(id);
    if (!employee) {
      return res
        .status(404)
        .json({ success: false, message: "Employee not found" });
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
exports.calculatePreviewTax = async (req, res) => {
  try {
    const { salaryBreakup, grossMonthly } = req.body;

    const taxCfg = await TaxConfig.findOne({ fiscalYear: "2025-26" });
    if (!taxCfg) return res.status(404).json({ error: "Tax config missing" });

    const fakeSlip = {
      basic: salaryBreakup.basic || 0,
      medicalAllowance: salaryBreakup.medicalAllowance || 0,
      grossSalary: grossMonthly,
      ...salaryBreakup,
    };

    const calc = await calculateTaxForSalarySlip(fakeSlip, taxCfg);

    return res.json({
      success: true,
      taxCalculation: calc,
    });
  } catch (err) {
    console.error("Preview tax error:", err);
    res.status(500).json({ error: "Failed to calculate preview tax" });
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
    if (!emp.email)
      return res.status(400).json({ message: "Employee email is missing" });

    const ownerId = emp.owner || DEFAULT_OWNER_ID;
    await sendCompleteProfileLink({
      id: emp._id.toString(),
      to: emp.email,
      employeeName: emp.name || "Employee",
      ownerId,
    });

    return res.json({
      success: true,
      message: "Complete-profile email resent.",
    });
  } catch (err) {
    console.error("resendCompleteProfileLink error:", err);
    return res
      .status(500)
      .json({ message: err.message || "Failed to resend profile email" });
  }
};

// ---------------------- Get Salary Revision History ---------------------- */
exports.getSalaryHistory = async (req, res) => {
  try {
    const { id } = req.params;
    const history = await SalaryRevisionHistory.find({ employee: id }).sort({ revisionDate: -1 });
    res.json({
      status: "success",
      data: history
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

/**
 * Get all template/master salaries for the company (owner)
 * This is used for payroll estimates to see current salary configurations
 */
exports.getAllMasterSalaries = async (req, res) => {
  try {
    const ownerId = req.user.owner || req.user._id;

    // Fetch all salary templates for this company
    const salaryTemplates = await SalarySlip.find({ owner: ownerId }).populate("employee").lean();

    // Filter out any templates where the employee has been deleted (employee is null)
    const validTemplates = salaryTemplates.filter(sal => sal.employee != null);

    // Decrypt all fields for frontend consumption
    const decryptedSalaries = await Promise.all(
      validTemplates.map(async (sal) => {
        const decrypted = { ...sal };

        // Define all fields to decrypt
        const fieldsToDecrypt = [
          ...COMP_FIELDS,
          "leaveDeductions", "lateDeductions", "eobiDeduction",
          "sessiDeduction", "providentFundDeduction", "gratuityFundDeduction",
          "advanceSalaryDeductions", "medicalInsurance", "lifeInsurance",
          "penalties", "othersDeductions", "taxDeduction"
        ];

        for (const field of fieldsToDecrypt) {
          if (sal[field]) {
            try {
              const dv = await decrypt(sal[field]);
              decrypted[field] = safeNumber(dv, 0);
            } catch {
              decrypted[field] = 0;
            }
          } else {
            decrypted[field] = 0;
          }
        }

        // Handle nested loanDeductions
        if (sal.loanDeductions) {
          // Flatten for frontend matching PayrollEstimate keys
          try {
            if (sal.loanDeductions.vehicleLoan) {
              const v = await decrypt(sal.loanDeductions.vehicleLoan);
              decrypted.vehicleLoanDeduction = safeNumber(v, 0);
            } else {
              decrypted.vehicleLoanDeduction = 0;
            }

            if (sal.loanDeductions.otherLoans) {
              const v = await decrypt(sal.loanDeductions.otherLoans);
              decrypted.otherLoanDeductions = safeNumber(v, 0);
            } else {
              decrypted.otherLoanDeductions = 0;
            }
          } catch {
            decrypted.vehicleLoanDeduction = 0;
            decrypted.otherLoanDeductions = 0;
          }
        } else {
          decrypted.vehicleLoanDeduction = 0;
          decrypted.otherLoanDeductions = 0;
        }

        return decrypted;
      })
    );

    res.json({
      status: "success",
      data: decryptedSalaries
    });
  } catch (err) {
    console.error("Error in getAllMasterSalaries:", err);
    res.status(500).json({ error: err.message });
  }
};
