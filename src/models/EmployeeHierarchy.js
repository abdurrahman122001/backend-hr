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
  // New fields to track hierarchy depth and path
  hierarchyLevel: {
    type: Number,
    default: 1
  },
  path: {
    type: String,
    default: ''
  },
  // Reference to the top-level manager in this chain
  rootManager: {
    type: Schema.Types.ObjectId,
    ref: 'Employee'
  }
}, {
  timestamps: true,
});

// Indexes for efficient hierarchy queries
EmployeeHierarchySchema.index({ owner: 1, senior: 1, junior: 1 }, { unique: true });
EmployeeHierarchySchema.index({ owner: 1, junior: 1 });
EmployeeHierarchySchema.index({ owner: 1, path: 1 });
EmployeeHierarchySchema.index({ owner: 1, rootManager: 1 });
EmployeeHierarchySchema.index({ owner: 1, hierarchyLevel: 1 });

// Pre-save hook to automatically set hierarchy metadata
EmployeeHierarchySchema.pre('save', async function(next) {
  if (this.isNew) {
    // Find if the junior has any reports (to determine if they're a manager)
    const hasReports = await this.model('EmployeeHierarchy').countDocuments({
      owner: this.owner,
      senior: this.junior
    });

    // Set hierarchy level based on senior's level
    if (this.senior.equals(this.junior)) {
      throw new Error('Cannot create self-referential relationship');
    }

    const seniorRelation = await this.model('EmployeeHierarchy').findOne({
      owner: this.owner,
      junior: this.senior
    });

    if (seniorRelation) {
      this.hierarchyLevel = seniorRelation.hierarchyLevel + 1;
      this.path = seniorRelation.path ? `${seniorRelation.path}.${this.senior}` : String(this.senior);
      this.rootManager = seniorRelation.rootManager || this.senior;
    } else {
      this.hierarchyLevel = 1;
      this.path = String(this.senior);
      this.rootManager = this.senior;
    }
  }
  next();
});

// Static method to get full team hierarchy
EmployeeHierarchySchema.statics.getFullHierarchy = async function(ownerId) {
  return this.aggregate([
    { $match: { owner: ownerId } },
    {
      $graphLookup: {
        from: 'employeehierarchies',
        startWith: '$junior',
        connectFromField: 'junior',
        connectToField: 'senior',
        as: 'reportingChain',
        depthField: 'depth'
      }
    },
    {
      $addFields: {
        isLeafNode: { $eq: [{ $size: '$reportingChain' }, 0] }
      }
    },
    { $sort: { hierarchyLevel: 1, 'senior.name': 1 } }
  ]);
};

// Static method to get direct reports
EmployeeHierarchySchema.statics.getDirectReports = function(ownerId, employeeId) {
  return this.find({ 
    owner: ownerId,
    senior: employeeId 
  }).populate('junior', 'name position');
};

// Static method to get management chain
EmployeeHierarchySchema.statics.getManagementChain = function(ownerId, employeeId) {
  return this.aggregate([
    { $match: { owner: ownerId } },
    {
      $graphLookup: {
        from: 'employeehierarchies',
        startWith: employeeId,
        connectFromField: 'senior',
        connectToField: 'junior',
        as: 'managementChain',
        depthField: 'depth'
      }
    },
    { $unwind: '$managementChain' },
    { $replaceRoot: { newRoot: '$managementChain' } },
    { $sort: { depth: -1 } },
    { $lookup: {
        from: 'employees',
        localField: 'senior',
        foreignField: '_id',
        as: 'seniorData'
      }
    },
    { $unwind: '$seniorData' }
  ]);
};

module.exports = model('EmployeeHierarchy', EmployeeHierarchySchema);