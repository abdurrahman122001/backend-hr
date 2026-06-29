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
const sensitiveFields = [
  "loanAmount",
  "monthlyInstallment",
  "totalMarkup",
  "totalToBePaid",
];
const paymentScheduleSensitiveFields = [
  "principal",
  "markupPercentage",
  "markupAmount",
  "totalPayment",
  "outstanding",
  "customAmount",
];

const decryptWithKey = (req, _res, next) => {
  req.decryptionKey = req.query.key || req.headers["x-decryption-key"] || "";
  next();
};

// -----------------------------------------------------------------------------
// Core recompute logic
// -----------------------------------------------------------------------------

/**
 * Only deduct if a schedule row exists for that (month, year).
 * If no row exists => 0 (this fixes "deducting before start month").
 * If row exists: prefer that row's totalPayment; if somehow missing, fall back to loan.monthlyInstallment.
 */
async function computeLoanMonthlyContribution(loan, month, yNum) {
  try {
    const sched = Array.isArray(loan.paymentSchedule)
      ? loan.paymentSchedule.find(
          (ps) => normMonth(ps.month) === month && Number(ps.year) === yNum,
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
  } catch (error) {
    console.error(
      `Error computing loan contribution for ${month} ${yNum}:`,
      error,
    );
    return 0;
  }
}

/**
 * Update a single salary slip for given (employee, month, year).
 * This is the MAIN function that updates salary slips when loans change.
 */
async function recomputeSingleMonthOtherLoans(
  employeeId,
  monthName,
  yearNum,
  ownerId,
) {
  try {
    const month = normMonth(monthName);
    const yNum = Number(yearNum);

    if (!monthsList.includes(month) || !Number.isFinite(yNum)) {
      console.error(`Invalid month or year: ${month}, ${yNum}`);
      return;
    }
    // Get ALL loans for this employee
    const loans = await LoanDetail.find({ employee: employeeId }).lean();
    // Find the salary slip for this month
    const slipQuery = {
      employee: employeeId,
      month,
      year: yNum.toString(),
    };
    if (ownerId) slipQuery.owner = ownerId;

    let slip = await SalarySlip.findOne(slipQuery);

    // If no slip exists for this month, we can't update it
    if (!slip) {
      return;
    }
    let totalOtherLoans = 0;

    // Calculate total loan deduction for this month
    for (const loan of loans) {
      try {
        let contribution = await computeLoanMonthlyContribution(
          loan,
          month,
          yNum,
        );

        // EXTRA LOGIC FOR LOAN ALLOWANCE:
        // If this loan is linked to an allowance field, we sync the deduction to that field's value
        if (loan.type === "Loan Allowance" && loan.loanAllowanceField && contribution > 0) {
          const allowanceValueEnc = slip[loan.loanAllowanceField];
          if (allowanceValueEnc) {
            const allowanceValue = Number(await decrypt(allowanceValueEnc)) || 0;
            // The deduction must match the allowance value per requirement
            contribution = allowanceValue;
          }
        }

        totalOtherLoans += contribution;
      } catch (e) {
        console.error(`Loan ${loan._id} compute error @ ${month} ${yNum}:`, e);
      }
    }

    // Encrypt and update the slip
    const encrypted = await encrypt(String(totalOtherLoans || 0));

    // Initialize loanDeductions if it doesn't exist
    if (!slip.loanDeductions) {
      slip.loanDeductions = {
        vehicleLoan: await encrypt("0"),
        otherLoans: encrypted,
      };
    } else {
      slip.loanDeductions.otherLoans = encrypted;
    }

    // Ensure other loan fields exist
    if (!slip.loanDeductions.vehicleLoan) {
      slip.loanDeductions.vehicleLoan = await encrypt("0");
    }

    if (!slip.gratuityFundDeduction) {
      slip.gratuityFundDeduction = await encrypt("0");
    }

    // Mark the field as modified
    slip.markModified("loanDeductions");

    // Recalculate net payable and total deductions
    // We should re-calc correctly by decrypting everything and re-summing
    // or at least applying the delta
    try {
      // It's safer to use the calcNet logic but here we only have the slip object
      // Let's at least update totalDeductions and netPayable if they exist
      if (slip.totalDeductions && slip.grossSalary) {
        // This part is tricky because slip might have other deductions too.
        // The most robust way is to re-calculate everything but that needs the lists.
        // For now, follow the existing pattern of updating netPayable.
        
        // We need to re-fetch/calculate the total deductions for a perfect update
        // but since we are specifically updating loanDeductions.otherLoans, 
        // we should ideally re-sum everything if possible.
      }
    } catch (e) {
      console.error("Error recalculating totals:", e);
    }

    await slip.save();
    return slip;
  } catch (error) {
    console.error(
      `Error in recomputeSingleMonthOtherLoans for ${monthName} ${yearNum}:`,
      error,
    );
    throw error;
  }
}

/**
 * Recompute for ALL existing salary slips of an employee.
 */
async function recomputeOtherLoansForExistingSlips(employeeId, ownerId) {
  try {
    const slipQuery = { employee: employeeId };
    if (ownerId) slipQuery.owner = ownerId;

    const slips = await SalarySlip.find(slipQuery);

    for (const slip of slips) {
      await recomputeSingleMonthOtherLoans(
        employeeId,
        slip.month,
        Number(slip.year),
        ownerId,
      );
    }
  } catch (error) {
    console.error(
      `Error in recomputeOtherLoansForExistingSlips for employee ${employeeId}:`,
      error,
    );
    throw error;
  }
}

async function removeAllLoanCalculationsFromSlips(employeeId, ownerId) {
  try {
    const slipQuery = { employee: employeeId };
    if (ownerId) slipQuery.owner = ownerId;

    const slips = await SalarySlip.find(slipQuery);

    for (const slip of slips) {
      slip.loanBenefits = await encrypt("0");

      if (slip.loanDeductions) {
        slip.loanDeductions.otherLoans = await encrypt("0");
        slip.loanDeductions.vehicleLoan = await encrypt("0");
        slip.markModified("loanDeductions");
      }

      slip.gratuityFundDeduction = await encrypt("0");

      // Recalculate totals if needed
      if (slip.totalDeductions && slip.grossSalary) {
        try {
          const totalDeductionsNum =
            Number(await decrypt(slip.totalDeductions)) || 0;
          const grossSalaryNum = Number(await decrypt(slip.grossSalary)) || 0;
          const oldLoanDeduction =
            Number(
              await decrypt(
                slip.loanDeductions?.otherLoans || (await encrypt("0")),
              ),
            ) || 0;
          const newTotalDeductions = totalDeductionsNum - oldLoanDeduction;

          slip.totalDeductions = await encrypt(String(newTotalDeductions));
          slip.netPayable = await encrypt(
            String(grossSalaryNum - newTotalDeductions),
          );
        } catch (e) {
          console.error("Error recalculating totals when removing loans:", e);
        }
      }

      await slip.save();
    }
  } catch (error) {
    console.error(
      `Error removing loan calculations for employee ${employeeId}:`,
      error,
    );
    throw error;
  }
}
async function recomputeAffectedSalarySlips(loan, ownerId, changedMonths = []) {
  try {
    const employeeId = loan.employee;
    // If specific months are provided, only recompute those
    if (changedMonths.length > 0) {
      for (const monthYear of changedMonths) {
        if (typeof monthYear === "string") {
          const [month, year] = monthYear.split("-");
          await recomputeSingleMonthOtherLoans(
            employeeId,
            month,
            Number(year),
            ownerId,
          );
        } else if (
          typeof monthYear === "object" &&
          monthYear.month &&
          monthYear.year
        ) {
          await recomputeSingleMonthOtherLoans(
            employeeId,
            monthYear.month,
            Number(monthYear.year),
            ownerId,
          );
        }
      }
    } else {
      await recomputeOtherLoansForExistingSlips(employeeId, ownerId);
    }
  } catch (error) {
    console.error(`Error in recomputeAffectedSalarySlips:`, error);
    throw error;
  }
}
async function recalculatePaymentSchedule(
  loan,
  updatedInstallmentIndex,
  updateData,
) {
  try {
    // Validate inputs
    if (!loan.paymentSchedule || !Array.isArray(loan.paymentSchedule)) {
      throw new Error("Invalid payment schedule");
    }

    if (
      updatedInstallmentIndex < 0 ||
      updatedInstallmentIndex >= loan.paymentSchedule.length
    ) {
      throw new Error("Invalid installment index");
    }

    const decryptedLoanAmount = Number(await decrypt(loan.loanAmount)) || 0;
    const yearlyRate = Number(loan.markupValue) || 0;
    const monthlyRate = yearlyRate / 100 / 12;
    const markupType = loan.markupType || "reducing";

    let remainingPrincipal = decryptedLoanAmount;
    let totalMarkup = 0;
    const newSchedule = [];
    const affectedMonths = [];

    // Copy and decrypt the existing schedule up to the updated row
    for (let i = 0; i < updatedInstallmentIndex; i++) {
      const entry = loan.paymentSchedule[i];

      const principal = Number(await decrypt(entry.principal)) || 0;
      const markupAmount = Number(await decrypt(entry.markupAmount)) || 0;
      const totalPayment = Number(await decrypt(entry.totalPayment)) || 0;

      remainingPrincipal -= principal;
      totalMarkup += markupAmount;

      // Keep the original entry but ensure it's properly formatted
      newSchedule.push({ ...entry });

      // Track all months in the schedule for recalculation
      if (entry.month && entry.year) {
        affectedMonths.push(`${entry.month}-${entry.year}`);
      }
    }

    // Handle the updated row based on what was changed
    const updatedEntry = loan.paymentSchedule[updatedInstallmentIndex];
    let principal, markupAmount, totalPayment, outstanding;
    let newMarkupPercentage = yearlyRate;

    if (updateData.principal !== undefined) {
      // Principal was edited
      principal = Math.max(0, Number(updateData.principal) || 0);

      if (markupType === "fixed") {
        // For fixed interest, markup is constant
        markupAmount = (decryptedLoanAmount * (yearlyRate / 100)) / 12;
      } else if (markupType === "reducing" || markupType === "interestOnly") {
        // For reducing/interestOnly, calculate interest on remaining balance
        markupAmount = remainingPrincipal * monthlyRate;
      } else if (markupType === "custom") {
        // Custom - no interest
        markupAmount = 0;
      }

      totalPayment = principal + markupAmount;
      remainingPrincipal -= principal;
      outstanding = Math.max(0, remainingPrincipal);
    } else if (updateData.markupPercentage !== undefined) {
      // Interest percentage was edited for this specific row
      newMarkupPercentage = Math.max(
        0,
        Number(updateData.markupPercentage) || 0,
      );
      const rowMonthlyRate = newMarkupPercentage / 100 / 12;

      principal = Number(await decrypt(updatedEntry.principal)) || 0;
      markupAmount = remainingPrincipal * rowMonthlyRate;
      totalPayment = principal + markupAmount;
      remainingPrincipal -= principal;
      outstanding = Math.max(0, remainingPrincipal);
    } else if (updateData.totalPayment !== undefined) {
      // Total payment was edited
      const newTotalPayment = Math.max(0, Number(updateData.totalPayment) || 0);

      if (markupType === "fixed") {
        markupAmount = (decryptedLoanAmount * (yearlyRate / 100)) / 12;
        principal = Math.max(0, newTotalPayment - markupAmount);
      } else if (markupType === "reducing" || markupType === "interestOnly") {
        markupAmount = remainingPrincipal * monthlyRate;
        principal = Math.max(0, newTotalPayment - markupAmount);
      } else if (markupType === "custom") {
        markupAmount = 0;
        principal = newTotalPayment;
      }

      totalPayment = newTotalPayment;
      remainingPrincipal -= principal;
      outstanding = Math.max(0, remainingPrincipal);
    } else if (updateData.customAmount !== undefined) {
      // Custom amount edited (for custom type)
      if (markupType !== "custom") {
        throw new Error(
          "Custom amount can only be updated for custom loan type",
        );
      }

      principal = Math.max(0, Number(updateData.customAmount) || 0);
      markupAmount = 0;
      totalPayment = principal;
      remainingPrincipal -= principal;
      outstanding = Math.max(0, remainingPrincipal);
    } else {
      throw new Error("No valid update data provided");
    }

    // Add the updated row
    const updatedRow = {
      ...updatedEntry,
      principal: await encrypt(principal.toString()),
      markupPercentage: await encrypt(newMarkupPercentage.toString()),
      markupAmount: await encrypt(markupAmount.toString()),
      totalPayment: await encrypt(totalPayment.toString()),
      outstanding: await encrypt(outstanding.toString()),
    };

    // Only add customAmount field for custom loan type
    if (markupType === "custom") {
      updatedRow.customAmount = await encrypt(principal.toString());
      updatedRow.note = "Custom Deduction";
    }

    newSchedule.push(updatedRow);
    totalMarkup += markupAmount;

    // Track the updated month for recalculation
    if (updatedEntry.month && updatedEntry.year) {
      affectedMonths.push(`${updatedEntry.month}-${updatedEntry.year}`);
    }

    // Check if we're updating the last installment and there's still outstanding balance
    const isUpdatingLastInstallment =
      updatedInstallmentIndex === loan.paymentSchedule.length - 1;
    const hasOutstandingBalance = remainingPrincipal > 0.01;

    // Calculate the new monthly installment amount for extending the schedule
    let newMonthlyInstallment = 0;
    if (updateData.totalPayment !== undefined) {
      newMonthlyInstallment = Number(updateData.totalPayment);
    } else if (
      updateData.principal !== undefined &&
      updateData.markupAmount !== undefined
    ) {
      newMonthlyInstallment =
        Number(updateData.principal) + Number(updateData.markupAmount);
    } else if (updateData.principal !== undefined) {
      newMonthlyInstallment = Number(updateData.principal) + markupAmount;
    } else {
      // Get from the updated row
      newMonthlyInstallment = totalPayment;
    }

    // Recalculate remaining rows
    const originalRemainingRows =
      loan.paymentSchedule.length - updatedInstallmentIndex - 1;

    // If updating last installment and there's outstanding balance, we need to extend the schedule
    const needsScheduleExtension =
      isUpdatingLastInstallment &&
      hasOutstandingBalance &&
      newMonthlyInstallment > 0;
    const totalRemainingRows = needsScheduleExtension
      ? Math.ceil(remainingPrincipal / newMonthlyInstallment)
      : originalRemainingRows;

    // Helper function to get month/year for a given installment index
    const getMonthYearForIndex = (installmentIndex) => {
      // Find the start month from the first entry in the schedule
      let scheduleStartMonth = 0; // Default to January
      let scheduleStartYear = new Date().getFullYear();

      if (loan.paymentSchedule && loan.paymentSchedule.length > 0) {
        const firstEntry = loan.paymentSchedule[0];
        if (firstEntry.month) {
          scheduleStartMonth = monthsList.indexOf(normMonth(firstEntry.month));
        }
        if (firstEntry.year) {
          scheduleStartYear = Number(firstEntry.year);
        }
      }

      // Calculate month and year for the given installment index (1-based)
      const totalMonthOffset = scheduleStartMonth + installmentIndex;
      const monthIndex = totalMonthOffset % 12;
      const year = scheduleStartYear + Math.floor(totalMonthOffset / 12);

      return {
        month: monthsList[monthIndex],
        year: year.toString(),
      };
    };

    for (let i = 1; i <= totalRemainingRows; i++) {
      const currentIndex = updatedInstallmentIndex + i;
      const installmentsLeft = totalRemainingRows - i + 1;

      let entry;
      let isExtendedMonth = false;

      // Check if this is an existing entry or a new extended month
      if (i <= originalRemainingRows) {
        // Use existing schedule entry
        entry = loan.paymentSchedule[currentIndex];
      } else {
        // Create new entry for extended month
        const { month, year } = getMonthYearForIndex(currentIndex);
        entry = {
          month,
          year,
          installmentNo: currentIndex + 1,
          // Copy other fields from the last existing entry if available
          ...(loan.paymentSchedule[loan.paymentSchedule.length - 1] || {}),
        };
        isExtendedMonth = true;

        // Remove any incorrect month/year that might have been copied
        delete entry.month;
        delete entry.year;
        entry.month = month;
        entry.year = year;
      }

      let newPrincipal, newMarkupAmount, newTotalPayment;

      if (markupType === "fixed") {
        const monthlyInterest = (decryptedLoanAmount * (yearlyRate / 100)) / 12;

        if (needsScheduleExtension && i === totalRemainingRows) {
          // Last extended payment - pay off remaining balance
          newPrincipal = remainingPrincipal;
          newMarkupAmount = monthlyInterest;
          newTotalPayment = newPrincipal + newMarkupAmount;
        } else {
          newPrincipal = remainingPrincipal / installmentsLeft;
          newMarkupAmount = monthlyInterest;
          newTotalPayment = newPrincipal + newMarkupAmount;
        }
      } else if (markupType === "reducing" || markupType === "interestOnly") {
        if (needsScheduleExtension && i === totalRemainingRows) {
          // Last extended payment - pay off remaining balance
          newPrincipal = remainingPrincipal;
          newMarkupAmount = remainingPrincipal * monthlyRate;
          newTotalPayment = newPrincipal + newMarkupAmount;
        } else {
          newPrincipal = remainingPrincipal / installmentsLeft;
          newMarkupAmount = remainingPrincipal * monthlyRate;
          newTotalPayment = newPrincipal + newMarkupAmount;
        }
      } else if (markupType === "custom") {
        if (needsScheduleExtension && i === totalRemainingRows) {
          // Last extended payment - pay off remaining balance
          newPrincipal = remainingPrincipal;
          newMarkupAmount = 0;
          newTotalPayment = newPrincipal;
        } else {
          newPrincipal = remainingPrincipal / installmentsLeft;
          newMarkupAmount = 0;
          newTotalPayment = newPrincipal;
        }
      }

      // Ensure we don't have negative principal and handle rounding
      newPrincipal = Math.max(0, newPrincipal);
      if (i === totalRemainingRows) {
        // For the last payment, ensure we pay off the exact remaining balance
        newPrincipal = Math.min(newPrincipal, remainingPrincipal);
      }

      remainingPrincipal -= newPrincipal;
      totalMarkup += newMarkupAmount;

      const newRow = {
        ...entry,
        installmentNo: currentIndex + 1,
        principal: await encrypt(newPrincipal.toString()),
        markupPercentage: await encrypt(yearlyRate.toString()),
        markupAmount: await encrypt(newMarkupAmount.toString()),
        totalPayment: await encrypt(newTotalPayment.toString()),
        outstanding: await encrypt(Math.max(0, remainingPrincipal).toString()),
      };

      // Only add customAmount field for custom loan type
      if (markupType === "custom") {
        newRow.customAmount = await encrypt(newPrincipal.toString());
        newRow.note = "Custom Deduction";
      }

      newSchedule.push(newRow);

      // Track affected months for recalculation
      if (newRow.month && newRow.year) {
        affectedMonths.push(`${newRow.month}-${newRow.year}`);
      }
    }

    // Handle any remaining balance due to rounding errors
    if (remainingPrincipal > 0.01 && newSchedule.length > 0) {
      const lastRow = newSchedule[newSchedule.length - 1];
      const lastPrincipal =
        Number(await decrypt(lastRow.principal)) + remainingPrincipal;
      const lastMarkupAmount =
        markupType === "custom" ? 0 : remainingPrincipal * monthlyRate;

      newSchedule[newSchedule.length - 1] = {
        ...lastRow,
        principal: await encrypt(lastPrincipal.toString()),
        markupAmount: await encrypt(lastMarkupAmount.toString()),
        totalPayment: await encrypt(
          (lastPrincipal + lastMarkupAmount).toString(),
        ),
        outstanding: await encrypt("0"),
      };

      totalMarkup += lastMarkupAmount;
      remainingPrincipal = 0;
    }

    return {
      paymentSchedule: newSchedule,
      totalMarkup: await encrypt(totalMarkup.toString()),
      totalToBePaid: await encrypt(
        (decryptedLoanAmount + totalMarkup).toString(),
      ),
      affectedMonths: Array.from(new Set(affectedMonths)), // Remove duplicates
      // Also return the new loan term if it changed
      newLoanTerm: newSchedule.length,
    };
  } catch (error) {
    console.error("Error in recalculatePaymentSchedule:", error);
    throw error;
  }
}
// -----------------------------------------------------------------------------
// Routes
// -----------------------------------------------------------------------------

// Employees list (id + name) for the logged-in owner's company
router.get("/employees", async (req, res) => {
  try {
    const ownerId = req.user?.owner || req.user?._id;
    const employees = await Employee.find({ owner: ownerId }).select("_id name");
    res.json({ employees });
  } catch (err) {
    console.error("Error fetching employees:", err);
    res
      .status(500)
      .json({ error: "Failed to fetch employees", details: err.message });
  }
});

// Fetch loans by employee (with optional decryption key for viewing)
router.get("/", decryptWithKey, async (req, res) => {
  try {
    const { employee } = req.query;
    if (!employee)
      return res.status(400).json({ error: "Employee ID is required" });
    if (!Types.ObjectId.isValid(employee))
      return res.status(400).json({ error: "Invalid employee ID" });

    const ownerId = req.user?.owner || req.user?._id;
    const emp = await Employee.findOne({ _id: employee, owner: ownerId });
    if (!emp) {
      return res.status(403).json({ error: "Access denied: Employee not found in your company" });
    }

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
                dec !== "[Decryption Error]" &&
                dec !== "[Wrong Key]" &&
                dec !== "" &&
                dec !== undefined
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
                      dec !== "[Decryption Error]" &&
                      dec !== "[Wrong Key]" &&
                      dec !== "" &&
                      dec !== undefined
                        ? dec
                        : entry[f];
                  } catch {
                    d[f] = "[Decryption Error]";
                  }
                }
              }
              return d;
            }),
          );
        }

        return out;
      }),
    );

    res.json({ loans: decryptedLoans });
  } catch (err) {
    console.error("Error fetching loans:", err);
    res
      .status(500)
      .json({ error: "Failed to fetch loans", details: err.message });
  }
});

