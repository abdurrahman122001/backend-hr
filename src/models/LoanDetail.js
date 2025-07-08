const mongoose = require('mongoose');

const paymentScheduleSchema = new mongoose.Schema({
  installmentNo: Number,
  month: String,
  year: Number,
  dueDate: Date, // Optional; can be set by frontend if needed
  principal: Number, // Amount of principal paid in this installment
  markupPercentage: Number, // Interest/markup rate for this installment
  markupAmount: Number, // Interest/markup amount for this installment
  totalPayment: Number, // Total paid this installment (principal+markup, or just interest)
  outstanding: Number, // For EMI: outstanding balance after this payment
  note: String // For special notes (e.g., "Interest Only", "Principal + Last Interest")
});

const loanDetailSchema = new mongoose.Schema({
  employee: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
  type: { type: String, default: "Personal Loan" },
  loanAmount: Number,
  loanTerm: Number,
  markupType: { 
    type: String, 
    enum: ['fixed', 'reducing', 'interestOnly'],
    required: true
  },
  markupValue: Number, // Interest/markup rate (%)
  scheduleStartMonth: Number,
  monthlyInstallment: Number,
  totalMarkup: Number,
  totalToBePaid: Number,
  paymentSchedule: [paymentScheduleSchema],
}, { timestamps: true });

module.exports = mongoose.model('LoanDetail', loanDetailSchema);
