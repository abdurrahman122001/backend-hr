const mongoose = require('mongoose');

const setDateSchema = new mongoose.Schema({
  joiningDateDays: { type: Number, default: 7 },      // e.g. 7 days from now
  confirmationDeadlineDays: { type: Number, default: 3 }, // e.g. 3 days after joining
}, { timestamps: true });

module.exports = mongoose.model('setDateSchema', setDateSchema);
