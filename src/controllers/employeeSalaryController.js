const Employee = require("../models/Employees");
const TrustedDevice = require("../models/TrustedDevice");
const SalarySlip = require("../models/Salaries");
const SalaryRevisionHistory = require("../models/SalaryRevisionHistory");
const Shift = require("../models/Shift");
const TaxConfig = require("../models/TaxConfig");
const CompanyProfile = require("../models/CompanyProfile");
const { encrypt, decrypt } = require("../utils/encryption");
const { sendCompleteProfileLink, sendSetPasswordEmail, sendMissingDocumentsRequest, REQUESTABLE_DOC_LABELS } = require("../services/profileEmailService");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");

function _getCompanyShortcut(name) {
  if (!name) return "EMP";
  const cleaned = name.replace(/[.,\/#!$%\^&*;:{}=\-_`~()]/g, "");
  const words = cleaned.trim().split(/\s+/);
  if (words.length >= 3) return (words[0][0] + words[1][0] + words[2][0]).toUpperCase();
  if (words.length === 2) return (words[0][0] + words[1][0] + (words[1][1] || "")).toUpperCase();
  return words[0].substring(0, 3).toUpperCase();
}

function _getEmployeeInitials(name) {
  if (!name) return "XX";
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  if (parts.length === 1) return parts[0].substring(0, 2).toUpperCase();
  return "XX";
}

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

const normalizeId = (value) => {
  if (Array.isArray(value)) return value[0];
  return value;
};

const idsEqual = (a, b) => {
  if (!a || !b) return false;
  return String(a) === String(b);
};

const getRequestOwnerId = (req) => normalizeId(req.user?.owner || req.user?._id);

const canAccessEmployee = (req, employee) => {
  const ownerId = getRequestOwnerId(req);
  const employeeOwner = normalizeId(employee?.owner);
  const employeeId = req.user?.employeeId;

  if (req.user?.isEmployee && !req.user?.isAdmin && !req.user?.isDelegated) {
    return employeeId && idsEqual(employee?._id, employeeId);
  }

  if (idsEqual(employeeOwner, ownerId)) return true;
  if (employeeId && idsEqual(employee?._id, employeeId)) return true;
  return false;
};

const getSalaryDecryptKey = (req) => req.query.key || req.body?.key || null;

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
      // ⭐ FIXED FORMULA: Subtract (from - 1) to get amount over the previous slab's limit
      const baseInclusive = Math.max(0, s.from - 1);
      const over = Math.max(0, A - baseInclusive);
      const tax = Math.round(s.fixed + over * s.rate);
      return tax;
    }
  }

  // If highest slab (open ended)
  const last = slabs[slabs.length - 1];
  if (last && A >= last.from) {
    const baseInclusive = Math.max(0, last.from - 1);
    const over = Math.max(0, A - baseInclusive);
    const tax = Math.round(last.fixed + over * last.rate);
    return tax;
  }

  return 0;
}

async function getTaxableMonthlyOnly(salarySlip, taxCfg) {
  // Gross = sum of all allowance fields
  const ALL_ALLOWANCE_KEYS = [
    "basic", "conveyanceAllowance", "incentive", "medicalAllowance",
    "dearnessAllowance", "houseRentAllowance", "utilityAllowance", "autoAllowance",
    "fuelAllowance", "dislocationAllowance", "bonus", "arrears", "othersAllowances"
  ];
  let gross = 0;
  for (const key of ALL_ALLOWANCE_KEYS) {
    gross += await readFirstNumAsync(salarySlip, [key]);
  }
  // Deduct leave/late/loan to get net salary
  const DED_KEYS = ["leaveDeductions", "lateDeductions", "otherLoanDeductions",
    "vehicleLoanDeduction", "advanceSalaryDeductions"];
  let ded = 0;
  for (const key of DED_KEYS) {
    ded += await readFirstNumAsync(salarySlip, [key]);
  }
  const netSalary = Math.max(0, gross - ded);
  // Medical Allowance = Net Salary / 110 * 10 (calculated, not from DB)
  const calculatedMedical = Math.round(netSalary / 110 * 10);
  // Taxable = Net Salary - Calculated Medical Allowance
  return Math.max(0, netSalary - calculatedMedical);
}

