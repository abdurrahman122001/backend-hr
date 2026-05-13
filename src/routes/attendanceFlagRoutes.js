const router = require('express').Router();
const {
  getAttendanceFlags,
  createAttendanceFlag,
  updateAttendanceFlag,
  deleteAttendanceFlag
} = require('../controllers/attendanceFlagController');

const anyPayrollAuth = require('../middleware/anyPayrollAuth');

// Apply authentication middleware to all routes
router.use(anyPayrollAuth);

// GET all attendance flags
router.get('/', getAttendanceFlags);

// POST new attendance flag
router.post('/', createAttendanceFlag);

// PUT update attendance flag
router.put('/:id', updateAttendanceFlag);

// DELETE attendance flag
router.delete('/:id', deleteAttendanceFlag);

module.exports = router;
