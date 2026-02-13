const { Schema, model } = require('mongoose');

const EmployeeHierarchySchema = new Schema({
  owner: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  senior: {
    type: Schema.Types.ObjectId,
    ref: 'Employee',
    required: true
  },
  junior: {
    type: Schema.Types.ObjectId,
    ref: 'Employee',
    required: true
  },
  relation: {
    type: String,
    enum: ['Manager', 'Team Lead', 'Mentor', 'Other'],
    default: 'Manager'
  },
  supervisionEnabled: {
    type: Boolean,
    default: false
  },
  hierarchyLevel: {

    type: Number,
    required: true
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

// indexes
EmployeeHierarchySchema.index({ owner: 1, senior: 1, junior: 1 }, { unique: true });
EmployeeHierarchySchema.index({ owner: 1, junior: 1 });
EmployeeHierarchySchema.index({ owner: 1, path: 1 });
EmployeeHierarchySchema.index({ owner: 1, rootManager: 1 });
EmployeeHierarchySchema.index({ owner: 1, hierarchyLevel: 1 });

module.exports = model('EmployeeHierarchy', EmployeeHierarchySchema);
