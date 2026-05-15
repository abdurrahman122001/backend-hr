// backend/src/controllers/empAuthController.js
const Employee = require('../models/Employees');
const crypto = require('crypto');
// /api/emp-auth/me
exports.getMe = async (req, res) => {
  try {
    const emp = await Employee.findById(req.employee._id).lean();

    if (!emp) return res.status(404).json({ error: 'Employee not found' });

    // 1. Fetch CNIC documents from EmployeeDocument
    const EmployeeDocument = require('../models/EmployeeDocument');
    const docs = await EmployeeDocument.findOne({ employee: emp._id }).lean();
    if (docs) {
      emp.cnicFrontUrl = docs.cnicFrontUrl;
      emp.cnicBackUrl = docs.cnicBackUrl;
      emp.resumeUrl = docs.resumeUrl;
    }

    // 2. Fetch academic certificates from Certificate model
    const Certificate = require('../models/Certificate');
    const certificates = await Certificate.find({ employee: emp._id }).lean();
    
    // Map certificates by type to virtual field names
    certificates.forEach(cert => {
      if (cert.type === 'matric') emp.matricCertificateUrl = cert.fileUrl;
      if (cert.type === 'inter') emp.interCertificateUrl = cert.fileUrl;
      if (cert.type === 'graduate') emp.graduateCertificateUrl = cert.fileUrl;
      if (cert.type === 'masters') emp.mastersCertificateUrl = cert.fileUrl;
    });

    res.json(emp);
  } catch (err) {
    console.error('[EMP-AUTH-ME] Error:', err);
    res.status(500).json({ error: 'Server error' });
  }
};