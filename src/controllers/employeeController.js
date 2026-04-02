// backend/src/controllers/employeeController.js
const dayjs = require("dayjs");
const Employee = require("../models/Employees");
const customParseFormat = require("dayjs/plugin/customParseFormat");
const utc = require("dayjs/plugin/utc");
const timezone = require("dayjs/plugin/timezone");

dayjs.extend(customParseFormat);
dayjs.extend(utc);
dayjs.extend(timezone);

function normalizeToCurrentYear(dateStr) {
  if (!dateStr) return null;

  let original = dayjs(dateStr, ["YYYY-MM-DD", "DD-MM-YYYY", "MM-DD-YYYY"]);
  if (!original.isValid()) return null;

  const today = dayjs();

  // ❌ If employee has not yet joined or DOB is in future → skip
  if (original.isAfter(today)) {
    return null;
  }

  const normalized = original.year(today.year());

  // If this year's event already passed → set to next year
  if (normalized.isBefore(today, "day")) {
    return normalized.add(1, "year");
  }

  return normalized;
}

// ---------------------------------------------
// Get Owner ID based on your existing logic
// ---------------------------------------------
function getEffectiveOwnerId(user) {
  if (!user) return null;
  // Prioritize .owner if it exists (set by our middleware)
  if (user.owner) return user.owner;
  if (user.role === "admin" && user.createdBy) {
    return user.createdBy;
  }
  return user._id;
}
// Helper: Compute next birthday as a dayjs object
function getNextBirthday(dob) {
  if (!dob) return null;
  let birth = dayjs(dob);
  if (!birth.isValid()) return null;
  const now = dayjs();
  let next = birth.year(now.year());
  if (next.isBefore(now, "day")) next = next.add(1, "year");
  return next;
}
function getNextAnniversary(joiningDate) {
  if (!joiningDate) return null;
  let join = dayjs(joiningDate);
  if (!join.isValid()) return null;
  const now = dayjs();
  let next = join.year(now.year());
  if (next.isBefore(now, "day")) next = next.add(1, "year");
  const yearsOfService = next.year() - join.year();
  return { nextAnniversary: next, yearsOfService };
}

