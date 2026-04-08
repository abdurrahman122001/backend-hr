const express = require('express');
const router  = express.Router();
const taxController = require('../controllers/taxController');
const anyPayrollAuth = require('../middleware/anyPayrollAuth');

// ──────────── Tax Config CRUD (slabs + fiscal year) ────────────
router.get('/config',           anyPayrollAuth, taxController.getTaxConfig);
router.post('/config',          anyPayrollAuth, taxController.saveTaxConfig);
router.delete('/config/:fiscalYear', anyPayrollAuth, taxController.deleteTaxConfig);

// ──────────── Auto-tax management ────────────
router.post('/auto-tax/enable',  anyPayrollAuth, taxController.enableAutoTax);
router.post('/auto-tax/disable', anyPayrollAuth, taxController.disableAutoTax);
router.get('/auto-tax/status',   anyPayrollAuth, taxController.getAutoTaxStatus);

// ──────────── Apply / recalculate ────────────
router.post('/manual-apply',    anyPayrollAuth, taxController.manualApplyTax);
router.post('/enable',          anyPayrollAuth, taxController.enableTaxForOwner);
router.post('/update',          anyPayrollAuth, taxController.updateTaxForOwner);

// ──────────── Reporting ────────────
router.get('/owner-slips',              anyPayrollAuth, taxController.getOwnerSlipSummaries);
router.get('/calculation/:slipId',      anyPayrollAuth, taxController.getTaxCalculationDetails);

module.exports = router;