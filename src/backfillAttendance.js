// backend/src/utils/backfillAttendance.js
const Employee   = require('./models/Employees');
const Attendance = require('./models/Attendance');

/**
 * Inserts a “Pending” attendance row for every employee
 * who doesn’t already have one on the given date.
 * Idempotent: if nothing is missing, it won’t insert duplicates.
 */
async function backfillForDate(dateStr) {
  // 1) Grab all employee IDs
  const employees = await Employee.find({}, '_id').lean();
  const allIds    = employees.map(e => e._id.toString());

  // 2) Find which ones already have a record
  const existing = await Attendance.find({ date: dateStr }, 'employee').lean();
  const doneSet  = new Set(existing.map(r => r.employee.toString()));

  // 3) Filter out the done ones
  const missing = allIds.filter(id => !doneSet.has(id));
  if (!missing.length) return 0;

  // 4) Build “Pending” docs
  const docs = missing.map(empId => ({
    employee: empId,
    date:     dateStr,
    status:   'Pending',
    checkIn:  null,
    checkOut: null,
    notes:    ''
  }));

  // 5) Bulk‐insert
  const inserted = await Attendance.insertMany(docs, { ordered: false });
  return inserted.length;
}

module.exports = { backfillForDate };
