const { Schema, model } = require('mongoose');

const BranchSchema = new Schema({
  address: { type: String, required: true },
  phone:   { type: String, required: true }
});

const CompanyProfileSchema = new Schema({
  owner:   { type: Schema.Types.ObjectId, ref: 'User', required: true },
  name:    { type: String, required: true },
  branches: [BranchSchema], // <-- Array of branches!
  email:   { type: String, required: true },
  website: { type: String, default: "" },
  logo:    { type: String, default: "" }   
}, { timestamps: true });


module.exports = model('CompanyProfile', CompanyProfileSchema);
