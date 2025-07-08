const express = require('express');
const router = express.Router();
const multer = require('multer');
const certificateController = require('../controllers/certificateController');

// Use memory storage (write manually)
const upload = multer({ storage: multer.memoryStorage() });

router.post('/:employeeId/:type', upload.single('file'), certificateController.uploadCertificate);
router.get('/:employeeId', certificateController.getCertificates);
router.delete('/:employeeId/:type', certificateController.deleteCertificate);

module.exports = router;
