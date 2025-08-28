// controllers/taxController.js
// ────────────────────────────────────────────────────────────────
// BAND-ONLY tax (matches the sheet):
//   annualTax = fixed + (rateOver% * (A - (from - 1)))
//
// FINAL LOGIC:
//   1) grossMonthly = sum(all allowances)
//   2) Split deductions:
//        • baseDeductionsMonthly = all non-tax deductions EXCEPT loans
//          (includes leaveDeductions & lateDeductions).
//        • loanDeductionsMonthly = only loan fields.
//   3) netBeforeTax = grossMonthly - baseDeductionsMonthly
//   4) medical exemption (sheet-style) = round(netBeforeTax / 11), capped by netBeforeTax
//   5) taxableMonthly = netBeforeTax - medExemptMonthly
//   6) annualTaxable = taxableMonthly * 12
//   7) monthlyTax = round( annualTax(annualTaxable) / 12 )
//   8) totalDeductions = baseDeductionsMonthly + loanDeductionsMonthly + monthlyTax
//   9) netPayable = grossMonthly - totalDeductions
//   10) persist encrypted values
// ────────────────────────────────────────────────────────────────

const SalarySlip = require("../models/SalarySlip");
const TaxConfig   = require("../models/TaxConfig");
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

// Allowances → gross
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
];

// Loans → excluded from taxable base (but reduce final net)
const LOAN_DEDUCTION_KEYS = [
  "loanDeductions.vehicleLoan",
  "loanDeductions.otherLoans",
  "vehicleLoanDeduction",
  "otherLoanDeductions",
];

// Base deductions → included in taxable base (includes leave & late)
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
      from:  toNum(s.from),
      to:    s.to === undefined || s.to === null ? Infinity : toNum(s.to),
      fixed: toNum(s.fixed),
      rate:  toNum(s.rateOver) / 100,
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

/* ---------------------- slip calculation (async) ---------------------- */
async function calculateSlipWithTaxAsync(slip, taxCfg) {
  // 1) Gross monthly
  let grossMonthly = 0;
  for (const key of ALLOWANCE_KEYS) {
    grossMonthly += await readFirstNumAsync(slip, [key]);
  }

  const basic     = await readFirstNumAsync(slip, ["basic"]);
  const medMonthly = await readFirstNumAsync(slip, ["medicalAllowance"]); // (kept for debug)

  // 2) Split deductions
  let baseDeductionsMonthly = 0;
  for (const key of BASE_DEDUCTION_KEYS) {
    baseDeductionsMonthly += await readFirstNumAsync(slip, [key]);
  }

  let loanDeductionsMonthly = 0;
  for (const key of LOAN_DEDUCTION_KEYS) {
    loanDeductionsMonthly += await readFirstNumAsync(slip, [key]);
  }

  // 3) Net BEFORE income tax (EXCLUDES LOANS)
  const netBeforeTax = Math.max(0, grossMonthly - baseDeductionsMonthly);

  // 4) SHEET-STYLE medical exemption: use NET BEFORE TAX, not gross!
  //    This matches cases like "70000 - 12727" → annual 687,276, med = 687,276/11 /12.
  const medExemptMonthly = taxCfg?.enableMedicalExemption
    ? Math.min(netBeforeTax, Math.round(netBeforeTax / 11))
    : 0;

  // 5) Taxable monthly
  const taxableMonthly = Math.max(0, netBeforeTax - medExemptMonthly);

  // 6) Annualize + compute band-only tax
  const annualTaxable = taxableMonthly * 12;
  const annualTax     = computeAnnualTaxBandOnly(annualTaxable, taxCfg?.slabs || []);
  const monthlyTax    = Math.round(annualTax / 12);

  // 7) Final totals (loans still reduce net payable)
  const totalDeductions = baseDeductionsMonthly + loanDeductionsMonthly + monthlyTax;
  const netPayable      = Math.max(0, grossMonthly - totalDeductions);

  if (DEBUG_TAX) {
    console.log(
      `[tax] slip=${slip._id}` +
        ` basic=${basic.toLocaleString()}` +
        ` medM=${medMonthly.toLocaleString()}` +
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
    _debug: {
      baseDeductionsMonthly,
      loanDeductionsMonthly,
      netBeforeTax,
      taxableMonthly,
    },
  };
}

/* ---------------------------- controllers ---------------------------- */

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

      // Persist (encrypted)
      await writeEnc(slip, "grossSalary",     calc.grossMonthly);
      await writeEnc(slip, "taxDeduction",    calc.monthlyTax);
      await writeEnc(slip, "totalAllowances", calc.totalAllowances);
      await writeEnc(slip, "totalDeductions", calc.totalDeductions);
      await writeEnc(slip, "netPayable",      calc.netPayable);

      await slip.save();

      results.push({
        slipId: slip._id.toString(),
        employee: String(slip.employee),
        month: slip.month,
        year:  slip.year,
        taxDeduction: calc.monthlyTax,
        netPayable:   calc.netPayable,
      });
    }

    return res.json({ updated: results.length, slips: results });
  } catch (err) {
    console.error("enableTaxForOwner error:", err);
    return res.status(500).json({ error: "Failed to enable tax" });
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
        loanBenefits:
          (await readEncNumberAsync(s?.loanDeductions?.vehicleLoan, "loanDeductions.vehicleLoan")) +
          (await readEncNumberAsync(s?.loanDeductions?.otherLoans, "loanDeductions.otherLoans")),
        taxDeduction: await readEncNumberAsync(s.taxDeduction, "taxDeduction"),
        netPayable:   await readEncNumberAsync(s.netPayable, "netPayable"),
      }))
    );

    return res.json({ slips: data });
  } catch (err) {
    console.error("getOwnerSlipSummaries error:", err);
    return res.status(500).json({ error: "Failed to load slips" });
  }
};
