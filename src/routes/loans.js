const express = require("express");
const router = express.Router();
const { Types } = require("mongoose");

const Employee = require("../models/Employees");
const LoanDetail = require("../models/LoanDetail");
const SalarySlip = require("../models/SalarySlip");
const { encrypt, decrypt } = require("../utils/encryption");

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

// Helper: Get month start/end as Date objects (works with monthIndex: 0-11)
function getMonthDateRange(year, monthIndex) {
  if (typeof monthIndex !== "number" || monthIndex < 0 || monthIndex > 11) {
    console.warn(
      `Invalid month index: ${monthIndex}. Defaulting to current month.`
    );
    const currentDate = new Date();
    monthIndex = currentDate.getMonth();
    year = currentDate.getFullYear();
  }
  const start = new Date(year, monthIndex, 1, 0, 0, 0, 0);
  const end = new Date(year, monthIndex + 1, 0, 23, 59, 59, 999);
  return { start, end };
}

// Sensitive fields to encrypt/decrypt
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

// Middleware to handle decryption key
const decryptWithKey = (req, res, next) => {
  req.decryptionKey = req.query.key || req.headers["x-decryption-key"] || "";
  next();
};

// 1. Get all employees
router.get("/employees", async (req, res) => {
  try {
    const employees = await Employee.find().select("_id name");
    res.json({ employees });
  } catch (err) {
    console.error("Error fetching employees:", err);
    res
      .status(500)
      .json({ error: "Failed to fetch employees", details: err.message });
  }
});

