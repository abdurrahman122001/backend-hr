// routes/loans.js
const express = require("express");
const router = express.Router();
const { Types } = require("mongoose");

const Employee = require("../models/Employees");
const LoanDetail = require("../models/LoanDetail");
const SalarySlip = require("../models/SalarySlip");
const { encrypt, decrypt } = require("../utils/encryption");

// -----------------------------------------------------------------------------
// Constants / Helpers
// -----------------------------------------------------------------------------
const monthsList = [
  "January","February","March","April","May","June",
  "July","August","September","October","November","December",
];

function resolveOwnerId(user) {
  return user?.owner || user?.createdBy || user?._id || null;
}

function normMonth(m) {
  if (!m || typeof m !== "string") return "";
  const t = m.trim();
  return t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
}

async function setOtherLoanFields(slip, encryptedValue) {
  if (!slip.loanDeductions) slip.loanDeductions = {};
  slip.loanDeductions.otherLoans = encryptedValue;
  slip.markModified("loanDeductions");
}

// fields used for optional decryption output in GET endpoints
const sensitiveFields = ["loanAmount","monthlyInstallment","totalMarkup","totalToBePaid"];
const paymentScheduleSensitiveFields = ["principal","markupPercentage","markupAmount","totalPayment","outstanding","customAmount"];

const decryptWithKey = (req, _res, next) => {
  req.decryptionKey = req.query.key || req.headers["x-decryption-key"] || "";
  next();
};

// -----------------------------------------------------------------------------
// Core recompute logic
// -----------------------------------------------------------------------------

/**
 * Only deduct if a schedule row exists for that (month, year).
 * If no row exists => 0 (this fixes “deducting before start month”).
 * If row exists: prefer that row's totalPayment; if somehow missing, fall back to loan.monthlyInstallment.
 */
async function computeLoanMonthlyContribution(loan, month, yNum) {
  const sched = Array.isArray(loan.paymentSchedule)
    ? loan.paymentSchedule.find(
        (ps) => normMonth(ps.month) === month && Number(ps.year) === yNum
      )
    : null;

  // No schedule row for this month → do NOT deduct.
  if (!sched) return 0;

  if (sched.totalPayment) {
    const v = Number(await decrypt(sched.totalPayment));
    return Number.isFinite(v) ? v : 0;
  }

  if (loan.monthlyInstallment) {
    const v = Number(await decrypt(loan.monthlyInstallment));
    return Number.isFinite(v) ? v : 0;
  }

  return 0;
}

/**
 * Update a single salary slip for given (employee, month, year).
 */
async function recomputeSingleMonthOtherLoans(employeeId, monthName, yearNum, ownerId) {
  const month = normMonth(monthName);
  const yNum = Number(yearNum);
  if (!monthsList.includes(month) || !Number.isFinite(yNum)) return;

  const loans = await LoanDetail.find({ employee: employeeId }).lean();
  if (!loans.length) return;

  const slip = await SalarySlip.findOne({
    employee: employeeId,
    month,
    year: yNum.toString(),
    ...(ownerId && { owner: ownerId }),
  });
  if (!slip) return;

  let totalOtherLoans = 0;
  for (const loan of loans) {
    try {
      totalOtherLoans += await computeLoanMonthlyContribution(loan, month, yNum);
    } catch (e) {
      console.error(`Loan ${loan._id} compute error @ ${month} ${yNum}:`, e);
    }
  }

  const encrypted = await encrypt(String(totalOtherLoans || 0));
  await setOtherLoanFields(slip, encrypted);

  if (!slip.loanDeductions.vehicleLoan) {
    slip.loanDeductions.vehicleLoan = await encrypt("0");
  }
  if (!slip.gratuityFundDeduction) {
    slip.gratuityFundDeduction = await encrypt("0");
  }

  await slip.save();
}

/**
 * Recompute for ALL existing salary slips of an employee.
 * (Only months with schedule rows will add any deduction.)
 */
