const Employee = require("../models/Employees");
const dayjs = require("dayjs");

function normalizeToCurrentYear(dateStr) {
  if (!dateStr) return null;
  const original = dayjs(dateStr, ["YYYY-MM-DD", "DD-MM-YYYY", "MM-DD-YYYY"]);
  if (!original.isValid()) return null;
  return original.year(dayjs().year());
}

exports.getUpcomingAnniversaries = async (req, res) => {
  try {
    const ownerId = req.employee.owner;
    const today = dayjs();
    const next30 = today.add(30, "day");

    // ✅ Fetch all employees for this owner
    const emps = await Employee.find({
      owner: ownerId,
      status: { $ne: "offboarded" },
    }).select(
      "name dateOfBirth joiningDate department designation photographUrl"
    );

    const result = [];

    emps.forEach((emp) => {
      // ---------------------- ✅ Birthday Anniversary ----------------------
      if (emp.dateOfBirth) {
        const bday = normalizeToCurrentYear(emp.dateOfBirth);
        let upcoming = bday;
        if (bday && bday.isBefore(today, "day")) {
          upcoming = bday.add(1, "year");
        }
        if (upcoming && upcoming.isAfter(today) && upcoming.isBefore(next30)) {
          result.push({
            type: "birthday",
            ...emp.toObject(),
            upcomingDate: upcoming.format("YYYY-MM-DD"),
            daysLeft: upcoming.diff(today, "day"),
          });
        }
      }

      // ---------------------- ✅ Work Anniversary ----------------------
      if (emp.joiningDate) {
        const join = normalizeToCurrentYear(emp.joiningDate);
        let upcoming = join;
        if (join && join.isBefore(today, "day")) {
          upcoming = join.add(1, "year");
        }
        if (upcoming && upcoming.isAfter(today) && upcoming.isBefore(next30)) {
          result.push({
            type: "work_anniversary",
            ...emp.toObject(),
            upcomingDate: upcoming.format("YYYY-MM-DD"),
            daysLeft: upcoming.diff(today, "day"),
          });
        }
      }
    });

    // ✅ Sort by closest date
    result.sort((a, b) => a.daysLeft - b.daysLeft);

    res.json({
      status: "success",
      count: result.length,
      anniversaries: result,
    });
  } catch (err) {
    console.error("Error fetching anniversaries", err);
    res.status(500).json({ status: "error", message: "Internal server error" });
  }
};
