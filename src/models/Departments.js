const { Schema, model } = require('mongoose');

const DepartmentSchema = new Schema({
  owner: {
    type: Schema.Types.ObjectId,
    ref: 'User',
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

DepartmentSchema.index({ owner: 1, name: 1 }, { unique: true });

DepartmentSchema.pre('save', async function(next) {
  if (this.isNew) {
    const lastDepartment = await this.constructor
      .findOne({ owner: this.owner })
      .sort({ order: -1 })
      .select('order')
      .lean();
    this.order = lastDepartment ? lastDepartment.order + 1 : 0;
  }
  next();
});

module.exports = model('Department', DepartmentSchema);
