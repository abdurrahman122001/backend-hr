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
    
    console.log('[DEBUG] Checking absences for employee:', employeeId, 'Name:', req.employee.name);
    
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
    
    console.log('[DEBUG] Query:', JSON.stringify(query));
    
    const absentRecords = await Attendance.find(query).lean();
    console.log('[DEBUG] Found absent records:', absentRecords.length, absentRecords.map(r => ({ date: r.date, status: r.status })));

    // Find holidays for this owner to exclude from absences
    const holidayRecords = await Attendance.find({
      isHoliday: true,
      owner: req.employee.owner,
      date: { $lt: todayStr }
    }).select('date').lean();
    const holidayDates = new Set(holidayRecords.map(h => h.date));
    console.log('[DEBUG] Found holidays:', holidayDates.size);

    // Find all leave applications for this employee (non-trashed)
    const Leave = require('../models/ApplyLeave');
    const leaveApplications = await Leave.find({ 
      employee: employeeId,
      isTrashed: { $ne: true }
    }).lean();
    
    console.log('[DEBUG] Found leave applications:', leaveApplications.length);
    leaveApplications.forEach(app => {
      console.log('[DEBUG] Leave app dates:', app.dates?.map(d => d.date));
    });

    // Filter out absences that have a corresponding leave application, or are weekends/holidays, or have been acknowledged
    const unexplainedAbsences = absentRecords.filter(record => {
      // The attendance record date is a string "YYYY-MM-DD"
      const recordDateStr = record.date; 
      
      console.log('[DEBUG] Checking record date:', recordDateStr);

      // Skip if it's a holiday
      if (holidayDates.has(recordDateStr)) {
        console.log('[DEBUG] Record', recordDateStr, 'is a holiday - skipping');
        return false;
      }

      // Skip if it's a weekend (Saturday=6, Sunday=0)
      const recordDate = new Date(recordDateStr);
      const dayOfWeek = recordDate.getDay();
      if (dayOfWeek === 0 || dayOfWeek === 6) {
        console.log('[DEBUG] Record', recordDateStr, 'is a weekend - skipping');
        return false;
      }

      // Skip if already acknowledged by employee (unpaid acknowledgment)
      if (record.acknowledgedByEmployee) {
        console.log('[DEBUG] Record', recordDateStr, 'already acknowledged by employee - skipping');
        return false;
      }
      
      // Check if any leave application covers this date
      const hasLeave = leaveApplications.some(app => {
        return app.dates && app.dates.some(d => {
          if (!d.date) return false;
          // Normalize the date from the leave application to "YYYY-MM-DD" string
          const appDate = new Date(d.date);
          // Use YYYY-MM-DD format (year-month-day) which matches recordDateStr
          // en-CA locale gives YYYY-MM-DD
          const appDateStr = appDate.toISOString().split('T')[0];
          
          console.log('[DEBUG] Comparing:', appDateStr, '===', recordDateStr, '?', appDateStr === recordDateStr);
          
          return appDateStr === recordDateStr;
        });
      });
      
      console.log('[DEBUG] Record', recordDateStr, 'has leave?', hasLeave);
      
      return !hasLeave;
    });

    console.log('[DEBUG] Unexplained absences after filtering:', unexplainedAbsences.length);
    res.json(unexplainedAbsences);
  } catch (err) {
    console.error("[DEBUG] Fetch unexplained absences failed:", err);
    res.status(500).json({ error: "Failed to fetch unexplained absences" });
  }
});

// POST /api/emp-attendance/acknowledge-absence
// Employee acknowledges absence as unpaid - attendance stays as "Absent"
router.post('/acknowledge-absence', async (req, res) => {
  try {
    const { date, reason, isPaid } = req.body;
    const employeeId = req.employee._id;
    const ownerId = req.employee.owner;

    if (!date || !reason) {
      return res.status(400).json({ error: "Date and reason are required" });
    }

    // Find the attendance record for this date
    let attendance = await Attendance.findOne({
      employee: employeeId,
      date: date,
      owner: ownerId,
    });

    if (!attendance) {
      return res.status(404).json({ error: "Attendance record not found for this date" });
    }

    // Add acknowledgment note but keep status as "Absent"
    const acknowledgmentNote = `Employee acknowledged absence on ${date} as UNPAID. Reason: ${reason}`;
    
    attendance.notes = attendance.notes 
      ? `${attendance.notes}; ${acknowledgmentNote}`
      : acknowledgmentNote;
    
    // Mark as acknowledged by employee
    attendance.acknowledgedByEmployee = true;
    attendance.acknowledgedAt = new Date();
    attendance.acknowledgmentReason = reason;
    attendance.acknowledgmentType = 'unpaid';
    
    await attendance.save();

    console.log(`✅ Absence on ${date} acknowledged by employee ${employeeId} as unpaid. Status remains: ${attendance.status}`);
    
    res.json({
      success: true,
      message: "Absence acknowledged as unpaid. Attendance remains as Absent.",
      attendance: {
        date: attendance.date,
        status: attendance.status,
        notes: attendance.notes,
        acknowledgedByEmployee: attendance.acknowledgedByEmployee,
        acknowledgmentType: attendance.acknowledgmentType
      }
    });
  } catch (err) {
    console.error("❌ Acknowledge absence failed:", err);
    res.status(500).json({ error: "Failed to acknowledge absence" });
  }
});


module.exports = router;
