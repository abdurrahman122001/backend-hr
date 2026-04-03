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
const monthOrder = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"
];

// Generate full fiscal months starting from the given month/year
function generateFiscalMonths(startMonth, startYear) {
  const startIndex = monthOrder.indexOf(startMonth);
  let year = parseInt(startYear);

  const result = [];

  for (let i = 0; i < 12; i++) {
    const index = (startIndex + i) % 12;

    // When we wrap from December -> January, increase year
    if (index === 0 && i > 0) year++;

    result.push({
      month: monthOrder[index],
      year: year.toString(),
      processedAt: new Date()
    });
  }

  return result;
}


const toStr = (num) => Math.round(Number(num) || 0).toString();

/** Decrypt (supports sync or async). Fallback to numeric parse. */
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
    if (DEBUG_TAX && (num === 0 || Number.isNaN(num))) {
      console.warn(`[tax] decrypt(${fieldName}) → "${dec}" → 0`);
    }
    return num;
  } catch {
    const num = toNum(raw);
    if (DEBUG_TAX && num === 0) {
      console.warn(
        `[tax] read(${fieldName}) not decryptable & not numeric → 0`
      );
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

// Allowances → gross (Basic + Conveyance + Incentive, per policy)
const ALLOWANCE_KEYS = [
  "basic",
  "conveyanceAllowance",
  "incentive",
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
  "othersDeductions",
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
          `[tax] slab match: A=${A.toLocaleString()} | from=${s.from.toLocaleString()} to=${s.to === Infinity ? "∞" : s.to.toLocaleString()
          } | fixed=${s.fixed.toLocaleString()} | rate=${(s.rate * 100).toFixed(
            2
          )}% | over=${over.toLocaleString()} | annualTax=${tax.toLocaleString()}`
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
        `[tax] top band: A=${A.toLocaleString()} | from=${last.from.toLocaleString()} | fixed=${last.fixed.toLocaleString()} | rate=${(
          last.rate * 100
        ).toFixed(
          2
        )}% | over=${over.toLocaleString()} | annualTax=${tax.toLocaleString()}`
      );
    }
    return tax;
  }

  return 0;
}

async function calculateTaxableMonthlyOnly(slip, taxCfg) {
  let grossMonthly = 0;
  for (const key of ALLOWANCE_KEYS) {
    grossMonthly += await readFirstNumAsync(slip, [key]);
  }
  return grossMonthly;
}

