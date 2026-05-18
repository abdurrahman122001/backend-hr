const { Schema, model } = require('mongoose');

const SubDepartmentSchema = new Schema({
  owner: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  department: {
    type: Schema.Types.ObjectId,
    ref: 'Department',
    required: true,
  },
  name: {
    type: String,
    required: true,
    trim: true,
  },
  designations: {
    type: [String],
    default: [],
  },
  order: {
    type: Number,
    required: true,
    default: 0,
  },
}, {
  timestamps: true,
});

// Ensure a sub-department name is unique under a given parent department for each owner
SubDepartmentSchema.index({ owner: 1, department: 1, name: 1 }, { unique: true });

SubDepartmentSchema.pre('save', async function(next) {
  if (this.isNew) {
    const lastSubDepartment = await this.constructor
      .findOne({ owner: this.owner, department: this.department })
      .sort({ order: -1 })
      .select('order')
      .lean();
    this.order = lastSubDepartment ? lastSubDepartment.order + 1 : 0;
  }
  next();
});

module.exports = model('SubDepartment', SubDepartmentSchema);