// GET /api/employees
exports.getAllEmployees = async (req, res) => {
  try {
    const ownerId = getEffectiveOwnerId(req.user);
    const list = await Employee.find({ owner: { $in: [ownerId] } })
      .sort({ name: 1 })
      .populate("shifts", "name start end timezone")
      .lean();
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// GET /api/employees/list
exports.list = async (req, res) => {
  try {
    const ownerId = getEffectiveOwnerId(req.user);
    const emps = await Employee.find({ owner: { $in: [ownerId] } })
      .select("-owner")
      .populate("shifts", "name start end timezone")
      .sort({ name: 1 })
      .lean();
    res.json({ status: "success", data: emps });
  } catch (err) {
    console.error(err);
    res.status(500).json({ status: "error", message: err.message });
  }
};

// POST /api/employees
exports.createEmployee = async (req, res) => {
  try {
    const ownerId = getEffectiveOwnerId(req.user);
    const body = req.body;
    const emp = await Employee.create({
      owner: [ownerId],
      name: body.name,
      phone: body.phone,
      qualification: body.qualification,
      presentAddress: body.presentAddress,
      maritalStatus: body.maritalStatus,
      nomineeName: body.nomineeName,
      emergencyContact: body.emergencyContact,
      department: body.department,
      position: body.position,
      joiningDate: body.joiningDate,
      cnic: body.cnic,
      dateOfBirth: body.dateOfBirth,
      bankAccount: body.bankAccount,
      email: body.email,
      companyEmail: body.companyEmail,
      rt: body.rt,
      salaryOffered: body.salaryOffered,
      leaveEntitlement: body.leaveEntitlement,
    });
    await emp.save();
    res.status(201).json(emp);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

// PATCH /api/employees/:id
exports.updateEmployee = async (req, res) => {
  try {
    const ownerId = getEffectiveOwnerId(req.user);
    const emp = await Employee.findOneAndUpdate(
      { _id: req.params.id, owner: { $in: [ownerId] } },
      req.body,
      { new: true, runValidators: true }
    ).populate("shifts", "name");

    if (!emp) {
      return res
        .status(404)
        .json({ error: "Employee not found or unauthorized" });
    }
    res.json(emp);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
};

// GET /api/employees/birthdays
exports.getUpcomingBirthdays = async (req, res) => {
  try {
    const ownerId = getEffectiveOwnerId(req.user);
    const employees = await Employee.find({
      owner: { $in: [ownerId] },
      dateOfBirth: { $exists: true, $ne: null, $ne: "" },
      status: { $ne: "offboarded" }, // Exclude offboarded employees
      isTrashed: false, // Also exclude trashed employees
      $or: [
        { resignationDate: { $exists: false } },
        { resignationDate: null },
        { resignationDate: "" }
      ], // Exclude employees in notice period (resigned)
    }).select("name dateOfBirth photographUrl email status");

    const now = dayjs();
    const upcoming = employees
      .map((emp) => {
        const nextBirthday = getNextBirthday(emp.dateOfBirth);
        return nextBirthday ? { ...emp.toObject(), nextBirthday } : null;
      })
      .filter(Boolean)
      .filter((e) => {
        const days = e.nextBirthday.diff(now, "day");
        return days >= 0 && days <= 30;
      })
      .sort((a, b) => a.nextBirthday.diff(b.nextBirthday));

    res.json(upcoming);
  } catch (err) {
    console.error("Error in getUpcomingBirthdays:", err);
    res
      .status(500)
      .json({ error: "Could not fetch birthdays: " + err.message });
  }
};

exports.getUpcomingAnniversaries = async (req, res) => {
  try {
    const ownerId = getEffectiveOwnerId(req.user); // <-- Correct owner ID

    const today = dayjs();
    const next30 = today.add(30, "day");

    const emps = await Employee.find({
      owner: { $in: [ownerId] },
      status: { $ne: "offboarded" },
      isTrashed: false,
      $or: [
        { resignationDate: { $exists: false } },
        { resignationDate: null },
        { resignationDate: "" }
      ], // Exclude employees in notice period (resigned)
    }).select(
      "name dateOfBirth joiningDate department designation photographUrl email"
    );

    const result = [];

    emps.forEach((emp) => {
      // ------------------------------------------------------
      // 🎂 Birthday Anniversary
      // ------------------------------------------------------
      if (emp.dateOfBirth) {
        const upcoming = normalizeToCurrentYear(emp.dateOfBirth);

        if (upcoming && upcoming.isAfter(today) && upcoming.isBefore(next30)) {
          result.push({
            type: "birthday",
            ...emp.toObject(),
            upcomingDate: upcoming.format("YYYY-MM-DD"),
            daysLeft: upcoming.diff(today, "day"),
          });
        }
      }

      // ------------------------------------------------------
      // 🏆 Work Anniversary
      // ------------------------------------------------------
      if (emp.joiningDate) {
        const joining = dayjs(emp.joiningDate);

        // ❌ If joining date is in future → skip
        if (joining.isAfter(today)) {
          return;
        }

        const upcoming = normalizeToCurrentYear(emp.joiningDate);

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

    // Sort by nearest upcoming
    result.sort((a, b) => a.daysLeft - b.daysLeft);

    res.json({
      status: "success",
      count: result.length,
      anniversaries: result,
    });
  } catch (err) {
    console.error("Error fetching anniversaries", err);
    res.status(500).json({
      status: "error",
      message: "Internal server error",
    });
  }
};

exports.updateEmployeeRole = async (req, res) => {
  try {
    const { id } = req.params;
    const { role } = req.body;

    if (!role) {
      return res.status(400).json({ message: "Role is required" });
    }

    const employee = await Employee.findByIdAndUpdate(
      id,
      { role },
      { new: true }
    );
    if (!employee)
      return res.status(404).json({ message: "Employee not found" });

    res.status(200).json({ message: "Role updated successfully", employee });
  } catch (error) {
    console.error("Error updating role:", error);
    res.status(500).json({ message: "Failed to update employee role" });
  }
};
// controllers/employeeController.js - Add these methods
/**
 * UPDATE employee permissions
 */
exports.updateEmployeePermissions = async (req, res) => {
  try {
    const { permissions } = req.body;
    const employeeId = req.params.id;
    const userId = req.user._id;

    const employee = await Employee.findOne({
      _id: employeeId,
      owner: req.user._id,
    });

    if (!employee) {
      return res.status(404).json({ message: "Employee not found" });
    }

    // Update permissions
    employee.permissions = {
      ...permissions,
      grantedBy: userId,
      grantedAt: new Date(),
      updatedBy: userId,
      updatedAt: new Date(),
    };

    await employee.save();

    res.json({
      success: true,
      data: {
        employee: {
          _id: employee._id,
          name: employee.name,
          permissions: employee.permissions,
        },
      },
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

/**
 * GET employee permissions
 */
exports.getEmployeePermissions = async (req, res) => {
  try {
    const employee = await Employee.findOne({
      _id: req.params.id,
      owner: req.user._id,
    }).select("permissions name email");

    if (!employee) {
      return res.status(404).json({ message: "Employee not found" });
    }

    res.json({
      success: true,
      data: {
        permissions: employee.permissions,
        name: employee.name,
        email: employee.email,
      },
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

/**
 * Bulk Resign employees
 */
exports.bulkResign = async (req, res) => {
  try {
    const { employeeIds, resignationDate, resignationReason, noticePeriod } = req.body;
    const ownerId = getEffectiveOwnerId(req.user);

    if (!Array.isArray(employeeIds) || employeeIds.length === 0) {
      return res.status(400).json({ message: "No employees selected" });
    }

    const noticePeriodDays = noticePeriod || 30;

    // Simple helper inside since we need it for bulk
    const calculateNoticeEndDate = (dateStr, days) => {
      const date = new Date(dateStr);
      date.setDate(date.getDate() + days);
      return date.toISOString().split("T")[0];
    };

    const noticePeriodEndDate = calculateNoticeEndDate(resignationDate, noticePeriodDays);

    const updateData = {
      status: "resigned",
      resignationDate,
      resignationReason: resignationReason || "",
      noticePeriodEndDate,
      leavingDate: noticePeriodEndDate,
    };

    const result = await Employee.updateMany(
      {
        _id: { $in: employeeIds },
        $or: [
          { owner: ownerId },
          { createdBy: ownerId }
        ]
      },
      { $set: updateData }
    );

    res.json({
      status: "success",
      message: `${result.modifiedCount} employees marked as resigned`,
      data: result,
    });
  } catch (err) {
    console.error("Bulk resign error:", err);
    res.status(500).json({ status: "error", message: err.message });
  }
};

/**
 * Bulk Activate employees
 */
exports.bulkActivate = async (req, res) => {
  try {
    const { employeeIds } = req.body;
    const ownerId = getEffectiveOwnerId(req.user);

    if (!Array.isArray(employeeIds) || employeeIds.length === 0) {
      return res.status(400).json({ message: "No employees selected" });
    }

    const updateData = {
      status: "active",
      resignationDate: null,
      noticePeriodEndDate: null,
      resignationReason: null,
      leavingDate: null,
      terminationDate: null,
    };

    const result = await Employee.updateMany(
      {
        _id: { $in: employeeIds },
        $or: [
          { owner: ownerId },
          { createdBy: ownerId }
        ]
      },
      { $set: updateData }
    );

    res.json({
      status: "success",
      message: `${result.modifiedCount} employees activated successfully`,
      data: result,
    });
  } catch (err) {
    console.error("Bulk activate error:", err);
    res.status(500).json({ status: "error", message: err.message });
  }
};

/**
 * Auto-offboard employees whose notice period has ended
 */
exports.autoOffboardEmployees = async (req, res) => {
  try {
    const ownerId = getEffectiveOwnerId(req.user);
    const today = dayjs().format("YYYY-MM-DD");

    const result = await Employee.updateMany(
      {
        owner: { $in: [ownerId] },
        status: "resigned",
        noticePeriodEndDate: { $lte: today },
        isTrashed: false,
      },
      {
        $set: {
          status: "offboarded",
        },
      }
    );

    res.json({
      status: "success",
      message: `Auto-offboarded ${result.modifiedCount} employees`,
      data: { modifiedCount: result.modifiedCount },
    });
  } catch (err) {
    console.error("Auto-offboard error:", err);
    res.status(500).json({ status: "error", message: err.message });
  }
};