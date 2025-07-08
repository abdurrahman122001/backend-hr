// backend/src/controllers/attendanceController.js
const Attendance = require('../models/Attendance');
const mongoose  = require('mongoose');
const { backfillForDate } = require('../backfillAttendance');

// POST /api/attendance
exports.markAttendance = async (req, res) => {
  try {
    const ownerId = req.user._id;
    const {
      employeeId,
      date,
      status,
      checkIn,
      checkOut,
      notes,
      leaveType
    } = req.body;

    const updateDoc = {
      $set: {
        owner:      ownerId,
        employee:   employeeId,
        date,
        status,
        checkIn,
        checkOut,
        notes,
        markedByHR: true
      }
    };

    if (status === 'Absent') {
      updateDoc.$set.leaveType = leaveType || 'Unpaid';
    } else {
      updateDoc.$unset = { leaveType: "" };
    }

    const rec = await Attendance.findOneAndUpdate(
      { owner: ownerId, employee: employeeId, date },
      updateDoc,
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    res.json(rec);
  } catch (err) {
    console.error("Error in markAttendance:", err);
    res.status(400).json({ error: err.message });
  }
};

// GET /api/attendance?date=YYYY-MM-DD
exports.getRecordsByDate = async (req, res) => {
  const { date } = req.query;
  if (!date) {
    return res.status(400).json({ error: 'date query parameter is required' });
  }
  try {
    await backfillForDate(date, req.user._id);

    const records = await Attendance.find({
      owner: new mongoose.Types.ObjectId(req.user._id),
      date
    })
      .populate('employee', 'name designation department email')
      .lean();

    res.json(records);
  } catch (err) {
    console.error('Error in getRecordsByDate:', err);
    res.status(500).json({ error: err.message });
  }
};

// GET /api/attendance?from=YYYY-MM-DD&to=YYYY-MM-DD
exports.getRecordsByDateRange = async (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) {
    return res.status(400).json({ error: "Both 'from' and 'to' are required" });
  }
  try {
    const records = await Attendance.find({
      owner: new mongoose.Types.ObjectId(req.user._id),
      date: { $gte: from, $lte: to }
    })
      .populate('employee', 'name position department')
      .lean();

    res.json(records);
  } catch (err) {
    console.error("Error in getRecordsByDateRange:", err);
    res.status(500).json({ error: err.message });
  }
};

// GET /api/attendance/stats?date=YYYY-MM-DD
exports.getStats = async (req, res) => {
  try {
    const { date } = req.query;
    const stats = await Attendance.aggregate([
      {
        $match: {
          owner: new mongoose.Types.ObjectId(req.user._id),
          date
        }
      },
      { $group: { _id: '$status', count: { $sum: 1 } } }
    ]);

    const result = { present: 0, late: 0, halfDay: 0, absent: 0, total: 0 };
    stats.forEach(({ _id, count }) => {
      const key = _id === 'Half Day' ? 'halfDay' : _id.toLowerCase();
      result[key] = count;
      result.total += count;
    });

    res.json(result);
  } catch (err) {
    console.error("Error in getStats:", err);
    res.status(500).json({ error: err.message });
  }
};

// GET /api/attendance/employee/:id
exports.getRecordsByEmployee = async (req, res) => {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) {
    return res.status(400).json({ error: 'Invalid employee ID' });
  }
  try {
    const records = await Attendance.find({
      owner:    new mongoose.Types.ObjectId(req.user._id),
      employee: new mongoose.Types.ObjectId(id)
    })
      .sort('date')
      .populate('employee', 'name position department')
      .lean();

    res.json(records);
  } catch (err) {
    console.error("Error in getRecordsByEmployee:", err);
    res.status(500).json({ error: err.message });
  }
};

// GET /api/attendance/employee/:id/stats?from=...&to=...
exports.getStatsByEmployee = async (req, res) => {
  const { id } = req.params;
  const { from, to } = req.query;
  if (!mongoose.isValidObjectId(id)) {
    return res.status(400).json({ error: 'Invalid employee ID' });
  }
  try {
    const match = {
      owner:    new mongoose.Types.ObjectId(req.user._id),
      employee: new mongoose.Types.ObjectId(id)
    };
    if (from && to) {
      match.date = { $gte: from, $lte: to };
    }

    const stats = await Attendance.aggregate([
      { $match: match },
      { $group: { _id: '$status', count: { $sum: 1 } } }
    ]);

    const result = { present: 0, late: 0, halfDay: 0, absent: 0, total: 0 };
    stats.forEach(({ _id, count }) => {
      const key = _id === 'Half Day' ? 'halfDay' : _id.toLowerCase();
      result[key] = count;
      result.total += count;
    });

    res.json(result);
  } catch (err) {
    console.error("Error in getStatsByEmployee:", err);
    res.status(500).json({ error: err.message });
  }
};
exports.deleteRecord = async (req, res) => {
  const { id } = req.params;
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(400).json({ error: 'Invalid record ID' });
  }
  try {
    const deleted = await Attendance.findOneAndDelete({
      _id: id,
      owner: req.user._id
    });
    if (!deleted) {
      return res.status(404).json({ error: 'Record not found' });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Error in deleteRecord:', err);
    res.status(500).json({ error: err.message });
  }
};