const mongoose = require('mongoose');

const taxOverrideSchema = new mongoose.Schema({
  employeeId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Employees',
    required: true
  },
  owner: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  // Encrypted tax amount - now global for the employee
  taxValue: {
    type: String,
    required: true
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

// One tax override per employee per owner
taxOverrideSchema.index({ employeeId: 1, owner: 1 }, { unique: true });

module.exports = mongoose.model('TaxOverride', taxOverrideSchema);