// Create/Update a loan
router.post("/loan/:employeeId", async (req, res) => {
  try {
    const { employeeId } = req.params;
    if (!Types.ObjectId.isValid(employeeId)) {
      return res.status(400).json({ error: "Invalid employee ID" });
    }

    const ownerId = req.user?.owner || req.user?._id;
    const emp = await Employee.findOne({ _id: employeeId, owner: ownerId });
    if (!emp) {
      return res.status(403).json({ error: "Access denied: Employee not found in your company" });
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
      loanAllowanceField,
    } = req.body;

    // Encrypt sensitive data
    const encryptedData = {
      loanAmount: await encrypt(loanAmount.toString()),
      monthlyInstallment: await encrypt(monthlyInstallment.toString()),
      totalMarkup: await encrypt(totalMarkup.toString()),
      totalToBePaid: await encrypt(totalToBePaid.toString()),
    };

    // Encrypt payment schedule
    const encryptedPaymentSchedule = await Promise.all(
      (paymentSchedule || []).map(async (entry) => {
        const e = { ...entry };
        for (const f of paymentScheduleSensitiveFields) {
          if (entry[f] !== undefined && entry[f] !== null) {
            e[f] = await encrypt(entry[f].toString());
          }
        }
        return e;
      }),
    );

    // Always create a NEW loan record. Each loan is independent — a second loan
    // of the same type for the same employee must not overwrite the previous one.
    // (Edits to an existing loan go through the dedicated PATCH endpoints.)
    const loan = await LoanDetail.create({
      employee: employeeId,
      type,
      loanAllowanceField: type === "Loan Allowance" ? (loanAllowanceField || null) : null,
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

    // Recompute salary slips for this employee
    await recomputeOtherLoansForExistingSlips(employeeId, ownerId);

    res.status(201).json(loan);
  } catch (err) {
    console.error("Error saving loan:", err);
    if (err.name === "ValidationError") {
      return res.status(400).json({
        error: "Invalid loan data",
        details: Object.values(err.errors)
          .map((e) => e.message)
          .join(", "),
      });
    }
    res
      .status(500)
      .json({ error: "Failed to save loan", details: err.message });
  }
});

// Single loan detail (optional decryption for viewing)
router.get("/loan-detail/:loanId", decryptWithKey, async (req, res) => {
  try {
    const { loanId } = req.params;
    if (!Types.ObjectId.isValid(loanId)) {
      return res.status(400).json({ error: "Invalid loan ID" });
    }

    const loan = await LoanDetail.findById(loanId)
      .populate("employee", "name")
      .lean();
    if (!loan) return res.status(404).json({ error: "Loan not found" });

    const ownerId = req.user?.owner || req.user?._id;
    const emp = await Employee.findOne({ _id: loan.employee, owner: ownerId });
    if (!emp) {
      return res.status(403).json({ error: "Access denied" });
    }

    const out = { ...loan };
    const isUnlocked = !!req.decryptionKey;

    for (const f of sensitiveFields) {
      if (isUnlocked && loan[f]) {
        try {
          const d = await decrypt(loan[f], req.decryptionKey);
          out[f] =
            d !== "[Decryption Error]" &&
            d !== "[Wrong Key]" &&
            d !== "" &&
            d !== undefined
              ? d
              : loan[f];
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
                d[f] =
                  val !== "[Decryption Error]" &&
                  val !== "[Wrong Key]" &&
                  val !== "" &&
                  val !== undefined
                    ? val
                    : entry[f];
              } catch {
                d[f] = "[Decryption Error]";
              }
            }
          }
          return d;
        }),
      );
    }

    res.json(out);
  } catch (err) {
    console.error("Error fetching loan:", err);
    res
      .status(500)
      .json({ error: "Failed to fetch loan", details: err.message });
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

    const ownerId = req.user?.owner || req.user?._id;
    const emp = await Employee.findOne({ _id: loan.employee, owner: ownerId });
    if (!emp) {
      return res.status(403).json({ error: "Access denied" });
    }

    const employeeId = loan.employee;
    await LoanDetail.deleteOne({ _id: loanId });

    await recomputeOtherLoansForExistingSlips(employeeId, ownerId);

    res.json({ message: "Loan deleted and salary slips updated" });
  } catch (err) {
    console.error("Error deleting loan:", err);
    res
      .status(500)
      .json({ error: "Failed to delete loan", details: err.message });
  }
});

