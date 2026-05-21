const express = require('express');
const router = express.Router();
const Attendance = require('../models/Attendance');
const { upload } = require('../utils/multer');

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
    const today = new Date();
    const todayStr = today.toISOString().split('T')[0];
    
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(today.getDate() - 7);
    const sevenDaysAgoStr = sevenDaysAgo.toISOString().split('T')[0];
    
    console.log('[DEBUG] Checking absences for employee:', employeeId, 'Name:', req.employee.name);
    
    const includeToday = req.query.includeToday === 'true';

    // Find all absences or half days for this employee that occurred in the last 7 days
    // and ON OR AFTER their joining date
    const query = {
      employee: employeeId,
      status: { $in: ['Absent', 'Abscent', 'Half Day', 'halfday', 'half-day', 'Half-Day'] },
      date: { $lt: todayStr, $gte: sevenDaysAgoStr }
    };
    
    if (joiningDate && joiningDate > sevenDaysAgoStr) {
      query.date.$gte = joiningDate;
    }
    
    console.log('[DEBUG] Query:', JSON.stringify(query));
    
    let absentRecords = await Attendance.find(query).lean();
    console.log('[DEBUG] Found absent records:', absentRecords.length, absentRecords.map(r => ({ date: r.date, status: r.status })));

    // After 6 PM: also check today's half-day (not absent — it's still the same day)
    if (includeToday) {
      const todayHalfDay = await Attendance.find({
        employee: employeeId,
        status: { $in: ['Half Day', 'halfday', 'half-day', 'Half-Day'] },
        date: todayStr,
        acknowledgedByEmployee: { $ne: true }
      }).lean();
      absentRecords = [...absentRecords, ...todayHalfDay];
    }

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

    // Deduplicate by date to ensure the user isn't asked to justify the same date multiple times
    const uniqueAbsences = [];
    const seenDates = new Set();
    
    for (const record of unexplainedAbsences) {
      if (!seenDates.has(record.date)) {
        seenDates.add(record.date);
        uniqueAbsences.push(record);
      }
    }

    console.log('[DEBUG] Unique unexplained absences:', uniqueAbsences.length);
    res.json(uniqueAbsences);
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
    res.status(500).json({ error: "Failed to acknowledge absence" });
  }
});

// POST /api/emp-attendance/challenge
// Employee challenges an attendance record for a specific date
router.post('/challenge', upload.single('attachment'), async (req, res) => {
  try {
    const { date, reason, requestedStatus } = req.body;
    const employeeId = req.employee._id;
    const ownerId = req.employee.owner;
    const challengeAttachment = req.file ? req.file.filename : undefined;

    if (!date || !reason) {
      return res.status(400).json({ error: "Date and reason are required" });
    }

    // Find or create the attendance record for this date
    // If it doesn't exist, we create an "Absent" record that is challenged
    let attendance = await Attendance.findOne({
      employee: employeeId,
      date: date,
      owner: ownerId,
    });

    if (attendance && ['Pending', 'Approved', 'Rejected'].includes(attendance.challengeStatus)) {
      return res.status(400).json({ error: "An attendance query for this date already exists." });
    }

    if (!attendance) {
      attendance = new Attendance({
        employee: employeeId,
        date: date,
        owner: ownerId,
        status: 'Absent', // Default to absent if no record exists
        markedByHR: false
      });
    }

    // Update challenge fields
    attendance.challengeStatus = 'Pending';
    attendance.challengeReason = reason;
    if (requestedStatus) {
      attendance.requestedStatus = requestedStatus;
    }
    attendance.challengeAt = new Date();
    if (challengeAttachment) {
      attendance.challengeAttachment = challengeAttachment;
    }
    
    await attendance.save();

    // Notify owner and supervisor via socket
    if (req.app.get("io")) {
      const io = req.app.get("io");
      const populatedAttendance = await Attendance.findById(attendance._id)
        .populate("employee", "name employeeId department photographUrl")
        .lean();

      const notificationData = {
        attendance: populatedAttendance,
        message: `${req.employee.name} has challenged attendance for ${date}`,
        type: "attendance_query"
      };

      // Notify Owner
      if (ownerId) {
        io.to(`employee_${ownerId}`).emit("new_attendance_query", notificationData);
      }

      // Notify Supervisor if different from owner
      if (req.employee.supervisor && String(req.employee.supervisor) !== String(ownerId)) {
        io.to(`employee_${req.employee.supervisor}`).emit("new_attendance_query", notificationData);
      }
    }

    console.log(`✅ Attendance on ${date} challenged by employee ${employeeId}. Reason: ${reason}`);
    
    res.json({
      success: true,
      message: "Attendance challenged successfully. Awaiting review.",
      attendance: {
        date: attendance.date,
        challengeStatus: attendance.challengeStatus,
        challengeReason: attendance.challengeReason,
        challengeAttachment: attendance.challengeAttachment
      }
    });
  } catch (err) {
    console.error("❌ Challenge attendance failed:", err);
    res.status(500).json({ error: "Failed to challenge attendance" });
  }
});