/* ---------------------- slip calculation (async) ---------------------- */
async function calculateSlipWithTaxAsync(slip, taxCfg) {
  if (DEBUG_TAX) {
    console.log("---------------------------------------------------");
    console.log(`[tax] Starting tax calculation for slip: ${slip._id}`);
    console.log(`[tax] Employee: ${slip.employee?._id}, Month: ${slip.month} ${slip.year}`);
  }

  // 1) Gross monthly
  let grossMonthly = 0;
  for (const key of ALLOWANCE_KEYS) {
    const value = await readFirstNumAsync(slip, [key]);
    grossMonthly += value;
  }

  const basic = await readFirstNumAsync(slip, ["basic"]);
  const medMonthly = await readFirstNumAsync(slip, ["medicalAllowance"]);

  // 2) Base deductions
  let baseDeductionsMonthly = 0;
  for (const key of BASE_DEDUCTION_KEYS) {
    const value = await readFirstNumAsync(slip, [key]);
    baseDeductionsMonthly += value;
  }

  // 3) Taxable monthly (Basic + Conveyance + Incentive)
  const taxableMonthly = grossMonthly;
  const medExemptMonthly = 0; // Not applicable for the fixed gross rule

  // 6.1) Calculate pro-rated months remaining in fiscal year (July to June)
  const fiscalStartMonth = 7; // July
  const fiscalEndMonth = 6;   // June

  let joiningDate = null;
  if (slip.employee?.joiningDate) {
    joiningDate = new Date(slip.employee.joiningDate);
  }

  // Use the slip's month/year to determine the fiscal year start
  const slipMonthIndex = monthOrder.indexOf(slip.month);
  const slipYearNum = parseInt(slip.year);

  const fiscalStart = new Date(slipYearNum, fiscalStartMonth - 1, 1);
  if (slipMonthIndex + 1 <= fiscalEndMonth) {
    fiscalStart.setFullYear(fiscalStart.getFullYear() - 1);
  }

  const effectiveStart = (joiningDate && joiningDate > fiscalStart) ? joiningDate : fiscalStart;
  const fiscalEnd = new Date(fiscalStart.getFullYear() + 1, fiscalEndMonth, 1);

  let monthsRemaining = (fiscalEnd.getFullYear() - effectiveStart.getFullYear()) * 12 + (fiscalEnd.getMonth() - effectiveStart.getMonth());
  if (monthsRemaining < 1) monthsRemaining = 1;

  // 6.2) Annualize + compute band-only tax using remaining months
  // NEW: Sum actual gross from previous slips in the same fiscal year
  const employeeId = slip.employee?._id || slip.employee;
  const allSlipsInYear = await SalarySlip.find({
    employee: employeeId,
    owner: slip.owner
  }).lean();

  const pastFiscalSlips = allSlipsInYear.filter(s => {
    const sMonthIndex = monthOrder.indexOf(s.month);
    const sYearNum = parseInt(s.year);
    const sDate = new Date(sYearNum, sMonthIndex, 1);
    const currentSlipDate = new Date(slipYearNum, slipMonthIndex, 1);
    return sDate >= fiscalStart && sDate < currentSlipDate;
  });

  let sumPastTaxable = 0;
  for (const ps of pastFiscalSlips) {
    sumPastTaxable += await calculateTaxableMonthlyOnly(ps, taxCfg);
  }

  const monthsAlreadyCovered = pastFiscalSlips.length;
  const remainingProjectedMonths = Math.max(0, monthsRemaining - monthsAlreadyCovered);

  const annualTaxable = sumPastTaxable + (taxableMonthly * remainingProjectedMonths);

  const annualTax = computeAnnualTaxBandOnly(
    annualTaxable,
    taxCfg?.slabs || []
  );
  const monthlyTax = Math.round(annualTax / monthsRemaining);

  // 7) Final totals
  const totalDeductions = baseDeductionsMonthly + monthlyTax;
  const netPayable = Math.max(0, grossMonthly - totalDeductions);

  /* ----------------- DEBUG LOGS ----------------- */
  if (DEBUG_TAX) {
    console.log("---------------------------------------------------");
    console.log(`[tax DEBUG] Slip ID: ${slip._id}`);
    console.log(`[tax DEBUG] Basic Salary       = ${basic}`);
    console.log(`[tax DEBUG] Gross = Basic+Conveyance = ${grossMonthly}`);
    console.log(`[tax DEBUG] Base Deductions    = ${baseDeductionsMonthly}`);
    console.log(`[tax DEBUG] Net Before Tax     = ${netBeforeTax}`);
    console.log(`[tax DEBUG] Medical Exemptions = ${medExemptMonthly}`);
    console.log(`[tax DEBUG] Joining Date      = ${joiningDate ? joiningDate.toDateString() : "N/A"}`);
    console.log(`[tax DEBUG] Effective Start    = ${effectiveStart.toDateString()}`);
    console.log(`[tax DEBUG] Months in Period   = ${monthsRemaining}`);
    console.log(`[tax DEBUG] Taxable Monthly    = ${taxableMonthly}`);
    console.log(`[tax DEBUG] Annual Taxable     = ${annualTaxable}`);
    console.log(`[tax DEBUG] Annual Tax         = ${annualTax}`);
    console.log(`[tax DEBUG] Monthly Tax        = ${monthlyTax}`);
    console.log(`[tax DEBUG] TOTAL Deductions   = ${totalDeductions}`);
    console.log(`[tax DEBUG] Net Payable        = ${netPayable}`);
    console.log("---------------------------------------------------\n");
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
    _debug: {
      baseDeductionsMonthly,
      netBeforeTax,
      taxableMonthly,
    },
  };
}

