const express = require('express');
const router = express.Router();
const Attendance = require('../models/Attendance');

// GET /api/emp-attendance/me
router.get('/me', async (req, res) => {
  try {
    const records = await Attendance.find({ employee: req.employee._id }).sort({ date: -1 });
    res.json(records);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch attendance records' });
  }
});

router.get('/holidays', async (req, res) => {
  try {
    const holidayRecords = await Attendance.find({
      isHoliday: true,
      owner: req.employee.owner
    }).sort({ date: 1 });

    res.json(holidayRecords);
  } catch (err) {
    console.error("Fetch holidays failed:", err);
    res.status(500).json({ error: "Failed to fetch holiday records" });
  }
});

// GET /api/emp-attendance/absences-without-leave
router.get('/absences-without-leave', async (req, res) => {
  try {
    const employeeId = req.employee._id;
    const joiningDate = req.employee.joiningDate;
    const todayStr = new Date().toISOString().split('T')[0];
    
    // Find all absences for this employee that occurred BEFORE today
    // and ON OR AFTER their joining date
    const query = { 
      employee: employeeId, 
      status: 'Absent',
      date: { $lt: todayStr }
    };
    
    if (joiningDate) {
      query.date.$gte = joiningDate;
    }
    
    const absentRecords = await Attendance.find(query).lean();

    // Find all leave applications for this employee (non-trashed)
    const Leave = require('../models/ApplyLeave');
    const leaveApplications = await Leave.find({ 
      employee: employeeId,
      isTrashed: { $ne: true }
    }).lean();

    // Filter out absences that have a corresponding leave application
    const unexplainedAbsences = absentRecords.filter(record => {
      // The attendance record date is a string "YYYY-MM-DD"
      const recordDateStr = record.date; 
      
      // Check if any leave application covers this date
      return !leaveApplications.some(app => {
        return app.dates && app.dates.some(d => {
          if (!d.date) return false;
          // Normalize the date from the leave application to "YYYY-MM-DD" string
          const appDate = new Date(d.date);
          // Use YYYY-MM-DD format (year-month-day) which matches recordDateStr
          // en-CA locale gives YYYY-MM-DD
          const appDateStr = appDate.toISOString().split('T')[0];
          
          return appDateStr === recordDateStr;
        });
      });
    });

    res.json(unexplainedAbsences);
  } catch (err) {
    console.error("Fetch unexplained absences failed:", err);
    res.status(500).json({ error: "Failed to fetch unexplained absences" });
  }
});


module.exports = router;
