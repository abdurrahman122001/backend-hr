const express = require('express');
const router = express.Router();
const empAuth = require('../middleware/empAuth');
const anyPayrollAuth = require('../middleware/anyPayrollAuth');
const {
  createRevision,
  getEmployeeRevisions,
  getAdminRevisions,
  getRevisionDetail,
  approveRevision,
  rejectRevision,
  withdrawRevision,
  editRevision,
  EDITABLE_FIELDS,
} = require('../controllers/profileRevisionController');
const { uploadPhotos } = require('../middleware/upload');

// Employee routes (requires empAuth)
router.post('/upload-photo', empAuth, uploadPhotos.single('photo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const url = `/uploads/photos/${req.file.filename}`;
  res.json({ url });
});
router.post('/', empAuth, createRevision);
router.get('/', empAuth, getEmployeeRevisions);
router.put('/:id', empAuth, editRevision);
router.patch('/:id/withdraw', empAuth, withdrawRevision);

// Get editable fields list (public for frontend)
router.get('/fields/editable', (req, res) => {
  res.json({ editableFields: EDITABLE_FIELDS });
});

// Admin routes (requires anyPayrollAuth)
router.get('/admin/list', anyPayrollAuth, getAdminRevisions);
router.get('/admin/:revisionId', anyPayrollAuth, getRevisionDetail);
router.patch('/admin/:revisionId/approve', anyPayrollAuth, approveRevision);
router.patch('/admin/:revisionId/reject', anyPayrollAuth, rejectRevision);

module.exports = router;
