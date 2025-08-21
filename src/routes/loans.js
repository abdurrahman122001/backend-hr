// backend/src/routes/loansRouter.js

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

// Resolve effective tenant/owner id for scoping
function resolveOwnerId(user) {
  return user?.owner || user?.createdBy || user?._id;
}

// Sensitive fields to encrypt/decrypt
const sensitiveFields = ["loanAmount","monthlyInstallment","totalMarkup","totalToBePaid"];

const paymentScheduleSensitiveFields = [
  "principal","markupPercentage","markupAmount","totalPayment","outstanding","customAmount",
];

// Middleware to handle decryption key (query or header)
const decryptWithKey = (req, res, next) => {
  req.decryptionKey = req.query.key || req.headers["x-decryption-key"] || "";
  next();
};

// -----------------------------------------------------------------------------
// CORE recompute: Update ONLY existing SalarySlips for this employee
// We fetch all slips for the employee (optionally owner-filtered) and, for each
// slip's (month, year), compute the month's total loan deductions and persist.
// This avoids missing updates when ownerId isn't available or doesn't match.
// -----------------------------------------------------------------------------
async function recomputeOtherLoansForExistingSlips(employeeId, ownerId) {
  const loans = await LoanDetail.find({ employee: employeeId }).lean();
  if (!loans.length) return;

  // Fetch existing slips for the employee (filter by owner if provided)
  const slipQuery = { employee: employeeId };
  if (ownerId) slipQuery.owner = ownerId;

  const slips = await SalarySlip.find(slipQuery);
  if (!slips.length) return;

  for (const slip of slips) {
    const monthName = slip.month;            // e.g., "July"
    const yearStr   = String(slip.year);     // ensure string for Number()
    const yearNum   = Number(yearStr);

    if (!monthsList.includes(monthName) || !Number.isFinite(yearNum)) {
      // Skip malformed slip (unexpected month/year)
      continue;
    }

    // Compute this slip's total for (monthName, yearNum)
    let totalOtherLoans = 0;

    for (const l of loans) {
      const sched = Array.isArray(l.paymentSchedule)
        ? l.paymentSchedule.find(ps => ps.month === monthName && Number(ps.year) === yearNum)
        : null;

      try {
        let contribution = 0;

        if (l.markupType === "custom") {
          if (sched?.totalPayment) {
            // custom schedule -> monthly totalPayment (includes benefit)
            const dec = await decrypt(sched.totalPayment);
            contribution = Number(dec) || 0;
          } else if (l.monthlyInstallment) {
            const dec = await decrypt(l.monthlyInstallment);
            contribution = Number(dec) || 0;
          }
        } else {
          // fixed/reducing/interest-only -> monthlyInstallment includes markup
          if (l.monthlyInstallment) {
            const dec = await decrypt(l.monthlyInstallment);
            contribution = Number(dec) || 0;
          }
        }

        if (Number.isFinite(contribution)) {
          totalOtherLoans += contribution;
        }
      } catch (e) {
        console.error(`Loan ${l._id} compute error @ ${monthName} ${yearNum}:`, e);
      }
    }

    // Persist to nested and legacy root fields for compatibility
    if (!slip.loanDeductions) slip.loanDeductions = {};
    slip.loanDeductions.otherLoans = await encrypt(String(totalOtherLoans));
    // legacy flat field some UIs read:
    slip.otherLoanDeductions = slip.loanDeductions.otherLoans;

    // default other related fields if missing (follow your prior pattern)
    if (!slip.loanDeductions.vehicleLoan) {
      slip.loanDeductions.vehicleLoan = await encrypt("0");
    }
    if (!slip.gratuityFundDeduction) {
      slip.gratuityFundDeduction = await encrypt("0");
    }

    // Ensure nested changes are tracked
    slip.markModified("loanDeductions");
    await slip.save();
  }
}
async function recalculatePaymentSchedule(loan, updatedInstallmentIndex, newTotalPayment) {
  const decryptedLoanAmount = Number(await decrypt(loan.loanAmount)) || 0;
  let remainingPrincipal = decryptedLoanAmount;
  let totalMarkup = 0;
  const newSchedule = [];

  // For all installments before the updated one, keep them as is
  for (let i = 0; i < loan.paymentSchedule.length; i++) {
    const entry = loan.paymentSchedule[i];
    let principal = Number(await decrypt(entry.principal)) || 0;
    let markupAmount = Number(await decrypt(entry.markupAmount)) || 0;
    let totalPayment = Number(await decrypt(entry.totalPayment)) || 0;
    let outstanding = Number(await decrypt(entry.outstanding)) || 0;

    if (i < updatedInstallmentIndex) {
      // Keep previous installments unchanged
      remainingPrincipal -= principal;
      totalMarkup += markupAmount;
      newSchedule.push({ ...entry });
      continue;
    }

    if (i === updatedInstallmentIndex) {
      // Use the new total payment
      principal = newTotalPayment - markupAmount; // Line 144, where the error occurs
      if (principal < 0) {
        throw new Error("Total payment cannot be less than markup amount");
      }
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

    // Recalculate future installments
    const remainingInstallments = loan.paymentSchedule.length - i;
    if (remainingInstallments <= 0) break;

    const newPrincipal = remainingPrincipal / remainingInstallments;
    const newMarkupAmount = (newPrincipal * Number(loan.markupValue)) / 100;
    const newTotalPayment = newPrincipal + newMarkupAmount; // Potential shadowing issue
    remainingPrincipal -= newPrincipal;
    totalMarkup += newMarkupAmount;

    newSchedule.push({
      ...entry,
      principal: await encrypt(newPrincipal.toString()),
      markupAmount: await encrypt(newMarkupAmount.toString()),
      totalPayment: await encrypt(newTotalPayment.toString()),
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

// 1) Get all employees (id+name)
router.get("/employees", async (req, res) => {
  try {
    const employees = await Employee.find().select("_id name");
    res.json({ employees });
  } catch (err) {
    console.error("Error fetching employees:", err);
    res.status(500).json({ error: "Failed to fetch employees", details: err.message });
  }
});
router.get("/", decryptWithKey, async (req, res) => {
  try {
    const { employee } = req.query;
    if (!employee) return res.status(400).json({ error: "Employee ID is required" });
    if (!Types.ObjectId.isValid(employee)) return res.status(400).json({ error: "Invalid employee ID" });

    const loans = await LoanDetail.find({ employee }).lean();

    const decryptedLoans = await Promise.all(
      loans.map(async (loan) => {
        const decryptedLoan = { ...loan };
        const isUnlocked = !!req.decryptionKey;

        // Decrypt sensitive fields
        for (const field of sensitiveFields) {
          if (isUnlocked && loan[field]) {
            try {
              const decryptedVal = await decrypt(loan[field], req.decryptionKey);
              decryptedLoan[field] =
                decryptedVal !== "[Decryption Error]" &&
                decryptedVal !== "[Wrong Key]" &&
                decryptedVal !== "" &&
                decryptedVal !== undefined
                  ? decryptedVal
                  : loan[field];
            } catch {
              decryptedLoan[field] = "[Decryption Error]";
            }
          }
        }

        // Decrypt payment schedule fields
        if (loan.paymentSchedule && Array.isArray(loan.paymentSchedule)) {
          decryptedLoan.paymentSchedule = await Promise.all(
            loan.paymentSchedule.map(async (entry) => {
              const decryptedEntry = { ...entry };
              for (const field of paymentScheduleSensitiveFields) {
                if (isUnlocked && entry[field]) {
                  try {
                    const decryptedVal = await decrypt(entry[field], req.decryptionKey);
                    decryptedEntry[field] =
                      decryptedVal !== "[Decryption Error]" &&
                      decryptedVal !== "[Wrong Key]" &&
                      decryptedVal !== "" &&
                      decryptedVal !== undefined
                        ? decryptedVal
                        : entry[field];
                  } catch {
                    decryptedEntry[field] = "[Decryption Error]";
                  }
                }
              }
              return decryptedEntry;
            })
          );
        }

        return decryptedLoan;
      })
    );

    res.json({ loans: decryptedLoans });
  } catch (err) {
    console.error("Error fetching loans:", err);
    res.status(500).json({ error: "Failed to fetch loans", details: err.message });
  }
});

// 3) Save or update a loan for one employee
router.post("/loan/:employeeId", async (req, res) => {
  try {
    const { employeeId } = req.params;
    if (!Types.ObjectId.isValid(employeeId)) {
      return res.status(400).json({ error: "Invalid employee ID" });
    }

    const {
      type,
      loanAmount,
      loanTerm,
      markupType,
      markupValue,
      scheduleStartMonth,
      scheduleStartYear,
      monthlyInstallment,
      totalMarkup,
      totalToBePaid,
      paymentSchedule,
    } = req.body;

    const encryptedData = {
      loanAmount: await encrypt(loanAmount.toString()),
      monthlyInstallment: await encrypt(monthlyInstallment.toString()),
      totalMarkup: await encrypt(totalMarkup.toString()),
      totalToBePaid: await encrypt(totalToBePaid.toString()),
    };

    const encryptedPaymentSchedule = await Promise.all(
      (paymentSchedule || []).map(async (entry) => {
        const encryptedEntry = { ...entry };
        for (const field of paymentScheduleSensitiveFields) {
          if (entry[field] !== undefined && entry[field] !== null) {
            encryptedEntry[field] = await encrypt(entry[field].toString());
          }
        }
        return encryptedEntry;
      })
    );

    let loan = await LoanDetail.findOne({
      employee: employeeId,
      scheduleStartMonth,
      scheduleStartYear,
    });

    if (loan) {
      // Update existing
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
      // Create new
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

    // Recompute across existing slips (owner-scoped if available)
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

// 4) Get single loan detail (optionally decrypted)
router.get("/loan-detail/:loanId", decryptWithKey, async (req, res) => {
  try {
    const { loanId } = req.params;
    if (!Types.ObjectId.isValid(loanId)) {
      return res.status(400).json({ error: "Invalid loan ID" });
    }
    const loan = await LoanDetail.findById(loanId).populate("employee", "name").lean();
    if (!loan) {
      return res.status(404).json({ error: "Loan not found" });
    }

    const decryptedLoan = { ...loan };
    const isUnlocked = !!req.decryptionKey;

    // Decrypt sensitive fields
    for (const field of sensitiveFields) {
      if (isUnlocked && loan[field]) {
        try {
          const decryptedVal = await decrypt(loan[field], req.decryptionKey);
          decryptedLoan[field] =
            decryptedVal !== "[Decryption Error]" &&
            decryptedVal !== "[Wrong Key]" &&
            decryptedVal !== "" &&
            decryptedVal !== undefined
              ? decryptedVal
              : loan[field];
        } catch {
          decryptedLoan[field] = "[Decryption Error]";
        }
      }
    }

    // Decrypt payment schedule fields
    if (loan.paymentSchedule && Array.isArray(loan.paymentSchedule)) {
      decryptedLoan.paymentSchedule = await Promise.all(
        loan.paymentSchedule.map(async (entry) => {
          const decryptedEntry = { ...entry };
          for (const field of paymentScheduleSensitiveFields) {
            if (isUnlocked && entry[field]) {
              try {
                const decryptedVal = await decrypt(entry[field], req.decryptionKey);
                decryptedEntry[field] =
                  decryptedVal !== "[Decryption Error]" &&
                  decryptedVal !== "[Wrong Key]" &&
                  decryptedVal !== "" &&
                  decryptedVal !== undefined
                    ? decryptedVal
                    : entry[field];
              } catch {
                decryptedEntry[field] = "[Decryption Error]";
              }
            }
          }
          return decryptedEntry;
        })
      );
    }

    res.json(decryptedLoan);
  } catch (err) {
    console.error("Error fetching loan:", err);
    res.status(500).json({ error: "Failed to fetch loan", details: err.message });
  }
});

// 5) Delete a loan
router.delete("/loan/:loanId", async (req, res) => {
  try {
    const { loanId } = req.params;
    if (!Types.ObjectId.isValid(loanId)) {
      return res.status(400).json({ error: "Invalid loan ID" });
    }

    const loan = await LoanDetail.findById(loanId);
    if (!loan) {
      return res.status(404).json({ error: "Loan not found" });
    }

    const employeeId = loan.employee;

    await LoanDetail.deleteOne({ _id: loanId });

    // Recompute after deletion (only existing slips), owner-scoped if available
    const ownerId = resolveOwnerId(req.user);
    await recomputeOtherLoansForExistingSlips(employeeId, ownerId);

    res.json({ message: "Loan deleted successfully" });
  } catch (err) {
    console.error("Error deleting loan:", err);
    res.status(500).json({ error: "Failed to delete loan", details: err.message });
  }
});

// 6) Loan benefits (calculation for a given month/year)
router.get("/loan-benefits/:employeeId", decryptWithKey, async (req, res) => {
  try {
    const { employeeId } = req.params;
    const { monthYear } = req.query;

    if (!monthYear) {
      return res.status(400).json({ error: "monthYear query parameter is required" });
    }

    // Example format: "July 2025"
    const [monthName, yearStr] = monthYear.split(" ");
    const year = parseInt(yearStr, 10);

    if (!monthName || !yearStr || Number.isNaN(year)) {
      return res.status(400).json({
        error: "Invalid monthYear format. Expected format like 'July 2025'",
      });
    }

    const loans = await LoanDetail.find({ employee: employeeId }).lean();

    const loanDetails = [];
    let totalLoanBenefits = 0;
    let totalLoanInstallments = 0;

    for (const loan of loans) {
      if (!loan.paymentSchedule || !Array.isArray(loan.paymentSchedule)) continue;

      const entry = loan.paymentSchedule.find(
        (ps) => ps.month === monthName && Number(ps.year) === year
      );
      if (!entry) continue;

      try {
        const markupAmount = entry.markupAmount
          ? parseFloat(await decrypt(entry.markupAmount, req.decryptionKey)) || 0
          : 0;

        const monthlyInstallment = loan.monthlyInstallment
          ? parseFloat(await decrypt(loan.monthlyInstallment, req.decryptionKey)) || 0
          : 0;

        let paymentAmount = monthlyInstallment;
        if (loan.markupType === "custom" && entry.totalPayment) {
          paymentAmount = parseFloat(await decrypt(entry.totalPayment, req.decryptionKey)) || 0;
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
        continue;
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
    res.status(500).json({
      error: "Failed to calculate benefits",
      details: err.message,
      stack: process.env.NODE_ENV === "development" ? err.stack : undefined,
    });
  }
});

// 7) Update a specific installment in a loan's payment schedule
router.patch("/loan/:loanId/installment/:installmentNo", async (req, res) => {
  try {
    const { loanId, installmentNo } = req.params;
    const { totalPayment } = req.body;

    if (!Types.ObjectId.isValid(loanId)) {
      return res.status(400).json({ error: "Invalid loan ID" });
    }
    if (!Number.isInteger(Number(installmentNo)) || Number(installmentNo) < 1) {
      return res.status(400).json({ error: "Invalid installment number" });
    }
    if (typeof totalPayment !== "number" || totalPayment < 0) {
      return res.status(400).json({ error: "Invalid total payment amount" });
    }

    const loan = await LoanDetail.findById(loanId);
    if (!loan) {
      return res.status(404).json({ error: "Loan not found" });
    }

    const installmentIndex = Number(installmentNo) - 1;
    if (!loan.paymentSchedule || installmentIndex >= loan.paymentSchedule.length) {
      return res.status(400).json({ error: "Installment not found" });
    }

    // Recalculate the payment schedule
    const { paymentSchedule, totalMarkup, totalToBePaid } = await recalculatePaymentSchedule(
      loan,
      installmentIndex,
      totalPayment
    );

    // Update the loan with the new schedule and totals
    loan.paymentSchedule = paymentSchedule;
    loan.totalMarkup = totalMarkup;
    loan.totalToBePaid = totalToBePaid;
    await loan.save();

    // Recompute salary slips
    const ownerId = resolveOwnerId(req.user);
    await recomputeOtherLoansForExistingSlips(loan.employee, ownerId);

    res.json({ message: "Installment updated successfully", loan });
  } catch (err) {
    console.error("Error updating installment:", err);
    res.status(500).json({ error: "Failed to update installment", details: err.message });
  }
});

module.exports = router;