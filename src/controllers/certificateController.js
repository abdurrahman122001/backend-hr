const path = require('path');
const fs = require('fs');
const Certificate = require('../models/Certificate');

// Helper: resolve upload directory
const getFolderPath = (employeeId, type) =>
  path.join(__dirname, '..', 'uploads', 'certificates', employeeId, type);

exports.uploadCertificate = async (req, res) => {
  try {
    const { employeeId, type } = req.params;
    const file = req.file;

    const allowed = ['matric', 'inter', 'graduate', 'masters'];
    if (!allowed.includes(type)) return res.status(400).json({ error: 'Invalid certificate type.' });

    // Ensure directory exists: /uploads/certificates/<employeeId>/<type>/
    const folderPath = getFolderPath(employeeId, type);
    fs.mkdirSync(folderPath, { recursive: true });

    // OPTIONAL: Delete existing certificate for this type for this employee (only keep latest)
    const existing = await Certificate.findOne({ employee: employeeId, type });
    if (existing && existing.fileUrl) {
      const oldPath = path.join(__dirname, '..', existing.fileUrl);
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
      await existing.deleteOne();
    }

    const fileName = `${Date.now()}_${file.originalname.replace(/\s+/g, '_')}`;
    const uploadPath = path.join(folderPath, fileName);

    fs.writeFileSync(uploadPath, file.buffer);

    // Store URL as relative path for static serving
    const fileUrl = `/uploads/certificates/${employeeId}/${type}/${fileName}`;

    // Save record
    const cert = await Certificate.create({
      employee: employeeId,
      type,
      fileUrl,
    });

    res.json({ success: true, cert });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.getCertificates = async (req, res) => {
  try {
    const { employeeId } = req.params;
    const certs = await Certificate.find({ employee: employeeId });

    // Attach absolute URL
    const baseUrl = req.protocol + '://' + req.get('host');
    const certsWithUrl = certs.map(cert => ({
      ...cert.toObject(),
      url: baseUrl + cert.fileUrl
    }));

    res.json({ success: true, certs: certsWithUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
exports.deleteCertificate = async (req, res) => {
  try {
    const { employeeId, type } = req.params;
    const cert = await Certificate.findOneAndDelete({ employee: employeeId, type });
    if (!cert) return res.status(404).json({ error: 'Not found' });

    // Delete file from disk
    const filePath = path.join(__dirname, '..', cert.fileUrl);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
