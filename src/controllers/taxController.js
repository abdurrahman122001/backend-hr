const SalarySlip = require("../models/SalarySlip");
const TaxConfig = require("../models/TaxConfig");
const { encrypt, decrypt } = require("../utils/encryption");

/* ---------------- Helpers (encryption-safe IO) ---------------- */
const toNum = (v) => {
  if (v === null || v === undefined) return 0;
  if (typeof v === "number") return v;
  const cleaned = String(v).replace(/,/g, "").trim();
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
};
const toStr = (num) => Math.round(Number(num) || 0).toString();

const safeDecrypt = (enc) => {
  if (!enc) return "0";
  try {
    return decrypt(enc); // should return a numeric string
  } catch {
    return "0";
  }
};

const readNum = (slip, k) => toNum(safeDecrypt(slip?.[k]));
const readLoan = (slip, k) => toNum(safeDecrypt(slip?.loanDeductions?.[k]));

const writeEnc = async (slip, k, value) => {
  slip[k] = await encrypt(toStr(value));
};

/* ---------------- Tax math ---------------- */
function computeAnnualTaxFromSlabs(annualTaxable, slabs) {
  if (!slabs?.length) return 0;
  const A = Math.max(0, toNum(annualTaxable));

  for (const slab of slabs) {
    const lower = toNum(slab.from);
    const upper = (typeof slab.to === "number" && Number.isFinite(slab.to))
      ? slab.to
      : Infinity;

    if (A >= lower && A <= upper) {
      const fixed = toNum(slab.fixed);
      const rate = toNum(slab.rateOver) / 100;
      const base = lower <= 1 ? 0 : lower - 1; // matches common “over” anchor
      const over = Math.max(0, A - base);
      return fixed + over * rate;
    }
  }
  // in case A is above highest slab AND last slab has no upper bound
  const tail = slabs[slabs.length - 1];
  if (tail && (typeof tail.to !== "number" || !Number.isFinite(tail.to))) {
    const fixed = toNum(tail.fixed);
    const rate = toNum(tail.rateOver) / 100;
    const base = toNum(tail.from) <= 1 ? 0 : toNum(tail.from) - 1;
    const over = Math.max(0, A - base);
    return fixed + over * rate;
  }
  return 0;
}

function calculateSlipWithTax(slip, taxCfg) {
  // monthly earnings
  const basic = readNum(slip, "basic");
  const earnings =
    [
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
    ].reduce((s, key) => s + readNum(slip, key), 0);

  const grossMonthly = basic + earnings;

  // medical exemption (<= 10% of basic)
  const medMonthly = readNum(slip, "medicalAllowance");
  const medExemptMonthly = taxCfg?.enableMedicalExemption
    ? Math.min(medMonthly, basic * 0.10)
    : 0;

  // annualized figures
  const annualGross = grossMonthly * 12;
  const annualTaxable = Math.max(0, annualGross - medExemptMonthly * 12);

  // tax → monthly
  const annualTax = computeAnnualTaxFromSlabs(annualTaxable, taxCfg?.slabs || []);
  const monthlyTax = Math.round(annualTax / 12);

  // other deductions (monthly)
  const otherDeductions =
    [
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
    ].reduce((s, key) => s + readNum(slip, key), 0);

  // loan deductions (already monthly in your schema)
  const loanVehicle = readLoan(slip, "vehicleLoan");
  const loanOther = readLoan(slip, "otherLoans");

  const totalOtherDeductions = otherDeductions + loanVehicle + loanOther;

  // final monthly totals
  const totalDeductions = totalOtherDeductions + monthlyTax;
  const netPayable = grossMonthly - totalDeductions;

  return {
    grossMonthly,
    annualTaxable,
    annualTax,
    monthlyTax,              // <-- THIS is the monthly tax you expect to see
    totalAllowances: earnings,
    totalDeductions,
    netPayable,
  };
}

/* ---------------- Controllers ---------------- */

/**
 * POST /api/tax/enable
 * Auth: requireAuth (req.user._id)
 * Body: { fiscalYear?: string }
 * Effect: For all slips of this owner, recompute and SAVE encrypted monthly tax, totals, and net.
 */
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
      const calc = calculateSlipWithTax(slip, taxCfg);

      // persist (encrypted)
      await writeEnc(slip, "grossSalary",       calc.grossMonthly);
      await writeEnc(slip, "taxDeduction",      calc.monthlyTax);     // <-- monthly tax saved here
      await writeEnc(slip, "totalAllowances",   calc.totalAllowances);
      await writeEnc(slip, "totalDeductions",   calc.totalDeductions);
      await writeEnc(slip, "netPayable",        calc.netPayable);

      await slip.save();

      results.push({
        slipId: slip._id.toString(),
        employee: slip.employee?.toString?.() || String(slip.employee),
        month: slip.month,
        year: slip.year,
        taxDeduction: calc.monthlyTax,
        netPayable: calc.netPayable,
      });
    }

    return res.json({ updated: results.length, slips: results });
  } catch (err) {
    console.error("enableTaxForOwner error:", err);
    return res.status(500).json({ error: "Failed to enable tax" });
  }
};

/**
 * GET /api/tax/owner-slips
 * Returns decrypted summaries so the UI shows the **actual** numbers.
 */
exports.getOwnerSlipSummaries = async (req, res) => {
  try {
    const ownerId = req.user._id;

    const slips = await SalarySlip.find({ owner: ownerId })
      .select([
        "_id",
        "employee",
        "month",
        "year",
        "basic",
        "loanDeductions.vehicleLoan",
        "loanDeductions.otherLoans",
        "taxDeduction",
        "netPayable",
      ].join(" "));

    const data = slips.map((s) => ({
      slipId: s._id.toString(),
      employee: s.employee?.toString?.() || String(s.employee),
      month: s.month,
      year: s.year,
      basic: toNum(safeDecrypt(s.basic)),
      loanBenefits: toNum(safeDecrypt(s?.loanDeductions?.vehicleLoan)) + toNum(safeDecrypt(s?.loanDeductions?.otherLoans)),
      taxDeduction: toNum(safeDecrypt(s.taxDeduction)),  // <-- decrypted monthly tax
      netPayable: toNum(safeDecrypt(s.netPayable)),      // <-- decrypted net
    }));

    return res.json({ slips: data });
  } catch (err) {
    console.error("getOwnerSlipSummaries error:", err);
    return res.status(500).json({ error: "Failed to load slips" });
  }
};
