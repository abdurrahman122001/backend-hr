const { Schema, model } = require('mongoose');

const BranchSchema = new Schema({
  name: { type: String, required: true }, // <-- New branch name field
  address: { type: String, required: true },
  phone: { type: String, required: true }
});

const CompanyProfileSchema = new Schema({
  owner:   { type: Schema.Types.ObjectId, ref: 'User', required: true },
  name:    { type: String, required: true },
  branches: [BranchSchema],
  email:   { type: String, required: true },
  website: { type: String, default: "" },
  logo:    { type: String, default: "" }   
}, { timestamps: true });

module.exports = model('CompanyProfile', CompanyProfileSchema);