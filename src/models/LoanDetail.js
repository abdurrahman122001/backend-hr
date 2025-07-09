// models/LoanDetail.js
const mongoose = require('mongoose');

const paymentScheduleSchema = new mongoose.Schema({
  installmentNo: Number,
  month: String,      // e.g. "January"
  year: Number,       // e.g. 2024
  dueDate: Date,      // can be explicitly set
  principal: Number,
  markupPercentage: Number,
  markupAmount: Number,
  totalPayment: Number,
  outstanding: Number,
  note: String
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
  markupValue: Number,
  scheduleStartMonth: Number,
  scheduleStartYear: Number,   // <----- NEW FIELD: Allow selecting any year for schedule start!
  monthlyInstallment: Number,
  totalMarkup: Number,
  totalToBePaid: Number,
  paymentSchedule: [paymentScheduleSchema],
}, { timestamps: true });

module.exports = mongoose.model('LoanDetail', loanDetailSchema);
