const express = require('express');
const router = express.Router();
const multer = require('multer');
const storage = multer.memoryStorage();
const upload = multer({ storage });
const certificateController = require('../controllers/certificateController');

router.post(
  '/certificate/:employeeId/certificates',
  upload.single('file'),
  certificateController.uploadCertificate
);

router.get(
  '/certificate/:employeeId/certificates',
  certificateController.getCertificates
);

router.delete(
  '/certificate/:employeeId/certificates/:type',
  certificateController.deleteCertificate
);

module.exports = router;
