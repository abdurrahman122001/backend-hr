const express = require('express');
const router  = express.Router();
const taxController = require('../controllers/taxController');
const auth = require('../middleware/auth');

// ──────────── Tax Config CRUD (slabs + fiscal year) ────────────
router.get('/config',           auth, taxController.getTaxConfig);
router.post('/config',          auth, taxController.saveTaxConfig);
router.delete('/config/:fiscalYear', auth, taxController.deleteTaxConfig);

// ──────────── Auto-tax management ────────────
router.post('/auto-tax/enable',  auth, taxController.enableAutoTax);
router.post('/auto-tax/disable', auth, taxController.disableAutoTax);
router.get('/auto-tax/status',   auth, taxController.getAutoTaxStatus);

// ──────────── Apply / recalculate ────────────
router.post('/manual-apply',    auth, taxController.manualApplyTax);
router.post('/enable',          auth, taxController.enableTaxForOwner);
router.post('/update',          auth, taxController.updateTaxForOwner);

// ──────────── Reporting ────────────
router.get('/owner-slips',              auth, taxController.getOwnerSlipSummaries);
router.get('/calculation/:slipId',      auth, taxController.getTaxCalculationDetails);

module.exports = router;