exports.enableAutoTax = async (req, res) => {
  try {
    const { fiscalYear = "2025-26", fromMonth, fromYear } = req.body;

    if (!fromMonth || !fromYear) {
      return res.status(400).json({
        error: "fromMonth and fromYear are required to enable auto-tax",
      });
    }

    // Load existing TaxConfig WITHOUT overwriting slabs
    let taxCfg = await TaxConfig.findOne({ fiscalYear });

    if (!taxCfg) {
      return res.status(400).json({
        error: `TaxConfig for fiscal year ${fiscalYear} does not exist. Create slabs first.`,
      });
    }

    if (!taxCfg.slabs || taxCfg.slabs.length === 0) {
      return res.status(400).json({
        error: `No tax slabs defined for ${fiscalYear}. Cannot enable auto-tax.`,
      });
    }

    // Update auto-tax-only fields (safe)
    await TaxConfig.updateOne(
      { fiscalYear },
      {
        autoApplyEnabled: true,
        autoApplyFromMonth: { month: fromMonth, year: fromYear },
        autoApplyEnabledAt: new Date(),
        $addToSet: { autoEnabledOwners: req.user._id },
      }
    );

    // Reload updated config
    taxCfg = await TaxConfig.findOne({ fiscalYear }).lean();

    // Create full fiscal year month cycle
    const fiscalMonths = generateFiscalMonths(fromMonth, fromYear);

    // Store fiscal months to DB
    await TaxConfig.updateOne(
      { fiscalYear },
      { $addToSet: { processedAutoTaxMonths: { $each: fiscalMonths } } }
    );

    // Apply tax to all slips inside fiscal-year cycle
    const appliedSlips = await applyAutoTaxToFutureSlips(
      req.user._id,
      fiscalMonths,
      taxCfg
    );

    return res.json({
      success: true,
      message: `Auto-tax enabled successfully for fiscal year ${fiscalYear}`,
      taxConfig: {
        fiscalYear: taxCfg.fiscalYear,
        autoApplyEnabled: true,
        autoApplyFromMonth: taxCfg.autoApplyFromMonth,
        autoApplyEnabledAt: taxCfg.autoApplyEnabledAt,
        processedAutoTaxMonths: fiscalMonths,
      },
      appliedToSlips: appliedSlips,
    });

  } catch (err) {
    console.error("enableAutoTax error:", err);
    return res.status(500).json({ error: "Failed to enable auto-tax" });
  }
};

/** Disable auto-tax application */
exports.disableAutoTax = async (req, res) => {
  try {
    const { fiscalYear = "2025-26" } = req.body;

    const taxCfg = await TaxConfig.findOneAndUpdate(
      { fiscalYear },
      {
        autoApplyEnabled: false,
        $pull: { autoEnabledOwners: req.user._id },
      },
      { new: true }
    );

    return res.json({
      success: true,
      message: "Auto-tax disabled",
      taxConfig: {
        fiscalYear: taxCfg?.fiscalYear,
        autoApplyEnabled: false,
      },
    });
  } catch (err) {
    console.error("disableAutoTax error:", err);
    return res.status(500).json({ error: "Failed to disable auto-tax" });
  }
};

