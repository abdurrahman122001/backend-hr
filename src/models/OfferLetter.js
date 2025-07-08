const { Schema, model } = require('mongoose');

const OfferLetterSchema = new Schema({
  owner:          { type: Schema.Types.ObjectId, ref: 'User', required: true },
  employee:       { type: Schema.Types.ObjectId, ref: 'Employee', required: true },
  position:       { type: String, required: true },
  department:     { type: String },
  salaryOffered:  { type: Number, required: true },
  leaveEntitlement: {
    total:        { type: Number, default: 22 },
    paid:         { type: Number, default: 22 },
    unpaid:       { type: Number, default: 0 },
  },
  issuedAt:       { type: Date, default: () => new Date() },
  letterContent:  { type: String, required: true },
}, { timestamps: true });

module.exports = model('OfferLetter', OfferLetterSchema);
