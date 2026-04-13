const express = require('express');
const router = express.Router();
const payrollEstimateController = require('../controllers/payrollEstimateController');
const anyPayrollAuth = require('../middleware/anyPayrollAuth');

// Estimate routes
router.post('/upsert-estimate', anyPayrollAuth, payrollEstimateController.upsertEstimate);
router.get('/', anyPayrollAuth, payrollEstimateController.getEstimates);
router.get('/estimates', anyPayrollAuth, payrollEstimateController.getEstimates);
router.post('/clear-estimates', anyPayrollAuth, payrollEstimateController.clearEstimates);
router.post('/delete-estimate', anyPayrollAuth, payrollEstimateController.deleteEstimate);

// Tax override routes
router.post('/upsert-tax-override', anyPayrollAuth, payrollEstimateController.upsertTaxOverride);
router.get('/tax-overrides', anyPayrollAuth, payrollEstimateController.getTaxOverrides);

module.exports = router;
