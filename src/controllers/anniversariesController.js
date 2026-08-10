const Employee = require("../models/Employees");
const dayjs = require("dayjs");

// ---------------------------------------------
// Normalize month/day to current year ONLY IF date <= today
// ---------------------------------------------
function normalizeToCurrentYear(dateStr) {
  if (!dateStr) return null;

  let original = dayjs(dateStr, ["YYYY-MM-DD", "DD-MM-YYYY", "MM-DD-YYYY"]);
  if (!original.isValid()) return null;

  const today = dayjs();

  // ❌ If employee has not yet joined → no anniversary.
  if (original.isAfter(today)) {
    return null;
  }

  // Set month/day to current year
  const normalized = original.year(today.year());

  // If this year's anniversary already passed → next year's event
  if (normalized.isBefore(today, "day")) {
    return normalized.add(1, "year");
  }

  return normalized;
}

exports.getUpcomingAnniversaries = async (req, res) => {
  try {
    const ownerId = req.employee.owner;
    const today = dayjs();
    const next30 = today.add(30, "day");

    const emps = await Employee.find({
      owner: ownerId,
      status: "active",
      isTrashed: { $ne: true },
      $or: [
        { resignationDate: { $exists: false } },
        { resignationDate: null },
        { resignationDate: "" }
      ],
    }).select("name dateOfBirth joiningDate department designation photographUrl status");

    const result = [];

    emps.forEach((emp) => {
      // ------------------------------------------------------
      // 🎂 Birthday Anniversary (includes TODAY)
      // ------------------------------------------------------
      if (emp.dateOfBirth) {
        const upcoming = normalizeToCurrentYear(emp.dateOfBirth);
        
        if (upcoming) {
          const daysLeft = upcoming.diff(today, "day");
          // Include today (daysLeft === 0) and upcoming within next 30 days
          if (daysLeft >= 0 && daysLeft <= 30) {
            result.push({
              type: "birthday",
              ...emp.toObject(),
              upcomingDate: upcoming.format("YYYY-MM-DD"),
              daysLeft: daysLeft
            });
          }
        }
      }

      // ------------------------------------------------------
      // 🏆 Work Anniversary (includes TODAY, but only once at
      // least 1 full year of service has been completed — the
      // day someone JOINS is not their 1st anniversary)
      // ------------------------------------------------------
      if (emp.joiningDate) {
        const joining = dayjs(emp.joiningDate, ["YYYY-MM-DD", "DD-MM-YYYY", "MM-DD-YYYY"]);

        // ❌ If joining date is in future → skip
        if (joining.isAfter(today)) {
          return;
        }

        const upcoming = normalizeToCurrentYear(emp.joiningDate);

        if (upcoming) {
          const anniversaryNumber = upcoming.year() - joining.year();

          // ❌ Same-year join with no rollover yet = the joining day itself, not a real anniversary
          if (anniversaryNumber < 1) {
            return;
          }

          const daysLeft = upcoming.diff(today, "day");
          // Include today (daysLeft === 0) and upcoming within next 30 days
          if (daysLeft >= 0 && daysLeft <= 30) {
            result.push({
              type: "work_anniversary",
              ...emp.toObject(),
              upcomingDate: upcoming.format("YYYY-MM-DD"),
              daysLeft: daysLeft,
              anniversaryNumber
            });
          }
        }
      }
    });

    // Sort by upcoming date
    result.sort((a, b) => a.daysLeft - b.daysLeft);

    res.json({
      status: "success",
      count: result.length,
      anniversaries: result
    });

  } catch (err) {
    console.error("Error fetching anniversaries", err);
    res.status(500).json({ status: "error", message: "Internal server error" });
  }
};