async function calculateTaxForSalarySlip(salarySlip, taxCfg) {
  try {
    // 1) Gross = sum of ALL allowances (from DB)
    const ALL_ALLOWANCE_KEYS = [
      "basic", "conveyanceAllowance", "incentive", "medicalAllowance",
      "dearnessAllowance", "houseRentAllowance", "utilityAllowance", "autoAllowance",
      "fuelAllowance", "dislocationAllowance", "bonus", "arrears", "othersAllowances"
    ];
    let grossSalary = 0;
    for (const key of ALL_ALLOWANCE_KEYS) {
      grossSalary += await readFirstNumAsync(salarySlip, [key]);
    }

    const basic = await readFirstNumAsync(salarySlip, ["basic"]);

    // 2) Net Salary for Tax = Gross minus leave/late deductions
    // Note: Loan repayments and advance salary are NOT tax-deductible.
    const DED_KEYS_FOR_NET = ["leaveDeductions", "lateDeductions"];
    let taxNetDeductions = 0;
    for (const key of DED_KEYS_FOR_NET) {
      taxNetDeductions += await readFirstNumAsync(salarySlip, [key]);
    }
    const netSalary = Math.max(0, grossSalary - taxNetDeductions);

    // finalGrossMonthly = gross (for display)
    const finalGrossMonthly = grossSalary;

    // 3) Calculate Medical Allowance: Net Salary / 110 * 10
    const calculatedMedical = Math.round(netSalary / 110 * 10);

    /* ------------------------------------------------------------
       4) TAXABLE MONTHLY INCOME = Net Salary - Calculated Medical Allowance
    ------------------------------------------------------------ */
    const taxableMonthly = Math.max(0, netSalary - calculatedMedical);
    const medExemptMonthly = calculatedMedical; // Calculated medical is the exemption

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
       5) Annual Taxable Income Using Remaining Months & Past Slips
    ------------------------------------------------------------ */
    // NEW: Sum actual gross from previous slips in the same fiscal year
    const employeeId = salarySlip.employee?._id || salarySlip.employee;
    const allSlipsInYear = await SalarySlip.find({
      employee: employeeId,
      owner: salarySlip.owner
    }).lean();

    const pastFiscalSlips = allSlipsInYear.filter(s => {
      const sMonthIndex = monthNames.indexOf(s.month);
      const sYearNum = parseInt(s.year);
      const sDate = new Date(sYearNum, sMonthIndex, 1);
      const currentSlipDate = new Date(slipYearNum, slipMonthIndex, 1);
      return sDate >= fiscalStart && sDate < currentSlipDate;
    });

    let sumPastTaxable = 0;
    for (const ps of pastFiscalSlips) {
      sumPastTaxable += await getTaxableMonthlyOnly(ps, taxCfg);
    }

    const monthsAlreadyCovered = pastFiscalSlips.length;
    const remainingProjectedMonths = Math.max(0, monthsRemaining - monthsAlreadyCovered);

    const annualTaxable = sumPastTaxable + (taxableMonthly * remainingProjectedMonths);

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
    if (!canAccessEmployee(req, employee)) {
      return res.status(403).json({ error: "Employee not found or unauthorized" });
    }

    // Auto-generate employeeId if missing
    // NOTE: ID generation is now handled during final onboarding step (password setup)

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

    // Trusted devices now live in their own collection — attach them so the
    // EmployeeEdit "Devices" tab keeps working unchanged.
    employeeObj.trustedDevices = await TrustedDevice.find({
      employee: employee._id,
    })
      .sort({ addedAt: -1 })
      .lean();

    // salary slip -> decrypted view for FE (including tax fields)
    let decryptedSalarySlip = salarySlip ? { ...salarySlip.toObject() } : {};
    const ALL_FIELDS = [...COMP_FIELDS, ...TAX_FIELDS];

    if (salarySlip) {
      for (const field of ALL_FIELDS) {
        if (decryptedSalarySlip[field]) {
          try {
            const dv = await decrypt(decryptedSalarySlip[field], getSalaryDecryptKey(req));
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
    if (!canAccessEmployee(req, existingEmployee)) {
      return res.status(403).json({ error: "Employee not found or unauthorized" });
    }

    // Fetch existing salary slip
    const existingSalarySlip = await SalarySlip.findOne({
      employee: req.params.id,
    });

    /* ------------------ EMPLOYEE UPDATE ------------------ */

    const employeeSet = {};
    const shallowKeys = [
      "name",
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
      "emergencyContactName",
      "emergencyContactRelation",
      "emergencyContactNumber",
      "emergencyNo",
      "rt",
      "department",
      "subDepartment",
      "designation",
      "joiningDate",
      "leavingDate",
      "isHR",
      "isAdmin",
      "userAccount",
      "role",
      "status",
      "employeeId",
      "resignationDate",
      "noticePeriodEndDate",
      "terminationDate",
      "resignationReason",
      "noticePeriod",
      "supervisionMode",
      "supervisor",
      "gratuityDaysPaid",
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
      if ("bonus" in le) {
        employeeSet["leaveEntitlement.bonus"] = Math.max(
          0,
          safeNumber(le.bonus, 0)
        );
      }
      if ("bonusHoursAccumulated" in le) {
        employeeSet["leaveEntitlement.bonusHoursAccumulated"] = Math.max(
          0,
          safeNumber(le.bonusHoursAccumulated, 0)
        );
      }
      if ("bonusYear" in le && le.bonusYear !== undefined) {
        employeeSet["leaveEntitlement.bonusYear"] = safeNumber(le.bonusYear, new Date().getFullYear());
      }
      employeeSet["leaveEntitlement.manuallySet"] = !!le.manuallySet;
    }

    if ("providentFund" in employeeData && employeeData.providentFund) {
      const pf = employeeData.providentFund || {};
      if ("pfRate" in pf) employeeSet["providentFund.pfRate"] = safeNumber(pf.pfRate, 0);
      if ("years" in pf) employeeSet["providentFund.years"] = safeNumber(pf.years, 0);
      if ("override" in pf) employeeSet["providentFund.override"] = !!pf.override;
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
      let hasRevisedInSalary = false;
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

      // Check if any position has revisedInSalary checked
      // Fetch employee with experiences from DB since experiences are saved separately
      const employeeWithExperiences = await Employee.findById(req.params.id).select('experiences');
      const experiencesFromDB = employeeWithExperiences?.experiences || [];

      let revisedPositionId = null;
      if (experiencesFromDB && Array.isArray(experiencesFromDB)) {
        for (const exp of experiencesFromDB) {
          if (exp.positions && Array.isArray(exp.positions)) {
            for (const pos of exp.positions) {
              if (pos.revisedInSalary) {
                hasRevisedInSalary = true;
                revisedPositionId = pos._id ? pos._id.toString() : null;
                break;
              }
            }
          }
          if (hasRevisedInSalary) break;
        }
      }

      if ((hasActualSalaryChange || hasRevisedInSalary) && existingSalarySlip) {
        try {
          // Helper function to parse dates in various formats (DD/MM/YYYY, ISO, etc.)
          const parseDate = (dateStr) => {
            if (!dateStr) return null;
            // Try ISO format first
            let d = new Date(dateStr);
            if (!isNaN(d.getTime())) return d;

            // Try DD/MM/YYYY format
            const parts = dateStr.split('/');
            if (parts.length === 3) {
              const day = parseInt(parts[0], 10);
              const month = parseInt(parts[1], 10) - 1; // JS months are 0-indexed
              const year = parseInt(parts[2], 10);
              d = new Date(year, month, day);
              if (!isNaN(d.getTime())) return d;
            }

            // Try MM/DD/YYYY format
            if (parts.length === 3) {
              const month = parseInt(parts[0], 10) - 1;
              const day = parseInt(parts[1], 10);
              const year = parseInt(parts[2], 10);
              d = new Date(year, month, day);
              if (!isNaN(d.getTime())) return d;
            }

            return null;
          };

          // Find the endDate from the previous position (non-current role with end date)
          let positionEndDate = null;
          if (experiencesFromDB && Array.isArray(experiencesFromDB)) {
            for (const exp of experiencesFromDB) {
              if (exp.positions && Array.isArray(exp.positions) && exp.positions.length > 0) {
                // Sort positions by startDate to get correct order (oldest first)
                const sortedPositions = [...exp.positions].sort((a, b) => {
                  const dateA = a.startDate ? new Date(a.startDate) : new Date(0);
                  const dateB = b.startDate ? new Date(b.startDate) : new Date(0);
                  return dateA - dateB;
                });

                // Find the position that has revisedInSalary checked
                // and use the PREVIOUS position's end date
                for (let i = 0; i < sortedPositions.length; i++) {
                  const pos = sortedPositions[i];
                  if (pos.revisedInSalary && i > 0) {
                    // Get the previous position's end date
                    const prevPos = sortedPositions[i - 1];
                    if (prevPos.endDate) {
                      positionEndDate = parseDate(prevPos.endDate);
                      break;
                    }
                  }
                }

                // Fallback: if no end date found yet, use the old logic
                if (!positionEndDate) {
                  for (const pos of sortedPositions) {
                    if (!pos.isCurrentRole && pos.endDate) {
                      positionEndDate = parseDate(pos.endDate);
                      break;
                    }
                  }
                }

                // Second fallback: any position with endDate
                if (!positionEndDate) {
                  for (const pos of sortedPositions) {
                    if (pos.endDate) {
                      positionEndDate = parseDate(pos.endDate);
                      break;
                    }
                  }
                }
              }
              if (positionEndDate) break;
            }
          }

          // Find if there's an existing revision to update for this position OR the same designation
          let existingRevision = null;
          if (revisedPositionId) {
            existingRevision = await SalaryRevisionHistory.findOne({
              employee: req.params.id,
              positionId: revisedPositionId
            });
          }

          if (!existingRevision) {
            // Fallback: Check if the latest revision for this employee is for the same designation
            const latest = await SalaryRevisionHistory.findOne({ employee: req.params.id })
              .sort({ createdAt: -1 });
            if (latest && latest.designation === existingEmployee.designation) {
              existingRevision = latest;
            }
          }

          const revisionData = {
            owner: existingSalarySlip.owner,
            employee: existingSalarySlip.employee,
            designation: existingEmployee.designation,
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
            endDate: positionEndDate || (existingRevision ? existingRevision.endDate : null),
            positionId: revisedPositionId || (existingRevision ? existingRevision.positionId : undefined)
          };

          if (existingRevision) {
            // Update existing revision IF salary fields actually changed (optional but cleaner)
            // Or just update anyway to keep the latest values before current transition
            await SalaryRevisionHistory.findByIdAndUpdate(existingRevision._id, { $set: revisionData });
          } else {
            // Create new revision (new designation or first time check)
            await SalaryRevisionHistory.create(revisionData);
          }
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
        normalizeId(existingSalarySlip?.owner) ||
        normalizeId(existingEmployee?.owner) ||
        getRequestOwnerId(req) ||
        normalizeId(employeeData?.owner);

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
          const dv = await decrypt(raw[f], getSalaryDecryptKey(req));
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

exports.requestMissingDocuments = async (req, res) => {
  try {
    const { id } = req.params;
    if (!/^[0-9a-fA-F]{24}$/.test(id)) {
      return res.status(400).json({ message: "Invalid employee ID format" });
    }

    // Only super-admin/admin users or employees granted isAdmin rights may
    // request documents (anyPayrollAuth sets isAdmin for exactly those).
    if (!req.user?.isAdmin) {
      return res
        .status(403)
        .json({ message: "Only admins can request missing documents" });
    }

    const requested = Array.isArray(req.body?.missingDocs)
      ? req.body.missingDocs.filter((k) => REQUESTABLE_DOC_LABELS[k])
      : [];
    if (!requested.length) {
      return res.status(400).json({ message: "No valid documents selected" });
    }

    const emp = await Employee.findById(id);
    if (!emp) return res.status(404).json({ message: "Employee not found" });

    const emailTarget = req.body?.emailTarget === "company" ? "company" : "personal";
    const targetEmail = emailTarget === "company" ? emp.companyEmail : emp.email;
    if (!targetEmail) {
      return res.status(400).json({
        message: `Employee ${emailTarget} email is missing`,
      });
    }

    const ownerId = Array.isArray(emp.owner) ? emp.owner[0] : emp.owner;
    await sendMissingDocumentsRequest({
      id: emp._id.toString(),
      to: targetEmail,
      employeeName: emp.name || "Employee",
      ownerId,
      missingDocs: requested,
    });

    return res.json({
      success: true,
      message: "Missing documents request sent.",
      emailTarget,
      to: targetEmail,
    });
  } catch (err) {
    console.error("requestMissingDocuments error:", err);
    return res
      .status(500)
      .json({ message: err.message || "Failed to send documents request" });
  }
};

exports.resendSetPasswordLink = async (req, res) => {
  try {
    const { id } = req.params;
    if (!/^[0-9a-fA-F]{24}$/.test(id))
      return res.status(400).json({ message: "Invalid employee ID format" });
    const emp = await Employee.findById(id);
    if (!emp) return res.status(404).json({ message: "Employee not found" });
    if (!emp.email)
      return res.status(400).json({ message: "Employee email is missing" });

    const token = crypto.randomBytes(32).toString("hex");
    emp.setPasswordToken = token;
    emp.setPasswordTokenExpires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await emp.save();

    const ownerId = Array.isArray(emp.owner) ? emp.owner[0] : emp.owner;
    await sendSetPasswordEmail({
      to: emp.email,
      employeeName: emp.name || "Employee",
      token,
      employeeId: emp._id.toString(),
      ownerId,
    });

    return res.json({ success: true, message: "Password setup link resent." });
  } catch (err) {
    console.error("resendSetPasswordLink error:", err);
    return res
      .status(500)
      .json({ message: err.message || "Failed to resend password setup link" });
  }
};

// ---------------------- Get Salary Revision History ---------------------- */
exports.getSalaryHistory = async (req, res) => {
  try {
    const { id } = req.params;
    const employee = await Employee.findById(id).select("_id owner");
    if (!employee) return res.status(404).json({ error: "Employee not found" });
    if (!canAccessEmployee(req, employee)) {
      return res.status(403).json({ error: "Employee not found or unauthorized" });
    }
    const history = await SalaryRevisionHistory.find({ employee: id }).sort({ revisionDate: -1 });
    res.json({
      status: "success",
      data: history
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.getAllMasterSalaries = async (req, res) => {
  try {
    const ownerId = req.user.owner || req.user._id;

    // 1. Fetch all non-trashed employees for this company
    const allEmployees = await Employee.find({
      owner: ownerId,
      isTrashed: { $ne: true },
    }).lean();

    // Auto-generate employeeId for any employees that are missing it
    // NOTE: ID generation is now handled during final onboarding step (password setup)

    const decryptedSalaries = await Promise.all(
      allEmployees.map(async (emp) => {
        // Find the most recent slip for this employee to use as a master template
        const latestSlip = await SalarySlip.findOne({
          employee: emp._id,
          owner: ownerId
        })
          .sort({ createdAt: -1 })
          .lean();

        // Use the latest slip if found, otherwise start with a clean template
        const sal = latestSlip || {
          employee: emp,
          owner: ownerId,
          month: "N/A",
          year: "N/A",
          isActive: true
        };

        const decrypted = { ...sal, employee: emp };

        // Define all fields to decrypt
        const fieldsToDecrypt = [
          ...COMP_FIELDS,
          "leaveDeductions",
          "lateDeductions",
          "eobiDeduction",
          "sessiDeduction",
          "providentFundDeduction",
          "gratuityFundDeduction",
          "advanceSalaryDeductions",
          "medicalInsurance",
          "lifeInsurance",
          "penalties",
          "othersDeductions",
          "taxDeduction",
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

        // ✅ Add approved bonus cash from bonus requests to the bonus field
        // This ensures approved bonuses appear in payroll estimation
        if (emp.bonusCash && emp.bonusCash > 0) {
          decrypted.bonus = safeNumber(decrypted.bonus, 0) + safeNumber(emp.bonusCash, 0);
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

/**
 * POST /api/employee-salary/calc-preview
 * Body: {
 *   employeeId,
 *   month,
 *   year,
 *   allowances: { ... },
 *   deductions: { ... }
 * }
 */
exports.calculatePayrollPreviewTax = async (req, res) => {
  try {
    const { employeeId, month, year, allowances = {}, deductions = {} } = req.body;

    if (!employeeId || !month || !year) {
      return res.status(400).json({ error: "Missing required fields: employeeId, month, year" });
    }

    const employee = await Employee.findById(employeeId);
    if (!employee) {
      return res.status(404).json({ error: "Employee not found" });
    }

    const taxCfg = await TaxConfig.findOne({ fiscalYear: "2025-26" }).lean();
    if (!taxCfg) {
      return res.status(404).json({ error: "Tax configuration not found for 2025-26" });
    }

    // Combine all allowances to get total gross (as defined by user: sum of all components)
    // We assume the incoming allowances object contains all parts
    let grossSalary = 0;
    for (const key in allowances) {
      if (key !== "loanBenefits") {
        grossSalary += toNum(allowances[key]);
      }
    }

    // Net Salary for Tax = Gross - (Leave + Late Deductions)
    // Note: Loan repayments and advance salary are NOT tax-deductible.
    const DED_KEYS_FOR_NET = ["leaveDeductions", "lateDeductions"];

    let taxNetDeductions = 0;
    for (const key of DED_KEYS_FOR_NET) {
      taxNetDeductions += toNum(deductions[key]);
    }

    const netSalary = Math.max(0, grossSalary - taxNetDeductions);

    // Dynamic Medical Allowance = Net Salary / 110 * 10
    const calculatedMedical = Math.round(netSalary / 110 * 10);

    // Taxable Monthly = Net Salary - Calculated Medical
    const taxableMonthly = Math.max(0, netSalary - calculatedMedical);

    // Create a dummy slip object to pass to the existing tax logic
    const dummySlip = {
      employee: employee,
      owner: req.user._id,
      month,
      year,
      // We need to provide the taxableMonthly to the annualization logic
      // But calculateTaxForSalarySlip normally reads from the slip fields.
      // So let's mock the read functions or just perform the logic here since we have it.
    };

    // Since we already have the monthly taxable, we just need to annualize it.
    // Let's reuse the logic from calculateTaxForSalarySlip but with our values.

    const fiscalStartMonth = 7;
    const fiscalEndMonth = 6;
    const joiningDate = employee.joiningDate ? new Date(employee.joiningDate) : null;
    const slipYearNum = parseInt(year);
    const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    const slipMonthIndex = monthNames.indexOf(month);

    const fiscalStart = new Date(slipYearNum, fiscalStartMonth - 1, 1);
    if (slipMonthIndex !== -1 && slipMonthIndex + 1 <= fiscalEndMonth) {
      fiscalStart.setFullYear(fiscalStart.getFullYear() - 1);
    }
    const effectiveStart = joiningDate && joiningDate > fiscalStart ? joiningDate : fiscalStart;
    const fiscalEnd = new Date(fiscalStart.getFullYear() + 1, fiscalEndMonth, 1);

    let monthsRemaining = (fiscalEnd.getFullYear() - effectiveStart.getFullYear()) * 12 + (fiscalEnd.getMonth() - effectiveStart.getMonth());
    if (monthsRemaining < 1) monthsRemaining = 1;

    // Sum past taxable from existing slips
    const allSlipsInYear = await SalarySlip.find({
      employee: employeeId,
      owner: req.user._id
    }).lean();

    const pastFiscalSlips = allSlipsInYear.filter(s => {
      const sMonthIndex = monthNames.indexOf(s.month);
      const sYearNum = parseInt(s.year);
      const sDate = new Date(sYearNum, sMonthIndex, 1);
      const currentSlipDate = new Date(slipYearNum, slipMonthIndex, 1);
      return sDate >= fiscalStart && sDate < currentSlipDate;
    });

    let sumPastTaxable = 0;
    // For simplicity in the preview, we'll assume past slips are correct.
    // In a real scenario, we might need to decrypt them.
    for (const ps of pastFiscalSlips) {
      // Use the helper to get taxable from past slips
      sumPastTaxable += await getTaxableMonthlyOnly(ps, taxCfg);
    }

    const monthsAlreadyCovered = pastFiscalSlips.length;
    const remainingProjectedMonths = Math.max(0, monthsRemaining - monthsAlreadyCovered);

    const annualTaxable = sumPastTaxable + (taxableMonthly * remainingProjectedMonths);

    const annualTax = computeAnnualTaxBandOnly(
      annualTaxable,
      taxCfg?.slabs || []
    );
    const monthlyTax = Math.round(annualTax / monthsRemaining);

    res.json({
      status: "success",
      calculation: {
        grossSalary,
        netSalaryForTax: netSalary,
        medicalAllowance: calculatedMedical,
        taxableMonthly,
        annualTaxable,
        annualTax,
        monthlyTax,
        monthsRemaining,
        sumPastTaxable,
        pastMonthsCount: monthsAlreadyCovered
      }
    });

  } catch (err) {
    console.error("Error in calculatePreviewTax:", err);
    res.status(500).json({ error: err.message });
  }
};