router.get("/loan-benefits/:employeeId", decryptWithKey, async (req, res) => {
  try {
    const { employeeId } = req.params;
    const { monthYear } = req.query;

    const ownerId = req.user?.owner || req.user?._id;
    const emp = await Employee.findOne({ _id: employeeId, owner: ownerId });
    if (!emp) {
      return res.status(403).json({ error: "Access denied: Employee not found in your company" });
    }

    if (!monthYear) {
      return res
        .status(400)
        .json({ error: "monthYear query parameter is required" });
    }

    const [monthName, yearStr] = String(monthYear).split(" ");
    const year = parseInt(yearStr, 10);

    if (!monthName || Number.isNaN(year)) {
      return res
        .status(400)
        .json({ error: "Invalid monthYear format. Expected 'July 2025'" });
    }

    const month = normMonth(monthName);
    const loans = await LoanDetail.find({ employee: employeeId }).lean();

    const loanDetails = [];
    let totalLoanBenefits = 0;
    let totalLoanInstallments = 0;
    let regularInstallments = 0;
    const allowanceLoans = []; // Loans of type "Loan Allowance"

    for (const loan of loans) {
      if (!Array.isArray(loan.paymentSchedule)) continue;

      // Find current month entry
      const currentEntry = loan.paymentSchedule.find(
        (ps) => normMonth(ps.month) === month && Number(ps.year) === year,
      );

      // Skip inactive loans
      if (!currentEntry) continue;

      try {
        /* ---------------- BASE VALUES ---------------- */
        const loanAmount = loan.loanAmount
          ? Number(await decrypt(loan.loanAmount, req.decryptionKey)) || 0
          : 0;

        const totalMarkup = loan.totalMarkup
          ? Number(await decrypt(loan.totalMarkup, req.decryptionKey)) || 0
          : 0;

        /* ---------------- CURRENT MONTH ---------------- */
        const currentMarkup = currentEntry.markupAmount
          ? Number(
              await decrypt(currentEntry.markupAmount, req.decryptionKey),
            ) || 0
          : 0;

        const currentMonthPayment = currentEntry.totalPayment
          ? Number(
              await decrypt(currentEntry.totalPayment, req.decryptionKey),
            ) || 0
          : loan.monthlyInstallment
            ? Number(
                await decrypt(loan.monthlyInstallment, req.decryptionKey),
              ) || 0
            : 0;

        /* ---------------- PREVIOUS MONTHS (PRINCIPAL ONLY) ---------------- */
        let previousMonthsPrincipal = 0;
        let previousMonthsMarkup = 0;

        for (const ps of loan.paymentSchedule) {
          const psYear = Number(ps.year);
          const psMonthIdx = monthsList.indexOf(normMonth(ps.month));
          const curMonthIdx = monthsList.indexOf(month);

          const isBefore =
            psYear < year || (psYear === year && psMonthIdx < curMonthIdx);

          if (!isBefore) continue;

          const principal = ps.principal
            ? Number(await decrypt(ps.principal, req.decryptionKey)) || 0
            : 0;

          const markup = ps.markupAmount
            ? Number(await decrypt(ps.markupAmount, req.decryptionKey)) || 0
            : 0;

          previousMonthsPrincipal += principal;
          previousMonthsMarkup += markup;
        }

        /* ---------------- BALANCES ---------------- */
        const currentMonthPrincipal = Math.max(
          0,
          currentMonthPayment - currentMarkup,
        );

        const principalPaidSoFar =
          previousMonthsPrincipal + currentMonthPrincipal;

        const principalBalance = Math.max(0, loanAmount - principalPaidSoFar);

        const markupPaidSoFar = previousMonthsMarkup + currentMarkup;

        const markupBalance = Math.max(0, totalMarkup - markupPaidSoFar);

        /* ---------------- PUSH RESULT ---------------- */
        const isAllowanceLoan = loan.type === "Loan Allowance" && loan.loanAllowanceField;

        loanDetails.push({
          type: loan.type || "Personal Loan",
          loanAllowanceField: loan.loanAllowanceField || null,
          isAllowanceLoan: !!isAllowanceLoan,

          // ✅ Current month includes MARKUP
          amountPaidCurrentMonth: currentMonthPayment,

          // ✅ Previous months = PRINCIPAL ONLY
          amountPaidPreviousMonths: previousMonthsPrincipal,

          balancePrincipal: principalBalance,
          balanceMarkup: markupBalance,

          // Net balance = PRINCIPAL ONLY
          netBalance: principalBalance,

          // Reference
          loanAmount,
          totalMarkup,
          markupAmount: currentMarkup,
          markupValue: loan.markupValue || 0,
          markupType: loan.markupType || "fixed",
          loanId: loan._id.toString(),
        });

        totalLoanBenefits += currentMarkup; // markup only
        totalLoanInstallments += currentMonthPayment;

        // Track allowance vs regular
        if (isAllowanceLoan) {
          allowanceLoans.push({
            field: loan.loanAllowanceField,
            installmentAmount: currentMonthPayment,
            markupAmount: currentMarkup,
            // Balance before this month's scheduled payment
            remainingBalance: Math.round(principalBalance + markupBalance + currentMonthPayment),
            loanId: loan._id.toString(),
          });
        } else {
          regularInstallments += currentMonthPayment;
        }
      } catch (e) {
        console.error(`Decryption failed for loan ${loan._id}:`, e);
      }
    }

    /* ---------------- RESPONSE ---------------- */
    res.json({
      loanDetails,
      totalLoanBenefits: Math.round(totalLoanBenefits),
      totalLoanInstallments: Math.round(totalLoanInstallments),
      regularInstallments: Math.round(regularInstallments),
      allowanceLoans,
      summary: {
        totalAmountPaidCurrentMonth: Math.round(totalLoanInstallments),
        totalAmountPaidPreviousMonths: Math.round(
          loanDetails.reduce((sum, l) => sum + l.amountPaidPreviousMonths, 0),
        ),
        totalBalancePrincipal: Math.round(
          loanDetails.reduce((sum, l) => sum + l.balancePrincipal, 0),
        ),
        totalBalanceMarkup: Math.round(
          loanDetails.reduce((sum, l) => sum + l.balanceMarkup, 0),
        ),
        totalNetBalance: Math.round(
          loanDetails.reduce((sum, l) => sum + l.netBalance, 0),
        ),
      },
    });
  } catch (err) {
    console.error("Error in loan-benefits:", err);
    res.status(500).json({
      error: "Failed to calculate benefits",
      details: err.message,
    });
  }
});

