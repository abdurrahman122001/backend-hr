// models/LoanDetail.js
const mongoose = require('mongoose');

const paymentScheduleSchema = new mongoose.Schema({
  installmentNo: String,      // encrypted
  month: String,
  year: String,               // encrypted
  dueDate: Date,
  principal: String,          // encrypted
  markupPercentage: String,   // encrypted
  markupAmount: String,       // encrypted
  totalPayment: String,       // encrypted
  outstanding: String,        // encrypted
  note: String
});

const loanDetailSchema = new mongoose.Schema({
  employee: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
  type: { type: String, default: "Personal Loan" },
  loanAmount: String,            // encrypted
  loanTerm: String,              // encrypted
  markupType: { 
    type: String, 
    enum: ['fixed', 'reducing', 'interestOnly'],
    required: true
  },
  markupValue: String,           // encrypted
  scheduleStartMonth: String,    // encrypted
  scheduleStartYear: String,     // encrypted
  monthlyInstallment: String,    // encrypted
  totalMarkup: String,           // encrypted
  totalToBePaid: String,         // encrypted
  paymentSchedule: [paymentScheduleSchema],
}, { timestamps: true });

module.exports = mongoose.model('LoanDetail', loanDetailSchema);
