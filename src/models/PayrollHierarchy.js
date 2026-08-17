const { Schema, model } = require('mongoose');

const PayrollHierarchySchema = new Schema({
  owner: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  employee: {
    type: Schema.Types.ObjectId,
    ref: 'Employee',
    required: true
  },
  senior: {
    type: Schema.Types.ObjectId,
    ref: 'Employee',
    default: null
  },
  relation: {
    type: String,
    enum: ['Manager', 'Team Lead', 'Payroll Approver', 'Other'],
    default: 'Payroll Approver'
  },
  hierarchyLevel: {
    type: Number,
    required: true,
    default: 0
  },
  path: {
    type: String,
    required: true
  },
  rootManager: {
    type: Schema.Types.ObjectId,
    ref: 'Employee',
    required: true
  }
}, { timestamps: true });

PayrollHierarchySchema.index({ owner: 1, employee: 1 }, { unique: true });
PayrollHierarchySchema.index({ owner: 1, senior: 1 });
PayrollHierarchySchema.index({ owner: 1, path: 1 });
PayrollHierarchySchema.index({ owner: 1, rootManager: 1 });
PayrollHierarchySchema.index({ owner: 1, hierarchyLevel: 1 });

module.exports = model('PayrollHierarchy', PayrollHierarchySchema);