router.patch("/loan/:loanId/installment/:installmentNo", async (req, res) => {
  try {
    const { loanId, installmentNo } = req.params;
    const { principal, markupPercentage, totalPayment, customAmount } =
      req.body;

    if (!Types.ObjectId.isValid(loanId)) {
      return res.status(400).json({ error: "Invalid loan ID" });
    }

    const installmentIndex = Number(installmentNo) - 1;
    if (installmentIndex < 0) {
      return res.status(400).json({ error: "Invalid installment number" });
    }

    const loan = await LoanDetail.findById(loanId);
    if (!loan) {
      return res.status(404).json({ error: "Loan not found" });
    }

    const ownerId = req.user?.owner || req.user?._id;
    const emp = await Employee.findOne({ _id: loan.employee, owner: ownerId });
    if (!emp) {
      return res.status(403).json({ error: "Access denied: Employee not found in your company" });
    }

    if (
      !loan.paymentSchedule ||
      installmentIndex >= loan.paymentSchedule.length
    ) {
      return res.status(404).json({ error: "Installment not found" });
    }

    let updateData = {};
    let fieldUpdated = "";

    if (principal !== undefined) {
      updateData.principal = Number(principal);
      fieldUpdated = "principal";
    } else if (markupPercentage !== undefined) {
      updateData.markupPercentage = Number(markupPercentage);
      fieldUpdated = "markupPercentage";
    } else if (totalPayment !== undefined) {
      updateData.totalPayment = Number(totalPayment);
      fieldUpdated = "totalPayment";
    } else if (customAmount !== undefined) {
      updateData.customAmount = Number(customAmount);
      fieldUpdated = "customAmount";
    } else {
      return res.status(400).json({ error: "No valid field provided" });
    }

    const { paymentSchedule, totalMarkup, totalToBePaid, affectedMonths } =
      await recalculatePaymentSchedule(loan, installmentIndex, updateData);

    // Update the loan
    loan.paymentSchedule = paymentSchedule;
    loan.totalMarkup = totalMarkup;
    loan.totalToBePaid = totalToBePaid;
    await loan.save();

    // Recompute affected salary slips

    if (affectedMonths && affectedMonths.length > 0) {
      await recomputeAffectedSalarySlips(loan, ownerId, affectedMonths);
    } else {
      await recomputeOtherLoansForExistingSlips(loan.employee, ownerId);
    }

    return res.json({
      message: "Installment updated successfully",
      updatedField: fieldUpdated,
      loan: {
        _id: loan._id,
        paymentSchedule: loan.paymentSchedule,
        totalMarkup: loan.totalMarkup,
        totalToBePaid: loan.totalToBePaid,
      },
    });
  } catch (err) {
    console.error("Installment update error:", err);
    return res.status(500).json({
      error: "Failed to update installment",
      details: err.message,
    });
  }
});
// Apply a constant tail from `startIndex` (1-based installment no) onward
router.patch("/loan/:loanId/apply-tail", async (req, res) => {
  try {
    const { loanId } = req.params;
    const { startIndex, amount } = req.body;

    if (!Types.ObjectId.isValid(loanId)) {
      return res.status(400).json({ error: "Invalid loan ID" });
    }

    const startIdx0 = Number(startIndex) - 1; // convert to 0-based
    const newInstallment = Number(amount);

    if (!Number.isFinite(startIdx0) || startIdx0 < 0) {
      return res.status(400).json({ error: "Invalid startIndex" });
    }

    if (!Number.isFinite(newInstallment) || newInstallment <= 0) {
      return res.status(400).json({ error: "Invalid amount" });
    }

    const loan = await LoanDetail.findById(loanId);
    if (
      !loan ||
      !Array.isArray(loan.paymentSchedule) ||
      !loan.paymentSchedule.length
    ) {
      return res.status(404).json({ error: "Loan or schedule not found" });
    }

    const ownerId = req.user?.owner || req.user?._id;
    const emp = await Employee.findOne({ _id: loan.employee, owner: ownerId });
    if (!emp) {
      return res.status(403).json({ error: "Access denied: Employee not found in your company" });
    }

    if (startIdx0 >= loan.paymentSchedule.length) {
      return res.status(400).json({ error: "startIndex out of range" });
    }

    // Helper function to get month/year for index
    const monthYearForIndex = (i) => {
      const m0 = Number(loan.scheduleStartMonth) || 0;
      const y0 = Number(loan.scheduleStartYear) || new Date().getFullYear();
      const monthIdx = (m0 + i) % 12;
      const year = y0 + Math.floor((m0 + i) / 12);
      return { month: monthsList[monthIdx], year };
    };

    const P0 = Number(await decrypt(loan.loanAmount)) || 0;
    const yearly = Number(loan.markupValue) || 0;
    const r = yearly / 100 / 12;

    // Calculate principal already paid before the override point
    let principalPaidBefore = 0;
    for (let i = 0; i < startIdx0; i++) {
      principalPaidBefore +=
        Number(await decrypt(loan.paymentSchedule[i].principal)) || 0;
    }

    let outstanding = Math.max(0, P0 - principalPaidBefore);

    // Keep rows BEFORE the start index as-is
    const beforeRows = loan.paymentSchedule.slice(0, startIdx0);

    // Build the new tail - THIS IS THE FIXED PART
    const tail = [];
    const safeInstallment = Math.max(0.01, newInstallment);
    const fixedMonthlyInterest = (P0 * (yearly / 100)) / 12;

    let i = startIdx0;
    let guard = 0;
    const maxAdditionalMonths = 120; // Allow up to 10 years extension

    while (
      outstanding > 0.01 &&
      guard < loan.paymentSchedule.length + maxAdditionalMonths
    ) {
      const { month, year } = monthYearForIndex(i);
      let principalPay = 0;
      let interestAmt = 0;
      let totalPay = 0;

      if (loan.markupType === "reducing") {
        interestAmt = outstanding * r;

        // Check if this should be the final payment
        if (outstanding <= safeInstallment) {
          // Final payment - pay off remaining balance
          principalPay = outstanding;
          interestAmt = outstanding * r;
          totalPay = principalPay + interestAmt;
        } else {
          // Regular payment
          const M = Math.max(safeInstallment, interestAmt + 0.01);
          principalPay = M - interestAmt;
          totalPay = M;
        }
      } else if (loan.markupType === "fixed") {
        interestAmt = fixedMonthlyInterest;

        if (outstanding <= safeInstallment) {
          // Final payment
          principalPay = outstanding;
          totalPay = principalPay + interestAmt;
        } else {
          // Regular payment
          const M = Math.max(safeInstallment, interestAmt + 0.01);
          principalPay = M - interestAmt;
          totalPay = M;
        }
      } else if (loan.markupType === "interestOnly") {
        interestAmt = outstanding * r;

        if (outstanding <= safeInstallment) {
          // Final payment
          principalPay = outstanding;
          totalPay = principalPay + interestAmt;
        } else {
          // Regular payment - for interest-only, principal payment is optional
          // but we'll apply the safe installment minus interest
          const M = Math.max(safeInstallment, interestAmt + 0.01);
          principalPay = Math.min(outstanding, M - interestAmt);
          totalPay = principalPay + interestAmt;
        }
      } else {
        // custom: treat installment as pure principal
        if (outstanding <= safeInstallment) {
          principalPay = outstanding;
        } else {
          principalPay = safeInstallment;
        }
        interestAmt = 0;
        totalPay = principalPay;
      }

      // Ensure principal payment doesn't exceed outstanding
      principalPay = Math.min(principalPay, outstanding);
      totalPay = principalPay + interestAmt;

      // Update outstanding balance
      outstanding = Math.max(0, outstanding - principalPay);

      tail.push({
        // Use the original schedule entry if it exists, otherwise create new
        ...(loan.paymentSchedule[i] || {
          month,
          year,
          installmentNo: i + 1,
        }),
        installmentNo: i + 1,
        month,
        year,
        principal: await encrypt(String(principalPay)),
        markupPercentage: await encrypt(String(yearly)),
        markupAmount: await encrypt(String(interestAmt)),
        totalPayment: await encrypt(String(totalPay)),
        outstanding: await encrypt(String(outstanding)),
        // for custom:
        ...(loan.markupType === "custom"
          ? {
              customAmount: await encrypt(String(principalPay)),
              note: "Custom Deduction",
            }
          : {}),
      });

      i += 1;
      guard += 1;
    }

    // If there's still outstanding (due to rounding errors), add one more month to clear it
    if (outstanding > 0.01) {
      const lastEntry = tail[tail.length - 1];
      const finalPrincipal =
        Number(await decrypt(lastEntry.principal)) + outstanding;
      const finalInterest = loan.markupType === "custom" ? 0 : outstanding * r;

      tail[tail.length - 1] = {
        ...lastEntry,
        principal: await encrypt(String(finalPrincipal)),
        markupAmount: await encrypt(String(finalInterest)),
        totalPayment: await encrypt(String(finalPrincipal + finalInterest)),
        outstanding: await encrypt("0"),
      };
    }

    // Stitch new schedule and renumber
    const newSchedule = [...beforeRows, ...tail].map((row, idx) => ({
      ...row,
      installmentNo: idx + 1,
    }));

    // Recompute totals
    let totalMarkupNum = 0;
    for (const row of newSchedule) {
      totalMarkupNum += Number(await decrypt(row.markupAmount)) || 0;
    }

    // Update the loan
    loan.paymentSchedule = newSchedule;
    loan.loanTerm = newSchedule.length; // This now includes extended months
    loan.totalMarkup = await encrypt(String(totalMarkupNum));
    loan.totalToBePaid = await encrypt(String(P0 + totalMarkupNum));

    // Update monthly installment based on the new tail amount
    loan.monthlyInstallment = await encrypt(String(safeInstallment));

    await loan.save();

    // Recompute affected salary slips
    const changedMonths = newSchedule
      .slice(startIdx0)
      .map((r) => `${r.month}-${r.year}`);
    await recomputeAffectedSalarySlips(loan, ownerId, changedMonths);

    res.json({
      message: "Tail applied successfully",
      loan: {
        _id: loan._id,
        loanTerm: loan.loanTerm,
        paymentSchedule: loan.paymentSchedule,
        monthlyInstallment: loan.monthlyInstallment,
        totalMarkup: loan.totalMarkup,
        totalToBePaid: loan.totalToBePaid,
      },
    });
  } catch (err) {
    console.error("apply-tail error:", err);
    res
      .status(500)
      .json({ error: "Failed to apply tail", details: err.message });
  }
});

