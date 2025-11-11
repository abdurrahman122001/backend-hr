const Employee = require("../models/Employees");
const dayjs = require("dayjs");

// Used to replace year with current year for comparison
function normalizeToCurrentYear(dateStr) {
  if (!dateStr) return null;
  const original = dayjs(dateStr, ["YYYY-MM-DD", "DD-MM-YYYY", "MM-DD-YYYY"]);
  if (!original.isValid()) return null;

  return original.year(dayjs().year());
}

exports.getUpcomingAnniversaries = async (req, res) => {
  try {
    const ownerId = req.employee.owner; // ✅ comes from middleware
    const today = dayjs();
    const next30 = today.add(30, "day");

    // ✅ Fetch employees with same owner & having dateOfBirth
    const emps = await Employee.find({
      owner: ownerId,
      dateOfBirth: { $exists: true, $ne: "" },
      status: { $ne: "offboarded" }, // Exclude offboarded employees
    }).select("name dateOfBirth department designation photographUrl");

    const result = [];

    emps.forEach((emp) => {
      const normalized = normalizeToCurrentYear(emp.dateOfBirth);
      if (!normalized) return;

      // If birthday already passed this year → move to next year
      let upcoming = normalized;
      if (normalized.isBefore(today, "day")) {
        upcoming = normalized.add(1, "year");
      }

      // ✅ Check if within next 30 days
      if (upcoming.isAfter(today) && upcoming.isBefore(next30)) {
        result.push({
          ...emp.toObject(),
          upcomingDate: upcoming.format("YYYY-MM-DD"),
          daysLeft: upcoming.diff(today, "day"),
        });
      }
    });

    // Sort by closest
    result.sort((a, b) => a.daysLeft - b.daysLeft);

    res.json({
      status: "success",
      count: result.length,
      anniversaries: result,
    });
  } catch (err) {
    console.error("Error fetching upcoming anniversaries", err);
    res.status(500).json({
      status: "error",
      message: "Internal server error",
    });
  }
};
