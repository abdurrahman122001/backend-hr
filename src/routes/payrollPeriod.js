// backend/src/routes/payrollPeriods.js
const router = require('express').Router();
const {
  getPayrollPeriod,
  createPayrollPeriod,
  updatePayrollPeriod,
  deletePayrollPeriod,
  updateNonWorkingDays,
  getNonWorkingDays,
} = require('../controllers/payrollPeriodController');

router.get('/', getPayrollPeriod);
router.post('/', createPayrollPeriod);
router.put('/:id', updatePayrollPeriod);
router.delete('/:id', deletePayrollPeriod);

router.patch('/non-working-days', updateNonWorkingDays);
router.get('/non-working-days', getNonWorkingDays);

module.exports = router;