// -----------------------------------------------------------------------------
// Additional utility endpoint for manual slip recalculation
// -----------------------------------------------------------------------------

// Manual trigger to recalculate salary slips for an employee
router.post("/recalculate-slips/:employeeId", async (req, res) => {
  try {
    const { employeeId } = req.params;
    if (!Types.ObjectId.isValid(employeeId)) {
      return res.status(400).json({ error: "Invalid employee ID" });
    }

    const ownerId = req.user?.owner || req.user?._id;
    const emp = await Employee.findOne({ _id: employeeId, owner: ownerId });
    if (!emp) {
      return res.status(403).json({ error: "Access denied: Employee not found in your company" });
    }

    await recomputeOtherLoansForExistingSlips(employeeId, ownerId);

    res.json({
      message: "Salary slips recalculated successfully",
      employeeId,
    });
  } catch (err) {
    console.error("Error recalculating slips:", err);
    res
      .status(500)
      .json({ error: "Failed to recalculate slips", details: err.message });
  }
});

// Get affected months for a loan change
router.get("/affected-months/:loanId", async (req, res) => {
  try {
    const { loanId } = req.params;
    if (!Types.ObjectId.isValid(loanId)) {
      return res.status(400).json({ error: "Invalid loan ID" });
    }

    const loan = await LoanDetail.findById(loanId);
    if (!loan) return res.status(404).json({ error: "Loan not found" });

    const ownerId = req.user?.owner || req.user?._id;
    const emp = await Employee.findOne({ _id: loan.employee, owner: ownerId });
    if (!emp) {
      return res.status(403).json({ error: "Access denied" });
    }

    const affectedMonths = loan.paymentSchedule.map((ps) => ({
      month: ps.month,
      year: ps.year,
      installmentNo: ps.installmentNo,
    }));

    res.json({ affectedMonths });
  } catch (err) {
    console.error("Error getting affected months:", err);
    res
      .status(500)
      .json({ error: "Failed to get affected months", details: err.message });
  }
});

module.exports = router;
