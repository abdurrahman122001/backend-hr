const express = require('express');
const router = express.Router();
const payrollEstimateController = require('../controllers/payrollEstimateController');
const auth = require('../middleware/auth');

// Estimate routes
router.post('/upsert-estimate', auth, payrollEstimateController.upsertEstimate);
router.get('/estimates', auth, payrollEstimateController.getEstimates);
router.post('/clear-estimates', auth, payrollEstimateController.clearEstimates);

// Tax override routes
router.post('/upsert-tax-override', auth, payrollEstimateController.upsertTaxOverride);
router.get('/tax-overrides', auth, payrollEstimateController.getTaxOverrides);

module.exports = router;
