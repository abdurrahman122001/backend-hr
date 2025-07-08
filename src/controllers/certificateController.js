const Certificate = require('../models/Certificate');
const path = require('path');
const fs = require('fs');

exports.uploadCertificate = async (req, res) => {
  try {
    const { employeeId } = req.params;
    const { type } = req.body;
    const file = req.file;

    if (!type || !['matric', 'inter', 'graduate', 'masters'].includes(type)) {
      return res.status(400).json({ success: false, error: 'Invalid certificate type.' });
    }
    if (!file) {
      return res.status(400).json({ success: false, error: 'No file uploaded.' });
    }

    // Save file to disk (or use S3)
    const fileName = `${employeeId}_${type}_${Date.now()}${path.extname(file.originalname)}`;
    const uploadDir = path.join(__dirname, '../uploads/certificates');
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
    const filePath = path.join(uploadDir, fileName);
    fs.writeFileSync(filePath, file.buffer);

    // Remove previous certificate if exists
    await Certificate.deleteOne({ employee: employeeId, type });

    // Save to DB
    const cert = await Certificate.create({
      employee: employeeId,
      type,
      fileUrl: `/uploads/certificates/${fileName}`
    });

    res.json({ success: true, certificate: cert });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

exports.getCertificates = async (req, res) => {
  const { employeeId } = req.params;
  const certs = await Certificate.find({ employee: employeeId });
  res.json({ success: true, certificates: certs });
};

exports.deleteCertificate = async (req, res) => {
  const { employeeId, type } = req.params;
  await Certificate.deleteOne({ employee: employeeId, type });
  res.json({ success: true });
};