async function recomputeOtherLoansForExistingSlips(employeeId, ownerId) {
  const loans = await LoanDetail.find({ employee: employeeId }).lean();
  if (!loans.length) return;

  const slipQuery = { employee: employeeId };
  if (ownerId) slipQuery.owner = ownerId;

  const slips = await SalarySlip.find(slipQuery);
  if (!slips.length) return;

  for (const slip of slips) {
    const month = normMonth(slip.month);
    const yearNum = Number(String(slip.year));
    if (!monthsList.includes(month) || !Number.isFinite(yearNum)) continue;

    let totalOtherLoans = 0;
    for (const loan of loans) {
      try {
        totalOtherLoans += await computeLoanMonthlyContribution(loan, month, yearNum);
      } catch (e) {
        console.error(`Loan ${loan._id} compute error @ ${month} ${yearNum}:`, e);
      }
    }

    const encrypted = await encrypt(String(totalOtherLoans || 0));
    await setOtherLoanFields(slip, encrypted);

    if (!slip.loanDeductions.vehicleLoan) {
      slip.loanDeductions.vehicleLoan = await encrypt("0");
    }
    if (!slip.gratuityFundDeduction) {
      slip.gratuityFundDeduction = await encrypt("0");
    }

    await slip.save();
  }
}

// -----------------------------------------------------------------------------
// Payment schedule recalculation when editing an installment
// -----------------------------------------------------------------------------
async function recalculatePaymentSchedule(loan, updatedInstallmentIndex, newTotalPayment) {
  if (typeof newTotalPayment !== "number" || newTotalPayment < 0) {
    throw new Error("Invalid newTotalPayment value");
  }
  if (!loan.paymentSchedule || !Array.isArray(loan.paymentSchedule)) {
    throw new Error("Invalid payment schedule");
  }
  if (updatedInstallmentIndex < 0 || updatedInstallmentIndex >= loan.paymentSchedule.length) {
    throw new Error("Invalid installment index");
  }

  const decryptedLoanAmount = Number(await decrypt(loan.loanAmount)) || 0;
  let remainingPrincipal = decryptedLoanAmount;
  let totalMarkup = 0;
  const newSchedule = [];

  for (let i = 0; i < loan.paymentSchedule.length; i++) {
    const entry = loan.paymentSchedule[i];

    let principal = Number(await decrypt(entry.principal)) || 0;
    let markupAmount = Number(await decrypt(entry.markupAmount)) || 0;
    let totalPayment = Number(await decrypt(entry.totalPayment)) || 0;
    let outstanding = Number(await decrypt(entry.outstanding)) || 0;

    if (i < updatedInstallmentIndex) {
      remainingPrincipal -= principal;
      totalMarkup += markupAmount;
      newSchedule.push({ ...entry });
      continue;
    }

    if (i === updatedInstallmentIndex) {
      principal = newTotalPayment - markupAmount;
      if (principal < 0) throw new Error("Total payment cannot be less than markup amount");
      remainingPrincipal -= principal;
      totalPayment = newTotalPayment;
      outstanding = Math.max(0, remainingPrincipal);
      totalMarkup += markupAmount;

      newSchedule.push({
        ...entry,
        principal: await encrypt(principal.toString()),
        totalPayment: await encrypt(totalPayment.toString()),
        outstanding: await encrypt(outstanding.toString()),
      });
      continue;
    }

    const remainingInstallments = loan.paymentSchedule.length - i;
    if (remainingInstallments <= 0) break;

    const newPrincipal = remainingPrincipal / remainingInstallments;
    const newMarkupAmount = (newPrincipal * Number(loan.markupValue)) / 100;
    const futureTotalPayment = newPrincipal + newMarkupAmount;
    remainingPrincipal -= newPrincipal;
    totalMarkup += newMarkupAmount;

    newSchedule.push({
      ...entry,
      principal: await encrypt(newPrincipal.toString()),
      markupAmount: await encrypt(newMarkupAmount.toString()),
      totalPayment: await encrypt(futureTotalPayment.toString()),
      outstanding: await encrypt(Math.max(0, remainingPrincipal).toString()),
    });
  }

  return {
    paymentSchedule: newSchedule,
    totalMarkup: await encrypt(totalMarkup.toString()),
    totalToBePaid: await encrypt((decryptedLoanAmount + totalMarkup).toString()),
  };
}

// -----------------------------------------------------------------------------
// Routes
// -----------------------------------------------------------------------------