/** Get auto-tax status - UPDATED to use query parameters */
exports.getAutoTaxStatus = async (req, res) => {
  try {
    const { fiscalYear = "2025-26" } = req.query; // CHANGED from req.params to req.query

    console.log(`[tax] Checking auto-tax status for fiscalYear: ${fiscalYear}, user: ${req.user._id}`);

    const taxCfg = await TaxConfig.findOne({ fiscalYear }).lean();

    if (!taxCfg) {
      console.log(`[tax] No TaxConfig found for fiscal year: ${fiscalYear}`);
      return res.json({
        autoTaxEnabled: false,
        config: null
      });
    }

    console.log(`[tax] TaxConfig found - autoApplyEnabled: ${taxCfg.autoApplyEnabled}`);
    console.log(`[tax] autoEnabledOwners:`, taxCfg.autoEnabledOwners);

    const isAutoEnabled = taxCfg?.autoApplyEnabled &&
      taxCfg.autoEnabledOwners?.includes(req.user._id.toString());

    console.log(`[tax] Final autoTaxEnabled: ${isAutoEnabled}`);

    return res.json({
      autoTaxEnabled: !!isAutoEnabled,
      config: taxCfg ? {
        fiscalYear: taxCfg.fiscalYear,
        autoApplyEnabled: taxCfg.autoApplyEnabled,
        autoApplyFromMonth: taxCfg.autoApplyFromMonth,
        autoApplyEnabledAt: taxCfg.autoApplyEnabledAt,
        processedAutoTaxMonths: taxCfg.processedAutoTaxMonths,
        slabs: taxCfg.slabs,
        enableMedicalExemption: taxCfg.enableMedicalExemption,
      } : null
    });

  } catch (err) {
    console.error("getAutoTaxStatus error:", err);
    return res.status(500).json({ error: "Failed to get auto-tax status" });
  }
};
async function applyAutoTaxToFutureSlips(ownerId, fiscalMonths, taxCfg) {
  try {
    // Fetch all slips for this owner
    const allSlips = await SalarySlip.find({ owner: ownerId })
      .populate("employee")
      .lean();

    // Filter slips matching any fiscal year month
    const slipsToUpdate = allSlips.filter((slip) =>
      fiscalMonths.some(
        (fm) => fm.month === slip.month && fm.year === slip.year
      )
    );

    const results = [];

    for (const slipData of slipsToUpdate) {
      const slip = await SalarySlip.findById(slipData._id);
      if (!slip) continue;

      // Calculate tax using slabs
      const calc = await calculateSlipWithTaxAsync(slip, taxCfg);

      // Update slip (encrypted)
      await writeEnc(slip, "grossSalary", calc.grossMonthly);
      await writeEnc(slip, "taxDeduction", calc.monthlyTax);
      await writeEnc(slip, "totalAllowances", calc.totalAllowances);
      await writeEnc(slip, "totalDeductions", calc.totalDeductions);
      await writeEnc(slip, "netPayable", calc.netPayable);
      await slip.save();

      results.push({
        slipId: slip._id.toString(),
        employee: String(slip.employee),
        month: slip.month,
        year: slip.year,
        taxApplied: calc.monthlyTax,
        netPayable: calc.netPayable,
      });
    }

    return results;

  } catch (err) {
    console.error("applyAutoTaxToFutureSlips error:", err);
    return [];
  }
}


