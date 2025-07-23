// backend/src/controllers/attendanceController.js
const Attendance = require('../models/Attendance');
const mongoose = require('mongoose');
const { backfillForDate } = require('../backfillAttendance');
const { updateLeaveEntitlementForEmployee } = require('../utils/leaveEntitlement');
const { decrypt, encrypt } = require("../utils/encryption");

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

    // UNIVERSAL: Load all required models/helpers ONCE
    const Employee = require('../models/Employees');
    const PayrollPeriod = require('../models/PayrollPeriod');
    const SalarySlip = require('../models/SalarySlip');
    const { decrypt, encrypt } = require("../utils/encryption");

    const updateDoc = {
      $set: {
        owner: ownerId,
        employee: employeeId,
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

    // --- Deduction Logic (Both Leave & Late) ---
    // 1. Get employee info
    const employee = await Employee.findById(employeeId).lean();

    // 2. Find payroll period (always for the current date)
    let periodStart, periodEnd, start, end;
    if (employee) {
      const allPayrolls = await PayrollPeriod.find({ owner: employee.owner }).lean();
      const shiftId = employee.shifts?.[0];
      const payroll = allPayrolls.find(
        p => Array.isArray(p.shifts) && p.shifts.map(String).includes(String(shiftId))
      );
      if (payroll) {
        const now = new Date();
        const anchor = new Date(payroll.payrollPeriodStartDay);
        if (payroll.payrollPeriodType === "monthly") {
          const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), anchor.getDate());
          if (now >= thisMonthStart) {
            periodStart = thisMonthStart;
          } else {
            periodStart = new Date(now.getFullYear(), now.getMonth() - 1, anchor.getDate());
          }
          periodEnd = new Date(periodStart.getFullYear(), periodStart.getMonth() + 1, periodStart.getDate());
          periodEnd.setDate(periodEnd.getDate() - 1);
        } else {
          let length = payroll.payrollPeriodLength;
          if (payroll.payrollPeriodType === "weekly") length = 7;
          if (payroll.payrollPeriodType === "bimonthly") length = 15;
          if (payroll.payrollPeriodType === "10-days") length = 10;
          let diff = Math.floor((now - anchor) / (1000 * 60 * 60 * 24));
          let cycles = Math.floor(diff / length);
          periodStart = new Date(anchor);
          periodStart.setDate(anchor.getDate() + cycles * length);
          periodEnd = new Date(periodStart);
          periodEnd.setDate(periodStart.getDate() + length - 1);
        }
        start = periodStart.toISOString().slice(0, 10);
        end = periodEnd.toISOString().slice(0, 10);

        // 3. Fetch or create salary slip for this period
        let slip = await SalarySlip.findOne({
          employee: employeeId,
          createdAt: { $gte: new Date(start), $lte: new Date(end) }
        });
        if (!slip) {
          slip = await SalarySlip.create({
            employee: employeeId,
            grossSalary: "" // blank for now if doesn't exist
          });
        }

        // 4. Get gross salary (decrypt if available), perDay
        let grossSalary = 0;
        if (slip.grossSalary) {
          grossSalary = Number(await decrypt(slip.grossSalary));
        }
        const totalWorkingDays = 22; // Can be adjusted
        const perDay = grossSalary / totalWorkingDays;

        // --- LEAVE DEDUCTION ---
        if (status === "Absent") {
          await updateLeaveEntitlementForEmployee(employeeId);
          if (employee.leaveEntitlement) {
            const { total = 0, usedPaid = 0, usedUnpaid = 0 } = employee.leaveEntitlement;
            // Only run if latest absent is unpaid
            if ((total - usedPaid) < 1 && usedUnpaid > 0) {
              const leaveDeduction = Math.round(perDay * usedUnpaid);
              slip.leaveDeductions = await encrypt(leaveDeduction.toString());
              await slip.save();
            }
          }
        }

        // --- LATE DEDUCTION ---
        const lateRecords = await Attendance.find({
          employee: employeeId,
          date: { $gte: start, $lte: end },
          status: "Late"
        });
        const lateCount = lateRecords.length;
        const lateDeductionDays = Math.floor(lateCount / 3); // Every 3 lates = 1 day deduction
        const lateDeduction = Math.round(perDay * lateDeductionDays);
        slip.lateDeductions = await encrypt(lateDeduction.toString());
        await slip.save();

      }
    }

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
      owner: new mongoose.Types.ObjectId(req.user._id),
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
      owner: new mongoose.Types.ObjectId(req.user._id),
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