// Employees list (id + name)
router.get("/employees", async (_req, res) => {
  try {
    const employees = await Employee.find().select("_id name");
    res.json({ employees });
  } catch (err) {
    console.error("Error fetching employees:", err);
    res.status(500).json({ error: "Failed to fetch employees", details: err.message });
  }
});

// Fetch loans by employee (with optional decryption key for viewing)
router.get("/", decryptWithKey, async (req, res) => {
  try {
    const { employee } = req.query;
    if (!employee) return res.status(400).json({ error: "Employee ID is required" });
    if (!Types.ObjectId.isValid(employee)) return res.status(400).json({ error: "Invalid employee ID" });

    const loans = await LoanDetail.find({ employee }).lean();

    const decryptedLoans = await Promise.all(
      loans.map(async (loan) => {
        const out = { ...loan };
        const isUnlocked = !!req.decryptionKey;

        for (const field of sensitiveFields) {
          if (isUnlocked && loan[field]) {
            try {
              const dec = await decrypt(loan[field], req.decryptionKey);
              out[field] =
                dec !== "[Decryption Error]" && dec !== "[Wrong Key]" && dec !== "" && dec !== undefined
                  ? dec
                  : loan[field];
            } catch {
              out[field] = "[Decryption Error]";
            }
          }
        }

        if (loan.paymentSchedule && Array.isArray(loan.paymentSchedule)) {
          out.paymentSchedule = await Promise.all(
            loan.paymentSchedule.map(async (entry) => {
              const d = { ...entry };
              for (const f of paymentScheduleSensitiveFields) {
                if (isUnlocked && entry[f]) {
                  try {
                    const dec = await decrypt(entry[f], req.decryptionKey);
                    d[f] =
                      dec !== "[Decryption Error]" && dec !== "[Wrong Key]" && dec !== "" && dec !== undefined
                        ? dec
                        : entry[f];
                  } catch {
                    d[f] = "[Decryption Error]";
                  }
                }
              }
              return d;
            })
          );
        }

        return out;
      })
    );

    res.json({ loans: decryptedLoans });
  } catch (err) {
    console.error("Error fetching loans:", err);
    res.status(500).json({ error: "Failed to fetch loans", details: err.message });
  }
});

// Create/Update a loan
router.post("/loan/:employeeId", async (req, res) => {
  try {
    const { employeeId } = req.params;
    if (!Types.ObjectId.isValid(employeeId)) {
      return res.status(400).json({ error: "Invalid employee ID" });
    }

    const {
      type, loanAmount, loanTerm, markupType, markupValue,
      scheduleStartMonth, scheduleStartYear,
      monthlyInstallment, totalMarkup, totalToBePaid, paymentSchedule,
    } = req.body;

    const encryptedData = {
      loanAmount: await encrypt(loanAmount.toString()),
      monthlyInstallment: await encrypt(monthlyInstallment.toString()),
      totalMarkup: await encrypt(totalMarkup.toString()),
      totalToBePaid: await encrypt(totalToBePaid.toString()),
    };

    const encryptedPaymentSchedule = await Promise.all(
      (paymentSchedule || []).map(async (entry) => {
        const e = { ...entry };
        for (const f of paymentScheduleSensitiveFields) {
          if (entry[f] !== undefined && entry[f] !== null) {
            e[f] = await encrypt(entry[f].toString());
          }
        }
        return e;
      })
    );

    let loan = await LoanDetail.findOne({
      employee: employeeId,
      scheduleStartMonth,
      scheduleStartYear,
    });

    if (loan) {
      loan.type = type;
      loan.loanAmount = encryptedData.loanAmount;
      loan.loanTerm = loanTerm;
      loan.markupType = markupType;
      loan.markupValue = markupValue;
      loan.scheduleStartMonth = scheduleStartMonth;
      loan.scheduleStartYear = scheduleStartYear;
      loan.monthlyInstallment = encryptedData.monthlyInstallment;
      loan.totalMarkup = encryptedData.totalMarkup;
      loan.totalToBePaid = encryptedData.totalToBePaid;
      loan.paymentSchedule = encryptedPaymentSchedule;
      await loan.save();
    } else {
      loan = await LoanDetail.create({
        employee: employeeId,
        type,
        loanAmount: encryptedData.loanAmount,
        loanTerm,
        markupType,
        markupValue,
        scheduleStartMonth,
        scheduleStartYear,
        monthlyInstallment: encryptedData.monthlyInstallment,
        totalMarkup: encryptedData.totalMarkup,
        totalToBePaid: encryptedData.totalToBePaid,
        paymentSchedule: encryptedPaymentSchedule,
      });
    }

    // recompute for existing slips for this employee
    const ownerId = resolveOwnerId(req.user);
    await recomputeOtherLoansForExistingSlips(employeeId, ownerId);

    res.status(201).json(loan);
  } catch (err) {
    console.error("Error saving loan:", err);
    if (err.name === "ValidationError") {
      return res.status(400).json({
        error: "Invalid loan data",
        details: Object.values(err.errors).map((e) => e.message).join(", "),
      });
    }
    res.status(500).json({ error: "Failed to save loan", details: err.message });
  }
});

