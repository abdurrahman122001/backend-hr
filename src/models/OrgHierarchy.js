const { Schema, model } = require('mongoose');

const OrgHierarchySchema = new Schema({
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

OrgHierarchySchema.index({ owner: 1, senior: 1, junior: 1 }, { unique: true });
OrgHierarchySchema.index({ owner: 1, junior: 1 });
OrgHierarchySchema.index({ owner: 1, path: 1 });
OrgHierarchySchema.index({ owner: 1, rootManager: 1 });
OrgHierarchySchema.index({ owner: 1, hierarchyLevel: 1 });

module.exports = model('OrgHierarchy', OrgHierarchySchema);
