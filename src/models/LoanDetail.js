
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
      required: true,
    },
    markupValue: {
      type: String,
      required: true,
    },
    scheduleStartMonth: {
      type: String, 
      required: true,
    },
    scheduleStartYear: {
      type: String, 
      required: true,
    },
    monthlyInstallment: {
      type: String, // Encrypted
      required: true,
    },
    totalMarkup: {
      type: String, // Encrypted
      required: true,
    },
    totalToBePaid: {
      type: String, // Encrypted
      required: true,
    },
    paymentSchedule: {
      type: [paymentScheduleSchema],
      required: true,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("LoanDetail", loanDetailSchema);