// Single loan detail (optional decryption for viewing)
router.get("/loan-detail/:loanId", decryptWithKey, async (req, res) => {
  try {
    const { loanId } = req.params;
    if (!Types.ObjectId.isValid(loanId)) {
      return res.status(400).json({ error: "Invalid loan ID" });
    }

    const loan = await LoanDetail.findById(loanId).populate("employee", "name").lean();
    if (!loan) return res.status(404).json({ error: "Loan not found" });

    const out = { ...loan };
    const isUnlocked = !!req.decryptionKey;

    for (const f of sensitiveFields) {
      if (isUnlocked && loan[f]) {
        try {
          const d = await decrypt(loan[f], req.decryptionKey);
          out[f] = d !== "[Decryption Error]" && d !== "[Wrong Key]" && d !== "" && d !== undefined ? d : loan[f];
        } catch {
          out[f] = "[Decryption Error]";
        }
      }
    }

    if (loan.paymentSchedule && Array.isArray(loan.paymentSchedule)) {
      out.paymentSchedule = await Promise.all(
        loan.paymentSchedule.map(async (entry) => {
          const d = { ...entry };
          for (const f of paymentScheduleSensitiveFields) {
            if (isUnlocked && entry[f]) {
              try {
                const val = await decrypt(entry[f], req.decryptionKey);
                d[f] = val !== "[Decryption Error]" && val !== "[Wrong Key]" && val !== "" && val !== undefined
                  ? val
                  : entry[f];
              } catch {
                d[f] = "[Decryption Error]";
              }
            }
          }
          return d;
        })
      );
    }

    res.json(out);
  } catch (err) {
    console.error("Error fetching loan:", err);
    res.status(500).json({ error: "Failed to fetch loan", details: err.message });
  }
});

// Delete a loan + recompute slips
router.delete("/loan/:loanId", async (req, res) => {
  try {
    const { loanId } = req.params;
    if (!Types.ObjectId.isValid(loanId)) {
      return res.status(400).json({ error: "Invalid loan ID" });
    }

    const loan = await LoanDetail.findById(loanId);
    if (!loan) return res.status(404).json({ error: "Loan not found" });

    const employeeId = loan.employee;
    await LoanDetail.deleteOne({ _id: loanId });

    const ownerId = resolveOwnerId(req.user);
    await recomputeOtherLoansForExistingSlips(employeeId, ownerId);

    res.json({ message: "Loan deleted successfully" });
  } catch (err) {
    console.error("Error deleting loan:", err);
    res.status(500).json({ error: "Failed to delete loan", details: err.message });
  }
});

