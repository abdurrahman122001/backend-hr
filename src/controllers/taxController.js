const SalarySlip = require("../models/SalarySlip");
const TaxConfig = require("../models/TaxConfig");
const LoanDetail = require("../models/LoanDetail"); // Updated import
const { encrypt, decrypt } = require("../utils/encryption");

const DEBUG_TAX = true;

/* ---------------------------- helpers ---------------------------- */

const toNum = (v) => {
  if (v === null || v === undefined) return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const n = Number(String(v).replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : 0;
};

const toStr = (num) => Math.round(Number(num) || 0).toString();

/** Decrypt (supports sync or async). Fallback to numeric parse. */
const readEncNumberAsync = async (maybeEnc, fieldName = "") => {
  if (maybeEnc === null || maybeEnc === undefined) return 0;
  if (typeof maybeEnc === "number") return toNum(maybeEnc);
  const raw = String(maybeEnc).trim();
  if (!raw) return 0;
  try {
    const decMaybe = decrypt(raw);
    const dec = typeof decMaybe?.then === "function" ? await decMaybe : decMaybe;
    const num = toNum(dec);
    if (DEBUG_TAX && (num === 0 || Number.isNaN(num))) {
      console.warn(`[tax] decrypt(${fieldName}) → "${dec}" → 0`);
    }
    return num;
  } catch {
    const num = toNum(raw);
    if (DEBUG_TAX && num === 0) {
      console.warn(`[tax] read(${fieldName}) not decryptable & not numeric → 0`);
    }
    return num;
  }
};

/** ALWAYS await; never assign a Promise into a String field. */
const writeEnc = async (doc, key, value) => {
  const encMaybe = encrypt(toStr(value));
  doc[key] = typeof encMaybe?.then === "function" ? await encMaybe : encMaybe;
};

/** Read first existing key (supports paths like "loanDeductions.vehicleLoan"). */
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

/* ----------------------------- config ----------------------------- */

// Allowances → gross (INCLUDES LOAN BENEFITS)
const ALLOWANCE_KEYS = [
  "basic",
  "dearnessAllowance", 
  "houseRentAllowance",
  "conveyanceAllowance",
  "medicalAllowance",
  "utilityAllowance",
  "overtimeCompensation",
  "overtimeComp",
  "dislocationAllowance",
  "leaveEncashment",
  "bonus",
  "arrears",
  "autoAllowance",
  "incentive",
  "fuelAllowance",
  "othersAllowances",
  "loanBenefits" // ADDED: Loan benefits are part of gross salary
];

// Loans → excluded from taxable base (but reduce final net)
const LOAN_DEDUCTION_KEYS = [
  "loanDeductions.vehicleLoan",
  "loanDeductions.otherLoans", 
  "vehicleLoanDeduction",
  "otherLoanDeductions"
];

// Base deductions → included in taxable base
const BASE_DEDUCTION_KEYS = [
  "leaveDeductions",
  "lateDeductions", 
  "eobiDeduction",
  "sessiDeduction",
  "providentFundDeduction",
  "gratuityFundDeduction",
  "advanceSalaryDeductions",
  "advanceSalaryDeduction",
  "medicalInsurance",
  "lifeInsurance",
  "penalties",
  "othersDeductions"
];

/* -------------------------- tax math (band) -------------------------- */
function computeAnnualTaxBandOnly(annualTaxable, rawSlabs = []) {
  const A = Math.max(0, toNum(annualTaxable));

  const slabs = (rawSlabs || [])
    .map((s) => ({
      from: toNum(s.from),
      to: s.to === undefined || s.to === null ? Infinity : toNum(s.to),
      fixed: toNum(s.fixed),
      rate: toNum(s.rateOver) / 100,
    }))
    .filter((s) => Number.isFinite(s.from) && s.to >= s.from)
    .sort((a, b) => a.from - b.from);

  if (!slabs.length) return 0;

  for (const s of slabs) {
    if (A >= s.from && A <= s.to) {
      const baseInclusive = Math.max(0, s.from - 1);
      const over = Math.max(0, A - baseInclusive);
      const tax = Math.round(s.fixed + over * s.rate);
      if (DEBUG_TAX) {
        console.log(
          `[tax] slab match: A=${A.toLocaleString()} | from=${s.from.toLocaleString()} to=${s.to === Infinity ? "∞" : s.to.toLocaleString()} | fixed=${s.fixed.toLocaleString()} | rate=${(s.rate * 100).toFixed(2)}% | over=${over.toLocaleString()} | annualTax=${tax.toLocaleString()}`
        );
      }
      return tax;
    }
  }

  const last = slabs[slabs.length - 1];
  if (last && last.to === Infinity) {
    const baseInclusive = Math.max(0, last.from - 1);
    const over = Math.max(0, A - baseInclusive);
    const tax = Math.round(last.fixed + over * last.rate);
    if (DEBUG_TAX) {
      console.log(
        `[tax] top band: A=${A.toLocaleString()} | from=${last.from.toLocaleString()} | fixed=${last.fixed.toLocaleString()} | rate=${(last.rate * 100).toFixed(2)}% | over=${over.toLocaleString()} | annualTax=${tax.toLocaleString()}`
      );
    }
    return tax;
  }

  return 0;
}

/* ---------------------- loan benefits calculation ---------------------- */
async function calculateLoanBenefitsAsync(employeeId, monthYear) {
  try {
    // Parse month and year from monthYear string (e.g., "March 2024")
    const [monthName, yearStr] = monthYear.split(' ');
    const year = parseInt(yearStr);
    
    if (!monthName || !year || isNaN(year)) {
      console.warn(`[tax] Invalid monthYear format: ${monthYear}`);
      return { totalLoanBenefits: 0, loanDetails: [] };
    }

    if (DEBUG_TAX) {
      console.log(`[tax] Calculating loan benefits for employee ${employeeId}, ${monthYear}`);
    }

    // Get all loan details for this employee
    const loanDetails = await LoanDetail.find({
      employee: employeeId
    }).lean();

    if (!loanDetails || loanDetails.length === 0) {
      if (DEBUG_TAX) {
        console.log(`[tax] No loan details found for employee ${employeeId}`);
      }
      return { totalLoanBenefits: 0, loanDetails: [] };
    }

    if (DEBUG_TAX) {
      console.log(`[tax] Found ${loanDetails.length} loan details for employee ${employeeId}`);
    }

    let totalLoanBenefits = 0;
    const loanBenefitDetails = [];

    for (const loan of loanDetails) {
      // Calculate monthly markup/benefit for this loan from payment schedule
      const monthlyBenefit = await calculateMonthlyLoanBenefitFromSchedule(loan, monthName, year);
      
      if (monthlyBenefit > 0) {
        totalLoanBenefits += monthlyBenefit;
        loanBenefitDetails.push({
          loanId: loan._id,
          loanType: loan.type || 'Personal Loan',
          loanAmount: await readEncNumberAsync(loan.loanAmount, "loanAmount"),
          markupValue: loan.markupValue,
          markupType: loan.markupType,
          markupAmount: monthlyBenefit,
          month: monthName,
          year: year
        });
        
        if (DEBUG_TAX) {
          console.log(`[tax] Added loan benefit: ${monthlyBenefit} for loan ${loan._id}`);
        }
      }
    }

    if (DEBUG_TAX) {
      console.log(`[tax] Total loan benefits for employee ${employeeId}: ${totalLoanBenefits}`);
      if (loanBenefitDetails.length > 0) {
        console.log(`[tax] Loan benefit details:`, JSON.stringify(loanBenefitDetails, null, 2));
      }
    }

    return {
      totalLoanBenefits,
      loanDetails: loanBenefitDetails
    };

  } catch (error) {
    console.error(`[tax] Failed to calculate loan benefits for employee ${employeeId}:`, error);
    return {
      totalLoanBenefits: 0,
      loanDetails: []
    };
  }
}

/* ---------------------- calculate monthly loan benefit from schedule ---------------------- */
async function calculateMonthlyLoanBenefitFromSchedule(loan, targetMonth, targetYear) {
  try {
    if (!loan.paymentSchedule || !Array.isArray(loan.paymentSchedule)) {
      return 0;
    }

    // Find the installment for the target month and year
    const installment = loan.paymentSchedule.find(installment => 
      installment.month.toLowerCase() === targetMonth.toLowerCase() && 
      parseInt(installment.year) === targetYear
    );

    if (!installment) {
      if (DEBUG_TAX) {
        console.log(`[tax] No installment found for ${targetMonth} ${targetYear} in loan ${loan._id}`);
      }
      return 0;
    }

    // Get markup amount from the installment
    const markupAmount = await readEncNumberAsync(installment.markupAmount, "markupAmount");
    
    if (DEBUG_TAX) {
      console.log(`[tax] Found installment for ${targetMonth} ${targetYear}:`);
      console.log(`[tax]   Markup Amount: ${markupAmount}`);
      console.log(`[tax]   Principal: ${await readEncNumberAsync(installment.principal, "principal")}`);
      console.log(`[tax]   Total Payment: ${await readEncNumberAsync(installment.totalPayment, "totalPayment")}`);
    }

    return markupAmount;

  } catch (error) {
    console.warn(`[tax] Error calculating monthly loan benefit from schedule:`, error);
    return 0;
  }
}

/* ---------------------- alternative: calculate from markup value ---------------------- */
async function calculateLoanBenefitsFromMarkupValue(employeeId, monthYear) {
  try {
    const [monthName, yearStr] = monthYear.split(' ');
    const year = parseInt(yearStr);
    
    const loanDetails = await LoanDetail.find({
      employee: employeeId
    }).lean();

    let totalBenefits = 0;
    const benefitDetails = [];

    for (const loan of loanDetails) {
      // Check if loan is active for this month based on schedule
      const isActive = await isLoanActiveInMonth(loan, monthName, year);
      
      if (isActive) {
        // Calculate monthly benefit based on markup value and type
        const monthlyBenefit = await calculateMonthlyBenefitFromMarkup(loan);
        
        if (monthlyBenefit > 0) {
          totalBenefits += monthlyBenefit;
          benefitDetails.push({
            loanId: loan._id,
            loanType: loan.type,
            loanAmount: await readEncNumberAsync(loan.loanAmount, "loanAmount"),
            markupType: loan.markupType,
            markupValue: loan.markupValue,
            markupAmount: monthlyBenefit,
            calculationMethod: "markup_value"
          });
        }
      }
    }

    if (DEBUG_TAX) {
      console.log(`[tax] Calculated ${totalBenefits} in benefits from markup values`);
    }

    return {
      totalLoanBenefits: totalBenefits,
      loanDetails: benefitDetails
    };

  } catch (error) {
    console.warn(`[tax] Error calculating benefits from markup values:`, error);
    return { totalLoanBenefits: 0, loanDetails: [] };
  }
}

/* ---------------------- check if loan is active in month ---------------------- */
async function isLoanActiveInMonth(loan, targetMonth, targetYear) {
  try {
    if (!loan.paymentSchedule || !Array.isArray(loan.paymentSchedule)) {
      return false;
    }

    // Check if there's any installment for this month/year
    const hasInstallment = loan.paymentSchedule.some(installment => 
      installment.month.toLowerCase() === targetMonth.toLowerCase() && 
      parseInt(installment.year) === targetYear
    );

    return hasInstallment;

  } catch (error) {
    console.warn(`[tax] Error checking loan active status:`, error);
    return false;
  }
}

/* ---------------------- calculate monthly benefit from markup value ---------------------- */
async function calculateMonthlyBenefitFromMarkup(loan) {
  try {
    const loanAmount = await readEncNumberAsync(loan.loanAmount, "loanAmount");
    const markupValue = parseFloat(loan.markupValue) || 0;
    
    if (loanAmount <= 0 || markupValue <= 0) {
      return 0;
    }

    let monthlyBenefit = 0;

    switch (loan.markupType) {
      case "fixed":
        // Fixed markup: (loanAmount * markupValue%) / 12
        monthlyBenefit = (loanAmount * (markupValue / 100)) / 12;
        break;
      
      case "reducing":
        // Reducing balance - complex calculation, use average
        monthlyBenefit = (loanAmount * (markupValue / 100)) / 12;
        break;
      
      case "interestOnly":
        // Interest only: loanAmount * markupValue% / 12
        monthlyBenefit = (loanAmount * (markupValue / 100)) / 12;
        break;
      
      case "custom":
        // Custom - try to get from monthly installment
        const monthlyInstallment = await readEncNumberAsync(loan.monthlyInstallment, "monthlyInstallment");
        const principalPortion = loanAmount / (loan.paymentSchedule?.length || 12);
        monthlyBenefit = monthlyInstallment - principalPortion;
        break;
      
      default:
        monthlyBenefit = (loanAmount * (markupValue / 100)) / 12;
    }

    return Math.max(0, Math.round(monthlyBenefit));

  } catch (error) {
    console.warn(`[tax] Error calculating benefit from markup:`, error);
    return 0;
  }
}

/* ---------------------- slip calculation (async) ---------------------- */
async function calculateSlipWithTaxAsync(slip, taxCfg) {
  // 1) Calculate loan benefits first
  let loanBenefits = 0;
  let loanDetails = [];
  
  if (slip.employee?._id) {
    const monthYear = `${slip.month} ${slip.year}`;
    
    if (DEBUG_TAX) {
      console.log("---------------------------------------------------");
      console.log(`[tax] Starting tax calculation for slip: ${slip._id}`);
      console.log(`[tax] Employee: ${slip.employee._id}, Month: ${monthYear}`);
    }
    
    // Try calculating from payment schedule first (most accurate)
    const scheduleBenefits = await calculateLoanBenefitsAsync(slip.employee._id, monthYear);
    loanBenefits = scheduleBenefits.totalLoanBenefits;
    loanDetails = scheduleBenefits.loanDetails;

    // If no benefits found from schedule, try calculating from markup values
    if (loanBenefits === 0) {
      if (DEBUG_TAX) {
        console.log(`[tax] No benefits from payment schedule, trying markup values...`);
      }
      const markupBenefits = await calculateLoanBenefitsFromMarkupValue(slip.employee._id, monthYear);
      loanBenefits = markupBenefits.totalLoanBenefits;
      loanDetails = markupBenefits.loanDetails;
    }

    if (DEBUG_TAX) {
      console.log(`[tax] Final loan benefits: ${loanBenefits.toLocaleString()}`);
    }
  }

  // 2) Gross monthly (INCLUDING LOAN BENEFITS)
  let grossMonthly = 0;
  for (const key of ALLOWANCE_KEYS) {
    if (key === "loanBenefits") {
      // ✅ ADD LOAN BENEFITS TO GROSS SALARY
      grossMonthly += loanBenefits;
      if (DEBUG_TAX) {
        console.log(`[tax] Added loan benefits to gross: ${loanBenefits}`);
      }
    } else {
      const value = await readFirstNumAsync(slip, [key]);
      grossMonthly += value;
      if (DEBUG_TAX && value > 0) {
        console.log(`[tax] Added ${key}: ${value}`);
      }
    }
  }

  const basic = await readFirstNumAsync(slip, ["basic"]);
  const medMonthly = await readFirstNumAsync(slip, ["medicalAllowance"]);

  // 3) Split deductions
  let baseDeductionsMonthly = 0;
  for (const key of BASE_DEDUCTION_KEYS) {
    const value = await readFirstNumAsync(slip, [key]);
    baseDeductionsMonthly += value;
    if (DEBUG_TAX && value > 0) {
      console.log(`[tax] Base deduction ${key}: ${value}`);
    }
  }

  let loanDeductionsMonthly = 0;
  for (const key of LOAN_DEDUCTION_KEYS) {
    const value = await readFirstNumAsync(slip, [key]);
    loanDeductionsMonthly += value;
    if (DEBUG_TAX && value > 0) {
      console.log(`[tax] Loan deduction ${key}: ${value}`);
    }
  }

  // 4) Net BEFORE income tax (EXCLUDES loan deductions)
  const netBeforeTax = Math.max(0, grossMonthly - baseDeductionsMonthly);

  // 5) Medical exemption
  const medExemptMonthly = taxCfg?.enableMedicalExemption
    ? Math.min(netBeforeTax, Math.round(netBeforeTax / 11))
    : 0;

  // 6) Taxable monthly (INCLUDES LOAN BENEFITS in the gross)
  const taxableMonthly = Math.max(0, netBeforeTax - medExemptMonthly);

  // 7) Annualize + compute band-only tax
  const annualTaxable = taxableMonthly * 12;
  const annualTax = computeAnnualTaxBandOnly(annualTaxable, taxCfg?.slabs || []);
  const monthlyTax = Math.round(annualTax / 12);

  // 8) Final totals (loan deductions still reduce net payable)
  const totalDeductions = baseDeductionsMonthly + loanDeductionsMonthly + monthlyTax;
  const netPayable = Math.max(0, grossMonthly - totalDeductions);

  /* ----------------- DEBUG LOGS ----------------- */
  if (DEBUG_TAX) {
    console.log("---------------------------------------------------");
    console.log(`[tax DEBUG] Slip ID: ${slip._id}`);
    console.log(`[tax DEBUG] Basic Salary       = ${basic}`);
    console.log(`[tax DEBUG] Medical Allowance  = ${medMonthly}`);
    console.log(`[tax DEBUG] Loan Benefits      = ${loanBenefits}`);
    console.log(`[tax DEBUG] Gross Monthly      = ${grossMonthly}`);
    console.log(`[tax DEBUG] Base Deductions    = ${baseDeductionsMonthly}`);
    console.log(`[tax DEBUG] Loan Deductions    = ${loanDeductionsMonthly}`);
    console.log(`[tax DEBUG] Net Before Tax     = ${netBeforeTax}`);
    console.log(`[tax DEBUG] Medical Exemptions = ${medExemptMonthly}`);
    console.log(`[tax DEBUG] Taxable Monthly    = ${taxableMonthly}`);
    console.log(`[tax DEBUG] Annual Taxable     = ${annualTaxable}`);
    console.log(`[tax DEBUG] Annual Tax         = ${annualTax}`);
    console.log(`[tax DEBUG] Monthly Tax        = ${monthlyTax}`);
    console.log(`[tax DEBUG] TOTAL Deductions   = ${totalDeductions}`);
    console.log(`[tax DEBUG] Net Payable        = ${netPayable}`);
    
    // Side-by-side comparison: WITHOUT loan benefits
    const grossWithoutLoan = grossMonthly - loanBenefits;
    const netBeforeTaxNoLoan = Math.max(0, grossWithoutLoan - baseDeductionsMonthly);
    const medExemptNoLoan = taxCfg?.enableMedicalExemption
      ? Math.min(netBeforeTaxNoLoan, Math.round(netBeforeTaxNoLoan / 11))
      : 0;
    const taxableWithoutLoan = Math.max(0, netBeforeTaxNoLoan - medExemptNoLoan);
    const annualTaxableNoLoan = taxableWithoutLoan * 12;
    const annualTaxNoLoan = computeAnnualTaxBandOnly(annualTaxableNoLoan, taxCfg?.slabs || []);
    const monthlyTaxNoLoan = Math.round(annualTaxNoLoan / 12);

    console.log(">>> Comparison WITH vs WITHOUT Loan Benefits <<<");
    console.log(`Gross Monthly   : With Loan=${grossMonthly.toLocaleString()} | Without Loan=${grossWithoutLoan.toLocaleString()}`);
    console.log(`Taxable Annual  : With Loan=${annualTaxable.toLocaleString()} | Without Loan=${annualTaxableNoLoan.toLocaleString()}`);
    console.log(`Monthly Tax     : With Loan=${monthlyTax.toLocaleString()} | Without Loan=${monthlyTaxNoLoan.toLocaleString()}`);
    console.log(`Tax Difference  : ${monthlyTax - monthlyTaxNoLoan}`);
    console.log("---------------------------------------------------\n");
  }
  /* ----------------- END DEBUG ----------------- */

  return {
    grossMonthly,
    annualGross: grossMonthly * 12,
    medExemptMonthly,
    annualTaxable,
    annualTax,
    monthlyTax,
    totalAllowances: grossMonthly - basic,
    totalDeductions,
    netPayable,
    loanBenefits,
    loanDetails,
    _debug: {
      baseDeductionsMonthly,
      loanDeductionsMonthly,
      netBeforeTax,
      taxableMonthly,
      loanBenefits,
    },
  };
}

/* ---------------------------- controllers ---------------------------- */

/** Legacy: enable for ALL slips of the owner */
exports.enableTaxForOwner = async (req, res) => {
  try {
    const ownerId = req.user._id;
    const { fiscalYear = "2025-26" } = req.body || {};

    const taxCfg = await TaxConfig.findOne({ fiscalYear }).lean();
    if (!taxCfg) {
      return res.status(404).json({ error: `TaxConfig not found for ${fiscalYear}` });
    }

    const slips = await SalarySlip.find({ owner: ownerId });
    if (!slips.length) return res.json({ updated: 0, slips: [] });

    const results = [];

    for (const slip of slips) {
      const calc = await calculateSlipWithTaxAsync(slip, taxCfg);

      // Persist (encrypted) - INCLUDING LOAN BENEFITS
      await writeEnc(slip, "grossSalary", calc.grossMonthly);
      await writeEnc(slip, "taxDeduction", calc.monthlyTax);
      await writeEnc(slip, "totalAllowances", calc.totalAllowances);
      await writeEnc(slip, "totalDeductions", calc.totalDeductions);
      await writeEnc(slip, "netPayable", calc.netPayable);
      await writeEnc(slip, "loanBenefits", calc.loanBenefits); // ADDED: Store loan benefits

      await slip.save();

      results.push({
        slipId: slip._id.toString(),
        employee: String(slip.employee),
        month: slip.month,
        year: slip.year,
        taxDeduction: calc.monthlyTax,
        netPayable: calc.netPayable,
        loanBenefits: calc.loanBenefits // ADDED
      });
    }

    return res.json({ updated: results.length, slips: results });
  } catch (err) {
    console.error("enableTaxForOwner error:", err);
    return res.status(500).json({ error: "Failed to enable tax" });
  }
};

/** NEW: flexible update */
exports.updateTaxForOwner = async (req, res) => {
  try {
    const ownerId = req.user._id;

    const {
      fiscalYear = "2025-26",
      mode = "enable",
      scope = "all",
      employeeIds = [],
      slipIds = []
    } = req.body || {};

    if (!["enable", "disable"].includes(mode)) {
      return res.status(400).json({ error: "Invalid mode. Use 'enable' or 'disable'." });
    }
    if (!["all", "employees", "slips"].includes(scope)) {
      return res.status(400).json({ error: "Invalid scope. Use 'all', 'employees', or 'slips'." });
    }

    const taxCfg = (mode === "enable")
      ? await TaxConfig.findOne({ fiscalYear }).lean()
      : null;

    if (mode === "enable" && !taxCfg) {
      return res.status(404).json({ error: `TaxConfig not found for ${fiscalYear}` });
    }

    const query = { owner: ownerId };
    if (scope === "employees") {
      if (!Array.isArray(employeeIds) || employeeIds.length === 0) {
        return res.status(400).json({ error: "employeeIds required when scope='employees'." });
      }
      query.employee = { $in: employeeIds };
    } else if (scope === "slips") {
      if (!Array.isArray(slipIds) || slipIds.length === 0) {
        return res.status(400).json({ error: "slipIds required when scope='slips'." });
      }
      query._id = { $in: slipIds };
    }

    const slips = await SalarySlip.find(query);
    if (!slips.length) return res.json({ updated: 0, mode, scope, slips: [] });

    const results = [];
    for (const slip of slips) {
      const calc = await calculateSlipWithTaxAsync(slip, taxCfg || {});

      let monthlyTax, totalDeductions, netPayable;

      if (mode === "enable") {
        monthlyTax = calc.monthlyTax;
        totalDeductions = calc.totalDeductions;
        netPayable = calc.netPayable;
      } else {
        // DISABLE → set tax to 0, recompute totals without tax
        monthlyTax = 0;
        totalDeductions = calc._debug.baseDeductionsMonthly + calc._debug.loanDeductionsMonthly;
        netPayable = Math.max(0, calc.grossMonthly - totalDeductions);
      }

      // Persist encrypted - INCLUDING LOAN BENEFITS
      await writeEnc(slip, "grossSalary", calc.grossMonthly);
      await writeEnc(slip, "taxDeduction", monthlyTax);
      await writeEnc(slip, "totalAllowances", calc.totalAllowances);
      await writeEnc(slip, "totalDeductions", totalDeductions);
      await writeEnc(slip, "netPayable", netPayable);
      await writeEnc(slip, "loanBenefits", calc.loanBenefits); // ADDED

      await slip.save();

      results.push({
        slipId: slip._id.toString(),
        employee: String(slip.employee),
        month: slip.month,
        year: slip.year,
        action: mode,
        taxDeduction: monthlyTax,
        netPayable,
        loanBenefits: calc.loanBenefits // ADDED
      });
    }

    return res.json({ updated: results.length, mode, scope, slips: results });
  } catch (err) {
    console.error("updateTaxForOwner error:", err);
    return res.status(500).json({ error: "Failed to update tax" });
  }
};

exports.getOwnerSlipSummaries = async (req, res) => {
  try {
    const ownerId = req.user._id;

    const slips = await SalarySlip.find({ owner: ownerId }).select(
      [
        "_id",
        "employee",
        "month",
        "year",
        "basic",
        "loanBenefits", // ADDED: Include loan benefits
        "loanDeductions.vehicleLoan",
        "loanDeductions.otherLoans",
        "taxDeduction",
        "netPayable",
      ].join(" ")
    );

    const data = await Promise.all(
      slips.map(async (s) => ({
        slipId: s._id.toString(),
        employee: String(s.employee),
        month: s.month,
        year: s.year,
        basic: await readEncNumberAsync(s.basic, "basic"),
        loanBenefits: await readEncNumberAsync(s.loanBenefits, "loanBenefits"), // ADDED
        loanDeductions:
          (await readEncNumberAsync(s?.loanDeductions?.vehicleLoan, "loanDeductions.vehicleLoan")) +
          (await readEncNumberAsync(s?.loanDeductions?.otherLoans, "loanDeductions.otherLoans")),
        taxDeduction: await readEncNumberAsync(s.taxDeduction, "taxDeduction"),
        netPayable: await readEncNumberAsync(s.netPayable, "netPayable"),
      }))
    );

    return res.json({ slips: data });
  } catch (err) {
    console.error("getOwnerSlipSummaries error:", err);
    return res.status(500).json({ error: "Failed to load slips" });
  }
};

/** Get tax calculation details for a specific slip */
exports.getTaxCalculationDetails = async (req, res) => {
  try {
    const { slipId } = req.params;
    
    const slip = await SalarySlip.findById(slipId);
    if (!slip) {
      return res.status(404).json({ error: "Salary slip not found" });
    }

    const taxCfg = await TaxConfig.findOne({ fiscalYear: "2025-26" }).lean();
    const calculation = await calculateSlipWithTaxAsync(slip, taxCfg || {});

    return res.json({
      success: true,
      calculation: {
        ...calculation,
        // Include detailed breakdown
        breakdown: {
          grossSalary: calculation.grossMonthly,
          baseDeductions: calculation._debug.baseDeductionsMonthly,
          loanDeductions: calculation._debug.loanDeductionsMonthly,
          netBeforeTax: calculation._debug.netBeforeTax,
          medicalExemption: calculation.medExemptMonthly,
          taxableIncome: calculation._debug.taxableMonthly,
          annualTaxable: calculation.annualTaxable,
          taxAmount: calculation.monthlyTax
        }
      }
    });
  } catch (err) {
    console.error("getTaxCalculationDetails error:", err);
    return res.status(500).json({ error: "Failed to get tax calculation details" });
  }
};

/** Test loan benefits calculation for an employee */
exports.testLoanBenefitsCalculation = async (req, res) => {
  try {
    const { employeeId, monthYear } = req.body;
    
    if (!employeeId || !monthYear) {
      return res.status(400).json({ error: "Employee ID and monthYear are required" });
    }

    const scheduleBenefits = await calculateLoanBenefitsAsync(employeeId, monthYear);
    const markupBenefits = await calculateLoanBenefitsFromMarkupValue(employeeId, monthYear);

    return res.json({
      success: true,
      fromSchedule: scheduleBenefits,
      fromMarkup: markupBenefits,
      combined: {
        totalLoanBenefits: scheduleBenefits.totalLoanBenefits + markupBenefits.totalLoanBenefits,
        allDetails: [...scheduleBenefits.loanDetails, ...markupBenefits.loanDetails]
      }
    });
  } catch (err) {
    console.error("testLoanBenefitsCalculation error:", err);
    return res.status(500).json({ error: "Failed to test loan benefits calculation" });
  }
};

module.exports = exports;