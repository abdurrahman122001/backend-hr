const SalarySlip = require("../models/SalarySlip");
const TaxConfig = require("../models/TaxConfig");
const LoanDetail = require("../models/LoanDetail");
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
  "loanBenefits",
];

// Loans → excluded from taxable base (but reduce final net)
const LOAN_DEDUCTION_KEYS = [
  "loanDeductions.vehicleLoan",
  "loanDeductions.otherLoans",
  "vehicleLoanDeduction",
  "otherLoanDeductions",
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
          `[tax] slab match: A=${A.toLocaleString()} | from=${s.from.toLocaleString()} to=${
            s.to === Infinity ? "∞" : s.to.toLocaleString()
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

/* ---------------------- loan benefits calculation ---------------------- */
async function calculateLoanBenefitsAsync(employeeId, monthYear) {
  try {
    const [monthName, yearStr] = monthYear.split(" ");
    const year = parseInt(yearStr);

    if (!monthName || !year || isNaN(year)) {
      console.warn(`[tax] Invalid monthYear format: ${monthYear}`);
      return { totalLoanBenefits: 0, loanDetails: [] };
    }

    if (DEBUG_TAX) {
      console.log(
        `[tax] Calculating loan benefits for employee ${employeeId}, ${monthYear}`
      );
    }

    const loanDetails = await LoanDetail.find({
      employee: employeeId,
    }).lean();

    if (!loanDetails || loanDetails.length === 0) {
      if (DEBUG_TAX) {
        console.log(`[tax] No loan details found for employee ${employeeId}`);
      }
      return { totalLoanBenefits: 0, loanDetails: [] };
    }

    if (DEBUG_TAX) {
      console.log(
        `[tax] Found ${loanDetails.length} loan details for employee ${employeeId}`
      );
    }

    let totalLoanBenefits = 0;
    const loanBenefitDetails = [];

    for (const loan of loanDetails) {
      const monthlyBenefit = await calculateMonthlyLoanBenefitFromSchedule(
        loan,
        monthName,
        year
      );

      if (monthlyBenefit > 0) {
        totalLoanBenefits += monthlyBenefit;
        loanBenefitDetails.push({
          loanId: loan._id,
          loanType: loan.type || "Personal Loan",
          loanAmount: await readEncNumberAsync(loan.loanAmount, "loanAmount"),
          markupValue: loan.markupValue,
          markupType: loan.markupType,
          markupAmount: monthlyBenefit,
          month: monthName,
          year: year,
        });

        if (DEBUG_TAX) {
          console.log(
            `[tax] Added loan benefit: ${monthlyBenefit} for loan ${loan._id}`
          );
        }
      }
    }

    if (DEBUG_TAX) {
      console.log(
        `[tax] Total loan benefits for employee ${employeeId}: ${totalLoanBenefits}`
      );
    }

    return {
      totalLoanBenefits,
      loanDetails: loanBenefitDetails,
    };
  } catch (error) {
    console.error(
      `[tax] Failed to calculate loan benefits for employee ${employeeId}:`,
      error
    );
    return {
      totalLoanBenefits: 0,
      loanDetails: [],
    };
  }
}

/* ---------------------- calculate monthly loan benefit from schedule ---------------------- */
async function calculateMonthlyLoanBenefitFromSchedule(
  loan,
  targetMonth,
  targetYear
) {
  try {
    if (!loan.paymentSchedule || !Array.isArray(loan.paymentSchedule)) {
      return 0;
    }

    const installment = loan.paymentSchedule.find(
      (installment) =>
        installment.month.toLowerCase() === targetMonth.toLowerCase() &&
        parseInt(installment.year) === targetYear
    );

    if (!installment) {
      return 0;
    }

    const markupAmount = await readEncNumberAsync(
      installment.markupAmount,
      "markupAmount"
    );
    return markupAmount;
  } catch (error) {
    console.warn(
      `[tax] Error calculating monthly loan benefit from schedule:`,
      error
    );
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

    const scheduleBenefits = await calculateLoanBenefitsAsync(
      slip.employee._id,
      monthYear
    );
    loanBenefits = scheduleBenefits.totalLoanBenefits;
    loanDetails = scheduleBenefits.loanDetails;
  }

  // 2) Gross monthly (INCLUDING LOAN BENEFITS)
  let grossMonthly = 0;
  for (const key of ALLOWANCE_KEYS) {
    if (key === "loanBenefits") {
      grossMonthly += loanBenefits;
      if (DEBUG_TAX) {
        console.log(`[tax] Added loan benefits to gross: ${loanBenefits}`);
      }
    } else {
      const value = await readFirstNumAsync(slip, [key]);
      grossMonthly += value;
    }
  }

  const basic = await readFirstNumAsync(slip, ["basic"]);
  const medMonthly = await readFirstNumAsync(slip, ["medicalAllowance"]);

  // 3) Split deductions
  let baseDeductionsMonthly = 0;
  for (const key of BASE_DEDUCTION_KEYS) {
    const value = await readFirstNumAsync(slip, [key]);
    baseDeductionsMonthly += value;
  }

  let loanDeductionsMonthly = 0;
  for (const key of LOAN_DEDUCTION_KEYS) {
    const value = await readFirstNumAsync(slip, [key]);
    loanDeductionsMonthly += value;
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
  const annualTax = computeAnnualTaxBandOnly(
    annualTaxable,
    taxCfg?.slabs || []
  );
  const monthlyTax = Math.round(annualTax / 12);

  // 8) Final totals (loan deductions still reduce net payable)
  const totalDeductions =
    baseDeductionsMonthly + loanDeductionsMonthly + monthlyTax;
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

/* ---------------------- NEW: Auto Tax Configuration ---------------------- */

/** Enable auto-tax application from specific month */
exports.enableAutoTax = async (req, res) => {
  try {
    const { fiscalYear = "2025-26", fromMonth, fromYear } = req.body;

    if (!fromMonth || !fromYear) {
      return res.status(400).json({
        error: "fromMonth and fromYear are required to enable auto-tax",
      });
    }

    const taxCfg = await TaxConfig.findOneAndUpdate(
      { fiscalYear },
      {
        autoApplyEnabled: true,
        autoApplyFromMonth: {
          month: fromMonth,
          year: fromYear,
        },
        autoApplyEnabledAt: new Date(),
        $addToSet: { autoEnabledOwners: req.user._id },
      },
      { upsert: true, new: true }
    );

    // Apply tax to all future slips from the specified month
    const result = await applyAutoTaxToFutureSlips(
      req.user._id,
      fromMonth,
      fromYear,
      taxCfg
    );

    return res.json({
      success: true,
      message: `Auto-tax enabled from ${fromMonth} ${fromYear}`,
      taxConfig: {
        fiscalYear: taxCfg.fiscalYear,
        autoApplyEnabled: taxCfg.autoApplyEnabled,
        autoApplyFromMonth: taxCfg.autoApplyFromMonth,
        autoApplyEnabledAt: taxCfg.autoApplyEnabledAt,
      },
      appliedToSlips: result,
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
      } : null
    });

  } catch (err) {
    console.error("getAutoTaxStatus error:", err);
    return res.status(500).json({ error: "Failed to get auto-tax status" });
  }
};
/** Apply auto-tax to all slips from specified month onwards */
async function applyAutoTaxToFutureSlips(ownerId, fromMonth, fromYear, taxCfg) {
  try {
    // Get all slips from the specified month onwards
    const monthOrder = [
      "January",
      "February",
      "March",
      "April",
      "May",
      "June",
      "July",
      "August",
      "September",
      "October",
      "November",
      "December",
    ];

    const fromMonthIndex = monthOrder.indexOf(fromMonth);

    const futureSlips = await SalarySlip.find({ owner: ownerId })
      .populate("employee")
      .lean();

    const slipsToUpdate = futureSlips.filter((slip) => {
      const slipYear = parseInt(slip.year);
      const targetYear = parseInt(fromYear);
      const slipMonthIndex = monthOrder.indexOf(slip.month);

      // Include slips from the target month/year onwards
      return (
        slipYear > targetYear ||
        (slipYear === targetYear && slipMonthIndex >= fromMonthIndex)
      );
    });

    const results = [];

    for (const slipData of slipsToUpdate) {
      const slip = await SalarySlip.findById(slipData._id);
      if (!slip) continue;

      const calc = await calculateSlipWithTaxAsync(slip, taxCfg);

      // Update slip with tax calculations
      await writeEnc(slip, "grossSalary", calc.grossMonthly);
      await writeEnc(slip, "taxDeduction", calc.monthlyTax);
      await writeEnc(slip, "totalAllowances", calc.totalAllowances);
      await writeEnc(slip, "totalDeductions", calc.totalDeductions);
      await writeEnc(slip, "netPayable", calc.netPayable);
      await writeEnc(slip, "loanBenefits", calc.loanBenefits);

      await slip.save();

      results.push({
        slipId: slip._id.toString(),
        employee: String(slip.employee),
        month: slip.month,
        year: slip.year,
        taxApplied: calc.monthlyTax,
      });
    }

    // Mark this month as processed
    await TaxConfig.updateOne(
      { fiscalYear: taxCfg.fiscalYear },
      {
        $addToSet: {
          processedAutoTaxMonths: {
            month: fromMonth,
            year: fromYear,
          },
        },
      }
    );

    return results;
  } catch (err) {
    console.error("applyAutoTaxToFutureSlips error:", err);
    return [];
  }
}

/** Auto-apply tax to new slips if auto-tax is enabled */
exports.autoApplyTaxIfEnabled = async function (newSlip) {
  try {
    const taxCfg = await TaxConfig.findOne({
      fiscalYear: "2025-26",
      autoApplyEnabled: true,
      autoEnabledOwners: newSlip.owner,
    }).lean();

    if (!taxCfg) return;

    // Check if this slip is from the auto-apply month or later
    const monthOrder = [
      "January",
      "February",
      "March",
      "April",
      "May",
      "June",
      "July",
      "August",
      "September",
      "October",
      "November",
      "December",
    ];

    const slipMonthIndex = monthOrder.indexOf(newSlip.month);
    const slipYear = parseInt(newSlip.year);

    const autoFromMonthIndex = monthOrder.indexOf(
      taxCfg.autoApplyFromMonth.month
    );
    const autoFromYear = parseInt(taxCfg.autoApplyFromMonth.year);

    const shouldApplyTax =
      slipYear > autoFromYear ||
      (slipYear === autoFromYear && slipMonthIndex >= autoFromMonthIndex);

    if (!shouldApplyTax) {
      return;
    }

    const calc = await calculateSlipWithTaxAsync(newSlip, taxCfg);

    await writeEnc(newSlip, "grossSalary", calc.grossMonthly);
    await writeEnc(newSlip, "taxDeduction", calc.monthlyTax);
    await writeEnc(newSlip, "totalAllowances", calc.totalAllowances);
    await writeEnc(newSlip, "totalDeductions", calc.totalDeductions);
    await writeEnc(newSlip, "netPayable", calc.netPayable);
    await writeEnc(newSlip, "loanBenefits", calc.loanBenefits);

    await newSlip.save();

    console.log(
      `[tax] Auto-applied tax for new slip ${newSlip._id} (${newSlip.month} ${newSlip.year})`
    );
  } catch (err) {
    console.error("[tax] autoApplyTaxIfEnabled error:", err);
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
      await writeEnc(slip, "loanBenefits", calc.loanBenefits);

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

/** ✅ UPDATED enableTaxForOwner (added autoEnabledOwners save logic) */
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

      // Persist (encrypted) - INCLUDING LOAN BENEFITS
      await writeEnc(slip, "grossSalary", calc.grossMonthly);
      await writeEnc(slip, "taxDeduction", calc.monthlyTax);
      await writeEnc(slip, "totalAllowances", calc.totalAllowances);
      await writeEnc(slip, "totalDeductions", calc.totalDeductions);
      await writeEnc(slip, "netPayable", calc.netPayable);
      await writeEnc(slip, "loanBenefits", calc.loanBenefits);

      await slip.save();

      results.push({
        slipId: slip._id.toString(),
        employee: String(slip.employee),
        month: slip.month,
        year: slip.year,
        taxDeduction: calc.monthlyTax,
        netPayable: calc.netPayable,
        loanBenefits: calc.loanBenefits,
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
    await writeEnc(slip, "loanBenefits", calc.loanBenefits);

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
        totalDeductions =
          calc._debug.baseDeductionsMonthly + calc._debug.loanDeductionsMonthly;
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
        loanBenefits: calc.loanBenefits, // ADDED
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
          (await readEncNumberAsync(
            s?.loanDeductions?.vehicleLoan,
            "loanDeductions.vehicleLoan"
          )) +
          (await readEncNumberAsync(
            s?.loanDeductions?.otherLoans,
            "loanDeductions.otherLoans"
          )),
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

/** Test loan benefits calculation for an employee */
exports.testLoanBenefitsCalculation = async (req, res) => {
  try {
    const { employeeId, monthYear } = req.body;

    if (!employeeId || !monthYear) {
      return res
        .status(400)
        .json({ error: "Employee ID and monthYear are required" });
    }

    const scheduleBenefits = await calculateLoanBenefitsAsync(
      employeeId,
      monthYear
    );
    const markupBenefits = await calculateLoanBenefitsFromMarkupValue(
      employeeId,
      monthYear
    );

    return res.json({
      success: true,
      fromSchedule: scheduleBenefits,
      fromMarkup: markupBenefits,
      combined: {
        totalLoanBenefits:
          scheduleBenefits.totalLoanBenefits + markupBenefits.totalLoanBenefits,
        allDetails: [
          ...scheduleBenefits.loanDetails,
          ...markupBenefits.loanDetails,
        ],
      },
    });
  } catch (err) {
    console.error("testLoanBenefitsCalculation error:", err);
    return res
      .status(500)
      .json({ error: "Failed to test loan benefits calculation" });
  }
};

module.exports = exports;
