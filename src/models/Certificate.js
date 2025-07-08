const mongoose = require('mongoose');
const CertificateSchema = new mongoose.Schema({
  employee: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
  type: { type: String, enum: ['matric', 'inter', 'graduate', 'masters'], required: true },
  fileUrl: { type: String, required: true },
  uploadedAt: { type: Date, default: Date.now },
});
module.exports = mongoose.model('Certificate', CertificateSchema);
