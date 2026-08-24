const express = require('express');
const router = express.Router();
const multer = require('multer');
const certificateController = require('../controllers/certificateController');
const employeeDocAccess = require('../middleware/employeeDocAccess');

// Use memory storage (write manually). Education certificates are PDFs or
// scans — anything else is rejected rather than written to disk, and the size
// cap stops an unbounded upload from filling the server's only volume.
const ALLOWED_MIME = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIME.has(file.mimetype)) return cb(null, true);
    cb(new Error('Only PDF or image files are allowed.'));
  },
});

// Every route is scoped to one employee, and every one of them is gated: the
// employee themselves, their company, or a valid complete-profile link token.
router.use('/:employeeId', employeeDocAccess);

router.post('/:employeeId/:type', upload.single('file'), certificateController.uploadCertificate);
router.get('/:employeeId', certificateController.getCertificates);
router.delete('/:employeeId/:type', certificateController.deleteCertificate);

module.exports = router;