// 2. Get all loan details for one employee
router.get("/", decryptWithKey, async (req, res) => {
  try {
    const { employee } = req.query;
    if (!employee) {
      return res.status(400).json({ error: "Employee ID is required" });
    }
    if (!Types.ObjectId.isValid(employee)) {
      return res.status(400).json({ error: "Invalid employee ID" });
    }

    const loans = await LoanDetail.find({ employee }).lean();

    const decryptedLoans = await Promise.all(
      loans.map(async (loan) => {
        const decryptedLoan = { ...loan };
        const isUnlocked = !!req.decryptionKey;

        // Decrypt sensitive fields
        for (const field of sensitiveFields) {
          if (isUnlocked && loan[field]) {
            try {
              const decrypted = await decrypt(loan[field], req.decryptionKey);
              decryptedLoan[field] =
                decrypted !== "[Decryption Error]" &&
                decrypted !== "[Wrong Key]" &&
                decrypted !== "" &&
                decrypted !== undefined
                  ? decrypted
                  : loan[field];
            } catch (e) {
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
                    const decrypted = await decrypt(
                      entry[field],
                      req.decryptionKey
                    );
                    decryptedEntry[field] =
                      decrypted !== "[Decryption Error]" &&
                      decrypted !== "[Wrong Key]" &&
                      decrypted !== "" &&
                      decrypted !== undefined
                        ? decrypted
                        : entry[field];
                  } catch (e) {
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
    res
      .status(500)
      .json({ error: "Failed to fetch loans", details: err.message });
  }
});

// 3. Save or update loan detail for one employee
// 3. Save or update loan detail for one employee
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

    // ... (previous validation code remains the same)

    const encryptedData = {
      loanAmount: await encrypt(loanAmount.toString()),
      monthlyInstallment: await encrypt(monthlyInstallment.toString()),
      totalMarkup: await encrypt(totalMarkup.toString()),
      totalToBePaid: await encrypt(totalToBePaid.toString()),
    };

    const encryptedPaymentSchedule = await Promise.all(
      paymentSchedule.map(async (entry) => {
        const encryptedEntry = { ...entry };
        for (const field of paymentScheduleSensitiveFields) {
          if (entry[field] !== undefined) {
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
      // Update existing loan
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
      // Create new loan
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

    // Update Salary Slip loan deduction with actual loan + interest
    const { start, end } = getMonthDateRange(
      scheduleStartYear,
      scheduleStartMonth
    );
    const salarySlip = await SalarySlip.findOne({
      employee: employeeId,
      updatedAt: { $gte: start, $lte: end },
    });

    if (salarySlip) {
      const allLoans = await LoanDetail.find({
        employee: employeeId,
        scheduleStartMonth,
        scheduleStartYear,
      });

      let totalOtherLoans = 0;

      for (const l of allLoans) {
        try {
          // For custom loans, get the first payment's totalPayment
          if (l.markupType === 'custom' && l.paymentSchedule && l.paymentSchedule.length > 0) {
            const firstPayment = l.paymentSchedule[0];
            if (firstPayment.totalPayment) {
              const decrypted = await decrypt(firstPayment.totalPayment);
              totalOtherLoans += Number(decrypted || 0);
              continue;
            }
          }
          
          // For non-custom loans, use monthlyInstallment
          const decrypted = await decrypt(l.monthlyInstallment);
          totalOtherLoans += Number(decrypted || 0);
        } catch (e) {
          console.error(`Error decrypting loan ${l._id}:`, e);
        }
      }

      if (!salarySlip.loanDeductions) {
        salarySlip.loanDeductions = {};
      }
      salarySlip.loanDeductions.otherLoans = await encrypt(
        totalOtherLoans.toString()
      );
      salarySlip.loanDeductions.vehicleLoan = await encrypt("0");
      salarySlip.gratuityFundDeduction = await encrypt("0");
      await salarySlip.save();
    }

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
// 4. Get single loan detail
router.get("/loan-detail/:loanId", decryptWithKey, async (req, res) => {
  try {
    const { loanId } = req.params;
    if (!Types.ObjectId.isValid(loanId)) {
      return res.status(400).json({ error: "Invalid loan ID" });
    }
    const loan = await LoanDetail.findById(loanId)
      .populate("employee", "name")
      .lean();
    if (!loan) {
      return res.status(404).json({ error: "Loan not found" });
    }

    const decryptedLoan = { ...loan };
    const isUnlocked = !!req.decryptionKey;

    // Decrypt sensitive fields
    for (const field of sensitiveFields) {
      if (isUnlocked && loan[field]) {
        try {
          const decrypted = await decrypt(loan[field], req.decryptionKey);
          decryptedLoan[field] =
            decrypted !== "[Decryption Error]" &&
            decrypted !== "[Wrong Key]" &&
            decrypted !== "" &&
            decrypted !== undefined
              ? decrypted
              : loan[field];
        } catch (e) {
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
                const decrypted = await decrypt(
                  entry[field],
                  req.decryptionKey
                );
                decryptedEntry[field] =
                  decrypted !== "[Decryption Error]" &&
                  decrypted !== "[Wrong Key]" &&
                  decrypted !== "" &&
                  decrypted !== undefined
                    ? decrypted
                    : entry[field];
              } catch (e) {
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
    res
      .status(500)
      .json({ error: "Failed to fetch loan", details: err.message });
  }
});

// 5. Delete a loan
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

    const { employee, scheduleStartMonth, scheduleStartYear } = loan;

    const { start, end } = getMonthDateRange(
      scheduleStartYear,
      scheduleStartMonth
    );
    const salarySlip = await SalarySlip.findOne({
      employee,
      updatedAt: { $gte: start, $lte: end },
    });

    if (salarySlip) {
      const remainingLoans = await LoanDetail.find({
        employee,
        _id: { $ne: loanId },
        scheduleStartMonth,
        scheduleStartYear,
      });

      const totalOtherLoans = (
        await Promise.all(
          remainingLoans.map(async (l) => {
            try {
              return Number((await decrypt(l.monthlyInstallment)) || 0);
            } catch (e) {
              return 0;
            }
          })
        )
      ).reduce((sum, val) => sum + val, 0);

      if (!salarySlip.loanDeductions) {
        salarySlip.loanDeductions = {};
      }
      salarySlip.loanDeductions.otherLoans = await encrypt(
        totalOtherLoans.toString()
      );
      salarySlip.loanDeductions.vehicleLoan = await encrypt("0");
      salarySlip.gratuityFundDeduction = await encrypt("0");
      await salarySlip.save();
    }

    await LoanDetail.deleteOne({ _id: loanId });

    res.json({ message: "Loan deleted successfully" });
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
    
    if (!monthYear) {
      return res.status(400).json({ error: "monthYear query parameter is required" });
    }

    // Extract month and year from query (e.g. "July 2025")
    const [monthName, yearStr] = monthYear.split(' ');
    const year = parseInt(yearStr);

    if (!monthName || !yearStr || isNaN(year)) {
      return res.status(400).json({ error: "Invalid monthYear format. Expected format like 'July 2025'" });
    }

    // Find all loans for this employee
    const loans = await LoanDetail.find({ employee: employeeId }).lean();

    // Process each loan's payment schedule
    const loanDetails = [];
    let totalLoanBenefits = 0;
    let totalLoanInstallments = 0;

    for (const loan of loans) {
      if (!loan.paymentSchedule || !Array.isArray(loan.paymentSchedule)) continue;

      // Find the matching schedule entry
      const entry = loan.paymentSchedule.find(
        ps => ps.month === monthName && ps.year === year
      );

      if (!entry) continue;

      try {
        // Decrypt the relevant amounts
        const markupAmount = entry.markupAmount 
          ? parseFloat(await decrypt(entry.markupAmount, req.decryptionKey)) || 0
          : 0;

        const monthlyInstallment = loan.monthlyInstallment
          ? parseFloat(await decrypt(loan.monthlyInstallment, req.decryptionKey)) || 0
          : 0;

        const loanAmount = loan.loanAmount
          ? parseFloat(await decrypt(loan.loanAmount, req.decryptionKey)) || 0
          : 0;

        const totalMarkup = loan.totalMarkup
          ? parseFloat(await decrypt(loan.totalMarkup, req.decryptionKey)) || 0
          : 0;

        const totalToBePaid = loan.totalToBePaid
          ? parseFloat(await decrypt(loan.totalToBePaid, req.decryptionKey)) || 0
          : 0;

        // For custom loans, we should use the totalPayment from the schedule if available
        let paymentAmount = monthlyInstallment;
        if (loan.markupType === 'custom' && entry.totalPayment) {
          paymentAmount = parseFloat(await decrypt(entry.totalPayment, req.decryptionKey)) || 0;
        }

        loanDetails.push({
          type: loan.type || "Loan",
          monthlyInstallment: paymentAmount, // Use the correct payment amount
          paidPrev: 0, // You may need to calculate this based on previous payments
          loanAmount,
          totalMarkup,
          totalToBePaid,
          markupAmount,
          markupValue: loan.markupValue || 0,
          markupType: loan.markupType || 'fixed'
        });

        totalLoanBenefits += markupAmount;
        totalLoanInstallments += paymentAmount; // Use the correct payment amount

      } catch (e) {
        console.error(`Decryption failed for loan ${loan._id}:`, e);
        continue;
      }
    }

    res.json({
      loanDetails,
      markupValue: loanDetails[0]?.markupValue || 0, // Assuming same markup for all
       totalLoanBenefits: Math.round(totalLoanBenefits),
      totalLoanInstallments
    });

  } catch (err) {
    console.error("Error in loan-benefits:", err);
    res.status(500).json({ 
      error: "Failed to calculate benefits",
      details: err.message,
      stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
  }
});
module.exports = router;
