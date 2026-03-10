const router = require('express').Router();
const {
  markAttendance,
  getRecordsByDate,
  getStats,
  getRecordsByEmployee,
  getStatsByEmployee,
  getRecordsByDateRange,
  deleteRecord,
  creditBonusLeavesForPayrollPeriod
} = require('../controllers/attendanceController');
const AttendanceLog = require('../models/AttendanceLog');
const requireAuth = require('../middleware/auth');
const leaveYearBalanceController = require('../controllers/leaveYearBalanceController');
const attendanceAuth = require('../middleware/attendanceAuth');

// existing endpoints
router.post('/', markAttendance);      // upsert by {employee, date}
router.get('/', getRecordsByDate);    // GET /api/attendance?date=YYYY-MM-DD
router.get('/stats', getStats);            // GET /api/attendance/stats?date=YYYY-MM-DD

// ✅ NEW: GET between-shift login logs (MUST come before /employee/:id)
router.get('/logs/between-shift', requireAuth, async (req, res) => {
  try {
    let { ownerId, startDate, endDate, employeeId } = req.query;

    // ✅ If ownerId not provided in query, use the authenticated user's owner from middleware
    if (!ownerId && req.user) {
      ownerId = req.user.owner;
    }

    if (!ownerId) {
      return res.status(401).json({ error: "Authentication failed: Unable to determine company ID. Please log in again." });
    }

    const query = { owner: ownerId };

    if (employeeId) {
      query.employee = employeeId;
    }

    if (startDate && endDate) {
      query.date = { $gte: startDate, $lte: endDate };
    }

    const logs = await AttendanceLog.find(query)
      .populate('employee', 'name email companyEmail')
      .populate('firstShiftId', 'name start end')
      .populate('secondShiftId', 'name start end')
      .sort({ createdAt: -1 })
      .lean();

    return res.json({
      status: 'success',
      total: logs.length,
      data: logs
    });
  } catch (err) {
    console.error('[ATTENDANCE-LOGS] Error:', err);
    return res.status(500).json({ error: 'Server error fetching logs' });
  }
});

// ✅ UPDATE LOG STATUS (for admin review)
router.patch('/logs/between-shift/:id', requireAuth, async (req, res) => {
  try {
    const { status, notes } = req.body;
    const logId = req.params.id;

    const updateData = {};
    if (status) updateData.status = status;
    if (notes) updateData.notes = notes;
    updateData.reviewedBy = req.user._id;
    updateData.reviewedAt = new Date();

    const updated = await AttendanceLog.findByIdAndUpdate(
      logId,
      updateData,
      { new: true }
    ).populate('employee', 'name email companyEmail');

    return res.json({
      status: 'success',
      data: updated
    });
  } catch (err) {
    console.error('[ATTENDANCE-LOGS-UPDATE] Error:', err);
    return res.status(500).json({ error: 'Server error updating log' });
  }
});

// GET all daily records for one employee
//  → /api/attendance/employee/:id
router.get('/employee/:id', getRecordsByEmployee);

// GET current year balance for one employee
//  → /api/attendance/employee/:employeeId/current
router.get('/employee/:employeeId/current', attendanceAuth, leaveYearBalanceController.getCurrentYearLeaveBalance);

// GET aggregated totals for one employee
router.get('/employee/:id/stats', getStatsByEmployee);
router.get('/range', getRecordsByDateRange);
router.delete('/:id', deleteRecord);

module.exports = router;