// POST /api/emp-attendance/challenge/:id/withdraw
// Employee withdraws a pending attendance challenge
router.post('/challenge/:id/withdraw', async (req, res) => {
  try {
    const { id } = req.params;
    const employeeId = req.employee._id;

    const attendance = await Attendance.findOne({
      _id: id,
      employee: employeeId,
      challengeStatus: 'Pending'
    });

    if (!attendance) {
      return res.status(404).json({ error: "Pending attendance challenge not found" });
    }

    attendance.challengeStatus = 'Withdrawn';
    // We keep challengeReason and challengeAt intact for history
    
    await attendance.save();

    console.log(`✅ Attendance challenge on ${attendance.date} withdrawn by employee ${employeeId}.`);
    
    res.json({
      success: true,
      message: "Attendance challenge withdrawn successfully.",
      attendance: {
        _id: attendance._id,
        date: attendance.date,
        challengeStatus: attendance.challengeStatus,
        challengeReason: attendance.challengeReason
      }
    });
  } catch (err) {
    console.error("❌ Withdraw attendance challenge failed:", err);
    res.status(500).json({ error: "Failed to withdraw attendance challenge" });
  }
});

// PUT /api/emp-attendance/challenge/:id
// Employee edits a pending attendance challenge
router.put('/challenge/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { reason, requestedStatus } = req.body;
    const employeeId = req.employee._id;

    if (!reason) {
      return res.status(400).json({ error: "Reason is required" });
    }

    const attendance = await Attendance.findOne({
      _id: id,
      employee: employeeId,
      challengeStatus: 'Pending'
    });

    if (!attendance) {
      return res.status(404).json({ error: "Pending attendance challenge not found" });
    }

    attendance.challengeReason = reason;
    if (requestedStatus) {
      attendance.requestedStatus = requestedStatus;
    }
    attendance.challengeAt = new Date();
    
    await attendance.save();

    console.log(`✅ Attendance challenge on ${attendance.date} updated by employee ${employeeId}.`);
    
    res.json({
      success: true,
      message: "Attendance challenge updated successfully.",
      attendance: {
        _id: attendance._id,
        date: attendance.date,
        challengeStatus: attendance.challengeStatus,
        challengeReason: attendance.challengeReason,
        requestedStatus: attendance.requestedStatus
      }
    });
  } catch (err) {
    console.error("❌ Update attendance challenge failed:", err);
    res.status(500).json({ error: "Failed to update attendance challenge" });
  }
});

// GET /api/emp-attendance/config
router.get('/config', async (req, res) => {
  try {
    const ownerId = req.employee.owner;
    
    // Find payroll period for non-working days
    const PayrollPeriod = require('../models/PayrollPeriod');
    const period = await PayrollPeriod.findOne({ owner: ownerId })
      .sort({ createdAt: -1 })
      .lean();
    
    // Find specific non-working days
    const SpecificNonWorkingDay = require('../models/SpecificNonWorkingDay');
    const specificNwds = await SpecificNonWorkingDay.find({ owner: ownerId }).lean();
    
    res.json({
      nonWorkingDays: period?.nonWorkingDays || [],
      specificNonWorkingDays: specificNwds.map(d => d.date)
    });
  } catch (err) {
    console.error("Fetch attendance config failed:", err);
    res.status(500).json({ error: "Failed to fetch attendance configuration" });
  }
});

module.exports = router;
