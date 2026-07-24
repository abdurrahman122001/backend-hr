/**
 * Delete 2026 attendance for non-attendance employees.
 *
 * Removes every Attendance record dated in the target year (default 2026) that
 * belongs to an employee flagged `isNonAttendanceEmployee: true`.
 *
 * Usage:
 *   node src/deleteNonAttendance2026.js            # deletes year 2026
 *   node src/deleteNonAttendance2026.js 2027       # deletes a different year
 *   node src/deleteNonAttendance2026.js 2026 --dry # preview only, no deletion
 */
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const mongoose = require("mongoose");
const Employee = require("./models/Employees");
const Attendance = require("./models/Attendance");

const YEAR = Number(process.argv[2]) || 2026;
const DRY_RUN = process.argv.includes("--dry");

async function run() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error("❌ Missing MONGODB_URI in environment.");
    process.exit(1);
  }

  mongoose.set("strictQuery", false);
  await mongoose.connect(uri, { useNewUrlParser: true, useUnifiedTopology: true });
  console.log(`✅ Connected to MongoDB`);

  // 1) All employees flagged as non-attendance.
  const employees = await Employee.find({ isNonAttendanceEmployee: true })
    .select("_id name companyEmail")
    .lean();
  const employeeIds = employees.map((e) => e._id);

  console.log(
    `👥 Found ${employees.length} non-attendance employee(s):`,
    employees.map((e) => e.name || e.companyEmail || String(e._id)).join(", ") || "(none)"
  );

  if (employeeIds.length === 0) {
    console.log("Nothing to do — no employees have isNonAttendanceEmployee: true.");
    await mongoose.disconnect();
    return;
  }

  // 2) Attendance for those employees within the target year.
  //    `date` is a "YYYY-MM-DD" string, so a lexicographic range covers the year
  //    (and also any full-ISO date strings that may exist).
  const filter = {
    employee: { $in: employeeIds },
    date: { $gte: `${YEAR}-01-01`, $lt: `${YEAR + 1}-01-01` },
  };

  const count = await Attendance.countDocuments(filter);
  console.log(`📅 ${count} attendance record(s) match year ${YEAR} for these employees.`);

  if (DRY_RUN) {
    console.log("🔎 Dry run — no records deleted.");
  } else if (count > 0) {
    const result = await Attendance.deleteMany(filter);
    console.log(`🗑️  Deleted ${result.deletedCount} attendance record(s) for ${YEAR}.`);
  } else {
    console.log("Nothing to delete.");
  }

  await mongoose.disconnect();
  console.log("✅ Done.");
}

run().catch(async (err) => {
  console.error("❌ Error:", err);
  try {
    await mongoose.disconnect();
  } catch {}
  process.exit(1);
});
