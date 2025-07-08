const router = require('express').Router();
const {
  markAttendance,
  getRecordsByDate,
  getStats,
  getRecordsByEmployee,
  getStatsByEmployee,
  getRecordsByDateRange, 
  deleteRecord
} = require('../controllers/attendanceController');

// existing endpoints
router.post('/',     markAttendance);      // upsert by {employee, date}
router.get('/',      getRecordsByDate);    // GET /api/attendance?date=YYYY-MM-DD
router.get('/stats', getStats);            // GET /api/attendance/stats?date=YYYY-MM-DD

// ↓ add these two ↓
// GET all daily records for one employee
//  → /api/attendance/employee/:id
router.get('/employee/:id', getRecordsByEmployee);

// GET aggregated totals for one employee
//  → /api/attendance/employee/:id/stats
router.get('/employee/:id/stats', getStatsByEmployee);
router.get('/range', getRecordsByDateRange);
router.delete('/:id', deleteRecord);
module.exports = router;
