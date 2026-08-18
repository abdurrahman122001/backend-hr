const mongoose = require("mongoose");
const { Schema } = mongoose;

// The loan kinds payroll can actually set up — LoanDetail.type, and the four
// choices in the admin Loan Calculator. A request now names one, because each
// asks for a different shape of loan:
//   Personal Loan   — repaid from the loan-deduction column on a schedule
//   Loan Allowance  — repaid out of one allowance, no term of its own
//   Bonus Loan      — no schedule at all; recovered from bonuses as they fall
//   Long Term Loan  — scheduled, but every month's deduction needs sign-off
const LOAN_CATEGORIES = [
  "Personal Loan",
  "Loan Allowance",
  "Bonus Loan",
  "Long Term Loan",
];

// Only the scheduled kinds have a repayment term to ask for.
const CATEGORIES_WITH_PERIOD = ["Personal Loan", "Long Term Loan"];
const needsPeriod = function () {
  return CATEGORIES_WITH_PERIOD.includes(this.loanCategory || "Personal Loan");
};

const LoanRequestSchema = new Schema(
  {
    owner: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    employee: {
      type: Schema.Types.ObjectId,
      ref: "Employee",
      required: true,
    },
    amount: {
      type: Number,
      required: true,
    },
    loanCategory: {
      type: String,
      enum: LOAN_CATEGORIES,
      default: "Personal Loan",
    },
    period: {
      type: Number, // Number of months
      // A Bonus Loan has no term and a Loan Allowance is paced by the
      // allowance itself, so neither carries one.
      required: needsPeriod,
    },
    reason: {
      type: String,
      required: true,
    },
    status: {
      type: String,
      enum: ["pending", "approved", "rejected", "cancelled"],
      default: "pending",
    },
    rejectionReason: {
      type: String,
    },
    reviewedBy: {
      type: Schema.Types.ObjectId,
      ref: "Employee",
    },
    approvedAt: {
      type: Date,
    },
    approvedBy: {
      type: Schema.Types.ObjectId,
      ref: "Employee",
    },
    // Loan Allowance only: which allowance to take it from, and how much of
    // that allowance each month.
    loanAllowanceField: {
      type: String,
      default: null,
    },
    loanDeductionType: {
      type: String,
      enum: ["complete", "amount_upto", "percentage", null],
      default: null,
    },
    // The cap (amount_upto) or the share (percentage). Unused for "complete".
    loanDeductionValue: {
      type: Number,
      default: null,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("LoanRequest", LoanRequestSchema);
module.exports.LOAN_CATEGORIES = LOAN_CATEGORIES;
module.exports.CATEGORIES_WITH_PERIOD = CATEGORIES_WITH_PERIOD;

