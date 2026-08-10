
const mongoose = require("mongoose");

const paymentScheduleSchema = new mongoose.Schema({
  installmentNo: {
    type: Number,
    required: true,
  },
  month: {
    type: String,
    required: true,
  },
  year: {
    type: Number,
    required: true,
  },
  principal: {
    type: String, // Encrypted
    required: true,
  },
  markupPercentage: {
    type: String, // Encrypted
    required: true,
  },
  markupAmount: {
    type: String, // Encrypted
    required: true,
  },
  totalPayment: {
    type: String, // Encrypted
    required: true,
  },
  outstanding: {
    type: String, // Encrypted, optional
  },
  note: {
    type: String,
  },
  dueDate: {
    type: Date,
    required: true,
  },
  customAmount: {
    type: String, // Encrypted, optional (used for custom loans)
  },
});

// A loan repaid out of future BONUSES rather than from monthly salary. It has
// no payment schedule at all — nothing is owed on any particular date — so the
// schedule-driven fields below are only required for the other loan types.
const BONUS_LOAN_TYPE = "Bonus Loan";
const notBonusLoan = function () {
  return this.type !== BONUS_LOAN_TYPE;
};

// A long-running loan whose every single monthly deduction has to be signed off
// by an admin before payroll takes it. It keeps a normal payment schedule — the
// schedule is what the month's figure is PROPOSED from — but nothing is ever
// deducted from a month that has no approval record below.
const LONG_TERM_LOAN_TYPE = "Long Term Loan";

// One approved month. The amount is stored rather than re-derived so the
// deduction can never drift from what was actually signed off: an admin may
// approve less than the installment (a short month capped by net salary), and
// the shortfall simply stays in the outstanding balance for a later month.
const deductionApprovalSchema = new mongoose.Schema(
  {
    month: { type: String, required: true },
    year: { type: Number, required: true },
    amount: { type: String, required: true }, // Encrypted
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Employee" },
    approvedByName: { type: String, default: "" },
    approvedAt: { type: Date, default: () => new Date() },
  },
  { _id: false },
);

// One month's recovery against a bonus loan, so recomputing a slip is
// repeatable: the month being recalculated is excluded from the running total
// before its own share is worked out again, which is what stops a re-run (or an
// edited bonus) from recovering the same rupee twice.
const bonusRecoverySchema = new mongoose.Schema(
  {
    month: { type: String, required: true },
    year: { type: Number, required: true },
    amount: { type: String, required: true }, // Encrypted
    at: { type: Date, default: () => new Date() },
  },
  { _id: false },
);

const loanDetailSchema = new mongoose.Schema(
  {
    employee: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Employee",
      required: true,
    },
    type: {
      type: String,
      required: true,
      default: "Personal Loan",
    },
    // Populated for Bonus Loans only.
    bonusRecoveries: {
      type: [bonusRecoverySchema],
      default: [],
    },
    // Populated for Long Term Loans only: the months an admin has signed off,
    // and for how much. A month absent from this list deducts nothing.
    deductionApprovals: {
      type: [deductionApprovalSchema],
      default: [],
    },
    loanAllowanceField: {
      type: String,
      default: null, // The allowance field key to deduct from (e.g., "houseRentAllowance")
    },
    loanAmount: {
      type: String, // Encrypted
      required: true,
    },
    loanTerm: {
      type: String,
    },
    markupType: {
      type: String,
      enum: ["fixed", "reducing", "interestOnly", "custom"],
      required: notBonusLoan,
    },
    markupValue: {
      type: String,
      required: notBonusLoan,
    },
    scheduleStartMonth: {
      type: String,
      required: notBonusLoan,
    },
    scheduleStartYear: {
      type: String,
      required: notBonusLoan,
    },
    monthlyInstallment: {
      type: String, // Encrypted
      required: notBonusLoan,
    },
    totalMarkup: {
      type: String, // Encrypted
      required: notBonusLoan,
    },
    totalToBePaid: {
      type: String, // Encrypted
      required: notBonusLoan,
    },
    paymentSchedule: {
      type: [paymentScheduleSchema],
      required: notBonusLoan,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("LoanDetail", loanDetailSchema);
module.exports.BONUS_LOAN_TYPE = BONUS_LOAN_TYPE;
module.exports.LONG_TERM_LOAN_TYPE = LONG_TERM_LOAN_TYPE;
