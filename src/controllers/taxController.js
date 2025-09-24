const SalarySlip = require("../models/SalarySlip");
const TaxConfig = require("../models/TaxConfig");
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
    // This would typically call your loan service to get benefits for the employee
    // For now, we'll simulate the calculation based on your frontend logic
    
    // In a real implementation, you would fetch from your loan benefits API
    const loanBenefits = await getLoanBenefitsFromAPI(employeeId, monthYear);
    
    return {
      totalLoanBenefits: loanBenefits.totalLoanBenefits || 0,
      loanDetails: loanBenefits.loanDetails || []
    };
  } catch (error) {
    console.warn(`[tax] Failed to fetch loan benefits for employee ${employeeId}:`, error);
    return {
      totalLoanBenefits: 0,
      loanDetails: []
    };
  }
}

// Mock function - replace with actual API call
async function getLoanBenefitsFromAPI(employeeId, monthYear) {
  // This should call your actual loan benefits endpoint
  // For example: 
  // const response = await api.get(`/loans/loan-benefits/${employeeId}`, { params: { monthYear } });
  // return response.data;
  
  return {
    totalLoanBenefits: 0, // Default to 0 if API not available
    loanDetails: []
  };
}

/* ---------------------- slip calculation (async) ---------------------- */
async function calculateSlipWithTaxAsync(slip, taxCfg) {
  // 1) Calculate loan benefits first
  let loanBenefits = 0;
  if (slip.employee?._id) {
    const monthYear = `${slip.month} ${slip.year}`;
    const loanData = await calculateLoanBenefitsAsync(slip.employee._id, monthYear);
    loanBenefits = loanData.totalLoanBenefits;
    
    if (DEBUG_TAX) {
      console.log(`[tax] employee=${slip.employee._id} loanBenefits=${loanBenefits.toLocaleString()}`);
    }
  }

  // 2) Gross monthly (INCLUDING LOAN BENEFITS)
  let grossMonthly = 0;
  for (const key of ALLOWANCE_KEYS) {
    if (key === "loanBenefits") {
      // Add loan benefits to gross
      grossMonthly += loanBenefits;
    } else {
      grossMonthly += await readFirstNumAsync(slip, [key]);
    }
  }

  const basic = await readFirstNumAsync(slip, ["basic"]);
  const medMonthly = await readFirstNumAsync(slip, ["medicalAllowance"]);

  // 3) Split deductions
  let baseDeductionsMonthly = 0;
  for (const key of BASE_DEDUCTION_KEYS) {
    baseDeductionsMonthly += await readFirstNumAsync(slip, [key]);
  }

  let loanDeductionsMonthly = 0;
  for (const key of LOAN_DEDUCTION_KEYS) {
    loanDeductionsMonthly += await readFirstNumAsync(slip, [key]);
  }

  // 4) Net BEFORE income tax (EXCLUDES LOAN DEDUCTIONS)
  const netBeforeTax = Math.max(0, grossMonthly - baseDeductionsMonthly);

  // 5) SHEET-STYLE medical exemption
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

  if (DEBUG_TAX) {
    console.log(
      `[tax] slip=${slip._id}` +
        ` basic=${basic.toLocaleString()}` +
        ` medM=${medMonthly.toLocaleString()}` +
        ` loanBenefits=${loanBenefits.toLocaleString()}` + // ADDED
        ` grossM=${grossMonthly.toLocaleString()}` +
        ` baseDedM=${baseDeductionsMonthly.toLocaleString()}` +
        ` loanDedM=${loanDeductionsMonthly.toLocaleString()}` +
        ` netBeforeTax=${netBeforeTax.toLocaleString()}` +
        ` medExemptM=${medExemptMonthly.toLocaleString()}` +
        ` taxableM=${taxableMonthly.toLocaleString()}` +
        ` annualTaxable=${annualTaxable.toLocaleString()}` +
        ` annualTax=${annualTax.toLocaleString()}` +
        ` monthlyTax=${monthlyTax.toLocaleString()}` +
        ` net=${netPayable.toLocaleString()}`
    );
  }

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
    loanBenefits, // ADDED: Return loan benefits for frontend
    _debug: {
      baseDeductionsMonthly,
      loanDeductionsMonthly,
      netBeforeTax,
      taxableMonthly,
      loanBenefits // ADDED
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