// Loan benefits (kept consistent with schedule-first rule)
router.get("/loan-benefits/:employeeId", decryptWithKey, async (req, res) => {
  try {
    const { employeeId } = req.params;
    const { monthYear } = req.query;

    if (!monthYear) {
      return res.status(400).json({ error: "monthYear query parameter is required" });
    }

    const [monthName, yearStr] = String(monthYear).split(" ");
    const year = parseInt(yearStr, 10);
    if (!monthName || !yearStr || Number.isNaN(year)) {
      return res.status(400).json({ error: "Invalid monthYear format. Expected 'July 2025'" });
    }

    const loans = await LoanDetail.find({ employee: employeeId }).lean();
    const month = normMonth(monthName);

    const loanDetails = [];
    let totalLoanBenefits = 0;
    let totalLoanInstallments = 0;

    for (const loan of loans) {
      const entry = Array.isArray(loan.paymentSchedule)
        ? loan.paymentSchedule.find((ps) => normMonth(ps.month) === month && Number(ps.year) === year)
        : null;
      if (!entry) continue; // only count months that actually have a schedule row

      try {
        const markupAmount = entry.markupAmount
          ? parseFloat(await decrypt(entry.markupAmount, req.decryptionKey)) || 0
          : 0;

        let paymentAmount = 0;
        if (entry.totalPayment) {
          paymentAmount = parseFloat(await decrypt(entry.totalPayment, req.decryptionKey)) || 0;
        } else if (loan.monthlyInstallment) {
          paymentAmount = parseFloat(await decrypt(loan.monthlyInstallment, req.decryptionKey)) || 0;
        }

        const loanAmount = loan.loanAmount
          ? parseFloat(await decrypt(loan.loanAmount, req.decryptionKey)) || 0
          : 0;

        const totalMarkup = loan.totalMarkup
          ? parseFloat(await decrypt(loan.totalMarkup, req.decryptionKey)) || 0
          : 0;

        const totalToBePaid = loan.totalToBePaid
          ? parseFloat(await decrypt(loan.totalToBePaid, req.decryptionKey)) || 0
          : 0;

        loanDetails.push({
          type: loan.type || "Loan",
          monthlyInstallment: paymentAmount,
          paidPrev: 0,
          loanAmount,
          totalMarkup,
          totalToBePaid,
          markupAmount,
          markupValue: loan.markupValue || 0,
          markupType: loan.markupType || "fixed",
        });

        totalLoanBenefits += markupAmount;
        totalLoanInstallments += paymentAmount;
      } catch (e) {
        console.error(`Decryption failed for loan ${loan._id}:`, e);
      }
    }

    res.json({
      loanDetails,
      markupValue: loanDetails[0]?.markupValue || 0,
      totalLoanBenefits: Math.round(totalLoanBenefits),
      totalLoanInstallments,
    });
  } catch (err) {
    console.error("Error in loan-benefits:", err);
    res.status(500).json({ error: "Failed to calculate benefits", details: err.message });
  }
});

// Update one installment + recompute slips for changed months
router.patch("/loan/:loanId/installment/:installmentNo", async (req, res) => {
  try {
    const { loanId, installmentNo } = req.params;
    const { totalPayment } = req.body;

    if (!Types.ObjectId.isValid(loanId)) return res.status(400).json({ error: "Invalid loan ID" });
    if (!Number.isInteger(Number(installmentNo)) || Number(installmentNo) < 1)
      return res.status(400).json({ error: "Invalid installment number" });
    if (typeof totalPayment !== "number" || totalPayment < 0)
      return res.status(400).json({ error: "Invalid total payment amount" });

    const loan = await LoanDetail.findById(loanId);
    if (!loan) return res.status(404).json({ error: "Loan not found" });

    const idx = Number(installmentNo) - 1;
    if (!loan.paymentSchedule || idx >= loan.paymentSchedule.length)
      return res.status(400).json({ error: "Installment not found" });

    const { paymentSchedule, totalMarkup, totalToBePaid } =
      await recalculatePaymentSchedule(loan, idx, totalPayment);

    loan.paymentSchedule = paymentSchedule;
    loan.totalMarkup = totalMarkup;
    loan.totalToBePaid = totalToBePaid;
    await loan.save();

    const ownerId = resolveOwnerId(req.user);
    // Recompute affected months only (from edited row onward)
    const changed = new Set();
    for (let i = idx; i < loan.paymentSchedule.length; i++) {
      changed.add(`${loan.paymentSchedule[i].month}-${loan.paymentSchedule[i].year}`);
    }
    for (const key of changed) {
      const [m, y] = key.split("-");
      await recomputeSingleMonthOtherLoans(loan.employee, m, Number(y), ownerId);
    }

    res.json({ message: "Installment updated successfully", loan });
  } catch (err) {
    console.error("Error updating installment:", err);
    res.status(500).json({ error: "Failed to update installment", details: err.message });
  }
});

module.exports = router;