/** Auto-apply tax to new slips if auto-tax is enabled - ENHANCED FOR ATTENDANCE FLOW */
exports.autoApplyTaxIfEnabled = async function (slip) {
  try {
    console.log(`[TAX-AUTO] Checking auto-tax for slip: ${slip._id}, Owner: ${slip.owner}, Month: ${slip.month} ${slip.year}`);

    // Check if tax is already applied
    const currentTax = slip.taxDeduction ? (Number(await decrypt(slip.taxDeduction)) || 0) : 0;
    if (currentTax > 0) {
      console.log(`[TAX-AUTO] Tax already applied: ${currentTax}, skipping`);
      return;
    }

    const taxCfg = await TaxConfig.findOne({
      fiscalYear: "2025-26",
      autoApplyEnabled: true,
      autoEnabledOwners: slip.owner
    }).lean();

    if (!taxCfg) {
      console.log(`[TAX-AUTO] Auto-tax not enabled for owner: ${slip.owner}`);
      return;
    }

    console.log(`[TAX-AUTO] Auto-tax enabled for this owner. Checking date conditions...`);

    // Check if this slip is from the auto-apply month or later
    const monthOrder = [
      "January", "February", "March", "April", "May", "June",
      "July", "August", "September", "October", "November", "December"
    ];

    const slipMonthIndex = monthOrder.indexOf(slip.month);
    const slipYear = parseInt(slip.year);

    // Handle case where autoApplyFromMonth might not be set
    if (!taxCfg.autoApplyFromMonth || !taxCfg.autoApplyFromMonth.month) {
      console.log(`[TAX-AUTO] autoApplyFromMonth not configured, applying tax to all slips`);
    } else {
      const autoFromMonthIndex = monthOrder.indexOf(taxCfg.autoApplyFromMonth.month);
      const autoFromYear = parseInt(taxCfg.autoApplyFromMonth.year);

      const shouldApplyTax = slipYear > autoFromYear ||
        (slipYear === autoFromYear && slipMonthIndex >= autoFromMonthIndex);

      if (!shouldApplyTax) {
        console.log(`[TAX-AUTO] Slip ${slip.month} ${slip.year} is before auto-apply date ${taxCfg.autoApplyFromMonth.month} ${taxCfg.autoApplyFromMonth.year}`);
        return;
      }
    }

    console.log(`[TAX-AUTO] Applying auto-tax to slip ${slip._id} (${slip.month} ${slip.year})`);

    // Populate employee data if needed
    if (!slip.employee || typeof slip.employee === 'string') {
      await slip.populate('employee');
    }

    const calc = await calculateSlipWithTaxAsync(slip, taxCfg);

    await writeEnc(slip, "grossSalary", calc.grossMonthly);
    await writeEnc(slip, "taxDeduction", calc.monthlyTax);
    await writeEnc(slip, "totalAllowances", calc.totalAllowances);
    await writeEnc(slip, "totalDeductions", calc.totalDeductions);
    await writeEnc(slip, "netPayable", calc.netPayable);

    await slip.save();

    console.log(`[TAX-AUTO] ✅ Auto-applied tax for slip ${slip._id} (${slip.month} ${slip.year})`);
    console.log(`[TAX-AUTO] Tax applied: ${calc.monthlyTax}, Net payable: ${calc.netPayable}`);

    return {
      success: true,
      taxApplied: calc.monthlyTax,
      netPayable: calc.netPayable
    };

  } catch (err) {
    console.error("[TAX-AUTO] ❌ autoApplyTaxIfEnabled error:", err);
    return { success: false, error: err.message };
  }
};

/** Manual tax application for specific slips */
exports.manualApplyTax = async (req, res) => {
  try {
    const { slipIds, fiscalYear = "2025-26" } = req.body;

    if (!slipIds || !Array.isArray(slipIds) || slipIds.length === 0) {
      return res.status(400).json({ error: "slipIds array is required" });
    }

    const taxCfg = await TaxConfig.findOne({ fiscalYear }).lean();
    if (!taxCfg) {
      return res
        .status(404)
        .json({ error: `TaxConfig not found for ${fiscalYear}` });
    }

    const results = [];

    for (const slipId of slipIds) {
      const slip = await SalarySlip.findById(slipId).populate("employee");
      if (!slip) continue;

      const calc = await calculateSlipWithTaxAsync(slip, taxCfg);

      await writeEnc(slip, "grossSalary", calc.grossMonthly);
      await writeEnc(slip, "taxDeduction", calc.monthlyTax);
      await writeEnc(slip, "totalAllowances", calc.totalAllowances);
      await writeEnc(slip, "totalDeductions", calc.totalDeductions);
      await writeEnc(slip, "netPayable", calc.netPayable);

      await slip.save();

      results.push({
        slipId: slip._id.toString(),
        employee: String(slip.employee),
        month: slip.month,
        year: slip.year,
        taxApplied: calc.monthlyTax,
        netPayable: calc.netPayable,
      });
    }

    return res.json({
      success: true,
      updated: results.length,
      slips: results,
    });
  } catch (err) {
    console.error("manualApplyTax error:", err);
    return res.status(500).json({ error: "Failed to apply tax manually" });
  }
};

