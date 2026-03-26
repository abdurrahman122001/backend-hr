const Employee            = require('./models/Employees');
const Attendance          = require('./models/Attendance');
const LeaveTransaction    = require('./models/LeaveTransaction');
const LeaveYearBalance    = require('./models/LeaveYearBalance');

async function backfillForDate(dateStr, ownerId) {
  const dateObj = new Date(dateStr);
  const year = dateObj.getFullYear();

  // 1) Get active employees
  const employees = await Employee.find(
    { owner: ownerId, status: 'active', isTrashed: false },
    '_id'
  ).lean();

  if (!employees.length) return 0;

  const allIds = employees.map(e => e._id.toString());

  // 2) Get existing attendance
  const existingAttendance = await Attendance.find(
    { date: dateStr, owner: ownerId },
    'employee'
  ).lean();

  const doneSet = new Set(
    existingAttendance
      .filter(r => r.employee)
      .map(r => r.employee.toString())
  );

  // 3) Find missing employees
  const missing = allIds.filter(id => !doneSet.has(id));
  if (!missing.length) return 0;

  // 4) Fetch or create LeaveYearBalance
  const balances = await LeaveYearBalance.find({
    owner: ownerId,
    employee: { $in: missing },
    year
  }).lean();

  const balanceMap = new Map(
    balances.map(b => [b.employee.toString(), b._id])
  );

  // Create missing balances
  const balanceCreates = [];
  for (const empId of missing) {
    if (!balanceMap.has(empId)) {
      balanceCreates.push({
        owner: ownerId,
        employee: empId,
        year
      });
    }
  }

  if (balanceCreates.length) {
    const newBalances = await LeaveYearBalance.insertMany(balanceCreates, { ordered: false });
    newBalances.forEach(b => {
      balanceMap.set(b.employee.toString(), b._id);
    });
  }

  // 5) Create attendance docs
  const attendanceDocs = missing.map(empId => ({
    owner: ownerId,
    employee: empId,
    date: dateStr,
    status: 'Absent',
    checkIn: null,
    checkOut: null,
    notes: '',
    markedByHR: false,
  }));

  // 6) Insert attendance
  let insertedAttendance = [];
  try {
    insertedAttendance = await Attendance.insertMany(attendanceDocs, { ordered: false });
  } catch (err) {
    if (err.code !== 11000) throw err;

    // fallback: fetch what got inserted
    insertedAttendance = await Attendance.find({
      owner: ownerId,
      date: dateStr,
      employee: { $in: missing }
    });
  }

  if (!insertedAttendance.length) return 0;

  // 7) Prevent duplicate leave transactions
  const existingLeaveTx = await LeaveTransaction.find({
    sourceModel: "Attendance",
    sourceId: { $in: insertedAttendance.map(a => a._id) }
  }).select('sourceId').lean();

  const existingTxSet = new Set(
    existingLeaveTx.map(tx => tx.sourceId.toString())
  );

  // 8) Create Leave Transactions
  const leaveDocs = insertedAttendance
    .filter(att => !existingTxSet.has(att._id.toString()))
    .map(att => ({
      owner: ownerId,
      employee: att.employee,
      leaveYearBalance: balanceMap.get(att.employee.toString()),
      year,
      date: dateObj,
      type: "UNPAID_LEAVE_USED",
      value: 1,
      sourceModel: "Attendance",
      sourceId: att._id,
      reason: "Auto-marked absent by system",
    }));

  if (leaveDocs.length) {
    try {
      await LeaveTransaction.insertMany(leaveDocs, { ordered: false });
    } catch (err) {
      if (err.code !== 11000) throw err;
    }
  }

  return insertedAttendance.length;
}

module.exports = { backfillForDate };