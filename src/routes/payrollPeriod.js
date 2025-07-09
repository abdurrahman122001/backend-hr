const router = require('express').Router();
const {
  getPayrollPeriod,
  createPayrollPeriod,
  updatePayrollPeriod,
  deletePayrollPeriod,
  updateNonWorkingDays,
  getNonWorkingDays,
  getCurrentPayrollPeriod,
  getCurrentPayrollPeriodStatus, // <-- new
} = require('../controllers/payrollPeriodController');

// List, create, update, delete
router.get('/', getPayrollPeriod);
router.post('/', createPayrollPeriod);
router.put('/:id', updatePayrollPeriod);
router.delete('/:id', deletePayrollPeriod);

// Non-working days
router.patch('/non-working-days', updateNonWorkingDays);
router.get('/non-working-days', getNonWorkingDays);

// Get period for UI
router.get('/current', getCurrentPayrollPeriod);
router.get('/current-status', getCurrentPayrollPeriodStatus); // <-- new: returns status, days left, employees/slips

module.exports = router;