/** ✅ UPDATED enableTaxForOwner */
exports.enableTaxForOwner = async (req, res) => {
  try {
    const ownerId = req.user._id;
    const { fiscalYear = "2025-26" } = req.body || {};

    const taxCfg = await TaxConfig.findOne({ fiscalYear }).lean();
    if (!taxCfg) {
      return res
        .status(404)
        .json({ error: `TaxConfig not found for ${fiscalYear}` });
    }

    const slips = await SalarySlip.find({ owner: ownerId });
    if (!slips.length) return res.json({ updated: 0, slips: [] });

    const results = [];

    for (const slip of slips) {
      const calc = await calculateSlipWithTaxAsync(slip, taxCfg);

      // Persist (encrypted)
      await writeEnc(slip, "grossSalary", calc.grossMonthly);
      await writeEnc(slip, "taxDeduction", calc.monthlyTax);
      await writeEnc(slip, "totalAllowances", calc.totalAllowances);
      await writeEnc(slip, "totalDeductions", calc.totalDeductions);
      await writeEnc(slip, "netPayable", calc.netPayable);

      await slip.save();

      results.push({
        slipId: slip._id.toString(),
        employee: String(slip.employee),
        month: slip.month,
        year: slip.year,
        taxDeduction: calc.monthlyTax,
        netPayable: calc.netPayable,
      });
    }

    /** ✅ Added — remember that this owner has tax auto-enabled */
    await TaxConfig.updateOne(
      { fiscalYear },
      { $addToSet: { autoEnabledOwners: ownerId } }, // add owner to auto-enabled list
      { upsert: true }
    );

    return res.json({
      updated: results.length,
      slips: results,
      autoEnabled: true,
    });
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
      slipIds = [],
    } = req.body || {};

    if (!["enable", "disable"].includes(mode)) {
      return res
        .status(400)
        .json({ error: "Invalid mode. Use 'enable' or 'disable'." });
    }
    if (!["all", "employees", "slips"].includes(scope)) {
      return res
        .status(400)
        .json({ error: "Invalid scope. Use 'all', 'employees', or 'slips'." });
    }

    const taxCfg =
      mode === "enable" ? await TaxConfig.findOne({ fiscalYear }).lean() : null;

    if (mode === "enable" && !taxCfg) {
      return res
        .status(404)
        .json({ error: `TaxConfig not found for ${fiscalYear}` });
    }

    const query = { owner: ownerId };
    if (scope === "employees") {
      if (!Array.isArray(employeeIds) || employeeIds.length === 0) {
        return res
          .status(400)
          .json({ error: "employeeIds required when scope='employees'." });
      }
      query.employee = { $in: employeeIds };
    } else if (scope === "slips") {
      if (!Array.isArray(slipIds) || slipIds.length === 0) {
        return res
          .status(400)
          .json({ error: "slipIds required when scope='slips'." });
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
        totalDeductions = calc._debug.baseDeductionsMonthly;
        netPayable = Math.max(0, calc.grossMonthly - totalDeductions);
      }

      // Persist encrypted
      await writeEnc(slip, "grossSalary", calc.grossMonthly);
      await writeEnc(slip, "taxDeduction", monthlyTax);
      await writeEnc(slip, "totalAllowances", calc.totalAllowances);
      await writeEnc(slip, "totalDeductions", totalDeductions);
      await writeEnc(slip, "netPayable", netPayable);

      await slip.save();

      results.push({
        slipId: slip._id.toString(),
        employee: String(slip.employee),
        month: slip.month,
        year: slip.year,
        action: mode,
        taxDeduction: monthlyTax,
        netPayable,
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
          netBeforeTax: calculation._debug.netBeforeTax,
          medicalExemption: calculation.medExemptMonthly,
          taxableIncome: calculation._debug.taxableMonthly,
          annualTaxable: calculation.annualTaxable,
          taxAmount: calculation.monthlyTax,
        },
      },
    });
  } catch (err) {
    console.error("getTaxCalculationDetails error:", err);
    return res
      .status(500)
      .json({ error: "Failed to get tax calculation details" });
  }
};

