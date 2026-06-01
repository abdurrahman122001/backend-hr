const { Schema, model } = require('mongoose');

const BranchSchema = new Schema({
  name: { type: String, required: true },
  address: { type: String, required: true },
  phone: { type: String, required: true },
  email: { type: String, required: true }, // New email field
  useForDocumentation: { type: Boolean, default: false } // New documentation flag
});

const CompanyProfileSchema = new Schema({
  owner:   { type: Schema.Types.ObjectId, ref: 'User', required: true },
  name:    { type: String, required: true },
  branches: [BranchSchema],
  email:   { type: String, required: true },
  website: { type: String, default: "" },
  logo:    { type: String, default: "" },
  // Sequential counter for auto-generated employee IDs (e.g. ABC-000001)
  employeeIdSequence: { type: Number, default: 0 },
  ownerIndex: { type: Number }
}, { timestamps: true });

module.exports = model('CompanyProfile', CompanyProfileSchema);