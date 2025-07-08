// backend/src/controllers/leaveController.js
const LeaveRequest = require('../models/Leaves');
const Attendance   = require('../models/Attendance');
const Employee     = require('../models/Employees');
const { eachDayOfInterval, format } = require('date-fns');

exports.requestLeave = async (req, res) => {
  try {
    const { employeeId, date, daysRequested, endDate } = req.body;
    const leave = await LeaveRequest.create({
      employee:     employeeId,
      date,
      daysRequested,
      endDate
    });
    res.json(leave);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

exports.listLeaves = async (req, res) => {
  try {
    const { status } = req.query;
    const filter = status ? { status } : {};
    const leaves = await LeaveRequest.find(filter)
      .populate('employee', 'name email leaveEntitlement')
      .lean();
    res.json(leaves);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.decideLeave = async (req, res) => {
  const { id }     = req.params;
  const { action } = req.body; // 'approve' | 'reject' | 'withdraw'

  // 1) Load the leave request
  const leave = await LeaveRequest.findById(id);
  if (!leave) return res.status(404).json({ error: 'Leave not found' });

  // 2) Update status
  if (action === 'approve') {
    leave.status     = 'Approved';
    leave.approvedAt = new Date();
  } else if (action === 'reject') {
    leave.status = 'Rejected';
  } else if (action === 'withdraw') {
    if (leave.status !== 'Approved') {
      return res
        .status(400)
        .json({ error: "Can only withdraw an already approved leave" });
    }
    leave.status = 'Withdrawn';
  } else {
    return res.status(400).json({ error: `Unknown action: ${action}` });
  }
  await leave.save();

  // 3) Load the employee
  const emp = await Employee.findById(leave.employee);
  if (!emp) return res.status(404).json({ error: 'Employee not found' });

  // 4) Adjust paid balance
  if (action === 'approve') {
    emp.leaveEntitlement.usedPaid += leave.daysRequested;
    await emp.save();
  }
  if (action === 'withdraw') {
    emp.leaveEntitlement.usedPaid -= leave.daysRequested;
    await emp.save();
  }

  // 5) Compute the date range
  const start = new Date(leave.date);
  const end   = leave.endDate;
  const days  = eachDayOfInterval({ start, end });

  // 6) Branch on action to update attendance
  let attendanceDocs = [];
  if (action === 'approve') {
    // upsert Paid‐leave records
    attendanceDocs = await Promise.all(
      days.map(day => {
        const iso = format(day, 'yyyy-MM-dd');
        return Attendance.findOneAndUpdate(
          { employee: emp._id, date: iso },
          {
            employee:   emp._id,
            date:       iso,
            status:     'Absent',
            leaveType:  'Paid',
            markedByHR: true,
          },
          { upsert: true, new: true }
        );
      })
    );
  } else if (action === 'withdraw') {
    // delete the Paid‐leave records we created
    const isos = days.map(d => format(d, 'yyyy-MM-dd'));
    attendanceDocs = await Attendance.deleteMany({
      employee: emp._id,
      date:     { $in: isos },
      leaveType:'Paid'
    });
  }
  // (on reject: do nothing)

  // 7) Return current state
  res.json({ leave, updatedEmployee: emp, attendance: attendanceDocs });
};
