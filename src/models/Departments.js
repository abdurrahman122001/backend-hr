// backend/src/models/Departments.js 

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
}, {
  timestamps: true,
});

DepartmentSchema.index({ owner: 1, name: 1 }, { unique: true });

module.exports = model('Department', DepartmentSchema);
