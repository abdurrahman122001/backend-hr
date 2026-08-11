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

  // Its chat group is keyed on the name, so a rename has to carry the old one
  // over or the department ends up with two groups (services/systemGroupService).
  this.$locals.previousName = null;
  if (!this.isNew && this.isModified('name')) {
    const stored = await this.constructor
      .findById(this._id)
      .select('name')
      .lean();
    this.$locals.previousName = stored?.name || null;
  }

  next();
});

// Every department gets a chat group, staffed or not, so it is waiting for its
// first hire. Fire-and-safe: the service swallows its own failures.
DepartmentSchema.post('save', async function() {
  const { syncDepartmentGroup } = require('../services/systemGroupService');
  await syncDepartmentGroup({
    ownerId: this.owner,
    name: this.name,
    previousName: this.$locals.previousName,
  });
});

module.exports = model('Department', DepartmentSchema);