/* ═══════════════════════════════════════════════════════════════
   NEW: Tax Config CRUD  (called by admin Tax Settings UI)
   ═══════════════════════════════════════════════════════════════ */

/**
 * GET /api/tax/config?fiscalYear=2025-26
 * Returns the TaxConfig document (slabs + fiscal year boundaries + applyTo).
 * If no fiscalYear is provided, returns ALL configs for listing.
 */
exports.getTaxConfig = async (req, res) => {
  try {
    const { fiscalYear } = req.query;

    if (fiscalYear) {
      const cfg = await TaxConfig.findOne({ fiscalYear })
        .populate("employeeIds", "_id name companyEmail")
        .lean();
      return res.json({ success: true, config: cfg || null });
    }

    // Return all fiscal years as a list (for the dropdown)
    const all = await TaxConfig.find({})
      .select("fiscalYear fiscalYearStart fiscalYearEnd slabs enableMedicalExemption applyTo autoApplyEnabled")
      .lean();
    return res.json({ success: true, configs: all });
  } catch (err) {
    console.error("getTaxConfig error:", err);
    return res.status(500).json({ error: "Failed to fetch tax config" });
  }
};

/**
 * POST /api/tax/config
 * Body: { fiscalYear, fiscalYearStart, fiscalYearEnd, slabs, enableMedicalExemption, applyTo, employeeIds }
 * Creates or fully replaces the TaxConfig for that fiscal year.
 */
exports.saveTaxConfig = async (req, res) => {
  try {
    const {
      fiscalYear,
      fiscalYearStart,
      fiscalYearEnd,
      slabs = [],
      enableMedicalExemption = true,
      applyTo = "all",
      employeeIds = [],
    } = req.body;

    if (!fiscalYear) {
      return res.status(400).json({ error: "fiscalYear is required" });
    }

    // Validate slabs
    for (const slab of slabs) {
      if (slab.from === undefined || slab.from === null) {
        return res.status(400).json({ error: "Each slab must have a 'from' value" });
      }
    }

    const update = {
      fiscalYear,
      slabs,
      enableMedicalExemption,
      applyTo,
      employeeIds: applyTo === "selected" ? employeeIds : [],
    };

    if (fiscalYearStart) update.fiscalYearStart = fiscalYearStart;
    if (fiscalYearEnd) update.fiscalYearEnd = fiscalYearEnd;

    const cfg = await TaxConfig.findOneAndUpdate(
      { fiscalYear },
      { $set: update },
      { upsert: true, new: true }
    );

    return res.json({
      success: true,
      message: `Tax configuration saved for ${fiscalYear}`,
      config: cfg,
    });
  } catch (err) {
    console.error("saveTaxConfig error:", err);
    return res.status(500).json({ error: "Failed to save tax config" });
  }
};

/**
 * DELETE /api/tax/config/:fiscalYear
 * Removes the TaxConfig document for the given fiscal year.
 */
exports.deleteTaxConfig = async (req, res) => {
  try {
    const { fiscalYear } = req.params;
    await TaxConfig.deleteOne({ fiscalYear });
    return res.json({ success: true, message: `Tax config for ${fiscalYear} deleted` });
  } catch (err) {
    console.error("deleteTaxConfig error:", err);
    return res.status(500).json({ error: "Failed to delete tax config" });
  }
};

module.exports = exports;
