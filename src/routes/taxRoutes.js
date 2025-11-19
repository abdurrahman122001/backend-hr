const express = require('express');
const router = express.Router();
const taxController = require('../controllers/taxController');
const auth = require('../middleware/auth');

// Auto-tax management routes
router.post('/auto-tax/enable', auth, taxController.enableAutoTax);
router.post('/auto-tax/disable', auth, taxController.disableAutoTax);

// FIXED: Use query parameters instead of route parameters for optional fiscalYear
router.get('/auto-tax/status', auth, taxController.getAutoTaxStatus);

router.post('/manual-apply', auth, taxController.manualApplyTax);

// Existing routes
router.post('/enable', auth, taxController.enableTaxForOwner);
router.post('/update', auth, taxController.updateTaxForOwner);
router.get('/owner-slips', auth, taxController.getOwnerSlipSummaries);
router.get('/calculation/:slipId', auth, taxController.getTaxCalculationDetails);

module.exports = router;