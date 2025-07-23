const express = require("express");
const router = express.Router();
const { Types } = require("mongoose");

const Employee = require("../models/Employees");
const LoanDetail = require("../models/LoanDetail");
const SalarySlip = require("../models/SalarySlip");
const { encrypt, decrypt } = require("../utils/encryption"); // Assuming decrypt is now imported

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
  if (typeof monthIndex !== "number" || monthIndex < 0 || monthIndex > 11)
    throw new Error("Invalid month index");
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
  "markupAmount",
  "totalPayment",
  "outstanding",
];

// Middleware to handle decryption key (simulating frontend state)
const decryptWithKey = (req, res, next) => {
  req.decryptionKey = req.query.key || req.headers["x-decryption-key"] || ""; // Frontend should pass key via query or header
  next();
};

// 1. Get all employees
router.get("/employees", async (req, res) => {
  try {
    const employees = await Employee.find().select("_id name");
    res.json({ employees });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch employees" });
  }
});

// 2. Get all loan details for one employee
router.get("/", decryptWithKey, async (req, res) => {
  try {
    const { employee } = req.query;
    if (!employee)
      return res.status(400).json({ message: "Employee ID is required" });
    if (!Types.ObjectId.isValid(employee))
      return res.status(400).json({ message: "Invalid employee ID" });

    const loans = await LoanDetail.find({ employee }).lean();

    // Decrypt logic mirroring salary slip
    const decryptedLoans = await Promise.all(
      loans.map(async (loan) => {
        const decryptedLoan = { ...loan };
        const isUnlocked = req.decryptionKey; // Frontend determines if unlocked
        for (const field of sensitiveFields) {
          if (isUnlocked && loan[field]) {
            const decrypted = decrypt(loan[field], req.decryptionKey);
            // Only assign if not an error string
            if (
              decrypted !== "[Decryption Error]" &&
              decrypted !== "[Wrong Key]" &&
              decrypted !== "" &&
              decrypted !== undefined
            ) {
              decryptedLoan[field] = decrypted;
            } else {
              // If failed, send encrypted string (let frontend try again!)
              decryptedLoan[field] = loan[field];
            }
          } else {
            decryptedLoan[field] = loan[field];
          }
        }
        if (loan.paymentSchedule && Array.isArray(loan.paymentSchedule)) {
          decryptedLoan.paymentSchedule = await Promise.all(
            loan.paymentSchedule.map(async (entry) => {
              const decryptedEntry = { ...entry };
              for (const field of paymentScheduleSensitiveFields) {
                if (isUnlocked && entry[field]) {
                  const decrypted = decrypt(entry[field], req.decryptionKey);
                  if (
                    decrypted !== "[Decryption Error]" &&
                    decrypted !== "[Wrong Key]" &&
                    decrypted !== "" &&
                    decrypted !== undefined
                  ) {
                    decryptedEntry[field] = decrypted;
                  } else {
                    decryptedEntry[field] = entry[field];
                  }
                } else {
                  decryptedEntry[field] = entry[field];
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
      .json({ message: "Failed to fetch loans", details: err.message });
  }
});

// 3. Save or update loan detail for one employee
router.post("/loan/:employeeId", async (req, res) => {
  try {
    const { employeeId } = req.params;
    if (!Types.ObjectId.isValid(employeeId))
      return res.status(400).json({ message: "Invalid employee ID" });

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

    if (
      !type ||
      loanAmount == null ||
      !loanTerm ||
      !markupType ||
      markupValue == null ||
      scheduleStartMonth == null ||
      scheduleStartYear == null ||
      monthlyInstallment == null ||
      totalMarkup == null ||
      totalToBePaid == null
    ) {
      return res.status(400).json({ message: "All loan fields are required" });
    }

    const encryptedData = {
      loanAmount: await encrypt(loanAmount.toString()),
      monthlyInstallment: await encrypt(monthlyInstallment.toString()),
      totalMarkup: await encrypt(totalMarkup.toString()),
      totalToBePaid: await encrypt(totalToBePaid.toString()),
    };

    let encryptedPaymentSchedule = paymentSchedule;
    if (paymentSchedule && Array.isArray(paymentSchedule)) {
      encryptedPaymentSchedule = await Promise.all(
        paymentSchedule.map(async (entry) => {
          const encryptedEntry = { ...entry };
          for (const field of paymentScheduleSensitiveFields) {
            encryptedEntry[field] = await encrypt(
              (entry[field] || 0).toString()
            );
          }
          return encryptedEntry;
        })
      );
    }

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

    const { start, end } = getMonthDateRange(
      scheduleStartYear,
      scheduleStartMonth
    );
    const salarySlip = await SalarySlip.findOne({
      employee: employeeId,
      updatedAt: { $gte: start, $lte: end },
    });

    const allLoans = await LoanDetail.find({
      employee: employeeId,
      scheduleStartMonth,
      scheduleStartYear,
    });
    const totalOtherLoans = (
      await Promise.all(
        allLoans.map(async (l) =>
          Number((await decrypt(l.monthlyInstallment)) || 0)
        )
      )
    ).reduce((sum, val) => sum + val, 0);

    if (salarySlip) {
      if (!salarySlip.loanDeductions) salarySlip.loanDeductions = {};
      salarySlip.loanDeductions.otherLoans = await encrypt(
        totalOtherLoans.toString()
      );
      salarySlip.loanDeductions.vehicleLoan = await encrypt("0");
      salarySlip.gratuityFundDeduction = await encrypt("0");
      await salarySlip.save();
    }

    res.json(loan); // No decryption in response, handled by GET
  } catch (err) {
    console.error("Error saving loan:", err);
    res
      .status(500)
      .json({ error: "Failed to save loan", details: err.message });
  }
});

// 4. Get single loan detail
router.get("/loan-detail/:loanId", decryptWithKey, async (req, res) => {
  try {
    const { loanId } = req.params;
    if (!Types.ObjectId.isValid(loanId))
      return res.status(400).json({ message: "Invalid loan ID" });
    const loan = await LoanDetail.findById(loanId)
      .populate("employee", "name")
      .lean();
    if (!loan) return res.status(404).json({ message: "Loan not found" });

    const decryptedLoan = { ...loan };
    const isUnlocked = req.decryptionKey; // Frontend determines if unlocked
    for (const field of sensitiveFields) {
      if (isUnlocked && loan[field]) {
        const decrypted = decrypt(loan[field], req.decryptionKey);
        decryptedLoan[field] =
          decrypted !== "[Decryption Error]" &&
          decrypted !== "[Wrong Key]" &&
          decrypted !== "" &&
          decrypted !== undefined
            ? decrypted
            : loan[field];
      } else {
        decryptedLoan[field] = loan[field]; // <--- Send encrypted value!
      }
    }

    if (loan.paymentSchedule && Array.isArray(loan.paymentSchedule)) {
      decryptedLoan.paymentSchedule = await Promise.all(
        loan.paymentSchedule.map(async (entry) => {
          const decryptedEntry = { ...entry };
          for (const field of paymentScheduleSensitiveFields) {
            if (isUnlocked && entry[field]) {
              decryptedEntry[field] = decrypt(entry[field], req.decryptionKey);
            } else {
              decryptedEntry[field] = entry[field]; // Send encrypted value!
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

module.exports = router;
