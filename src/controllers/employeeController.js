// backend/src/controllers/employeeController.js
const dayjs = require("dayjs");
const Employee = require("../models/Employees");
const customParseFormat = require("dayjs/plugin/customParseFormat");
const utc = require("dayjs/plugin/utc");
const timezone = require("dayjs/plugin/timezone");


dayjs.extend(customParseFormat);
dayjs.extend(utc);
dayjs.extend(timezone);

// Helper: Get the "owner" id for data isolation
function getEffectiveOwnerId(user) {
  // If user is an admin created by another admin, return createdBy
  if (user.role === "admin" && user.createdBy) {
    return user.createdBy;
  }
  // Else use their own _id
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
      .populate("shifts", "name")
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
      .populate("shifts", "name")
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
    }).select("name dateOfBirth photographUrl email");

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
    const ownerId = getEffectiveOwnerId(req.user);

    const employees = await Employee.find({
      owner: { $in: [ownerId] },
      $or: [
        { joiningDate: { $exists: true, $ne: null, $ne: "" } },
        { dateOfJoining: { $exists: true, $ne: null, $ne: "" } },
      ],
    }).select("name joiningDate dateOfJoining photographUrl email");

    const today = dayjs().startOf("day");
    const end = today.add(7, "day");

    const upcoming = employees
      .map((e) => {
        const raw = (e.joiningDate || e.dateOfJoining || "").trim();
        if (!raw) return null;

        // ✅ Try multiple formats and trim
        let join =
          dayjs(raw, "YYYY-MM-DD", true) ||
          dayjs(raw, "DD-MM-YYYY", true) ||
          dayjs(raw);
        if (!join.isValid()) return null;

        // Construct this year's anniversary
        let anniversary = dayjs(`${today.year()}-${join.format("MM-DD")}`, "YYYY-MM-DD");

        // If anniversary passed this year, add 1 year
        if (anniversary.isBefore(today, "day")) {
          anniversary = anniversary.add(1, "year");
        }

        const diffDays = anniversary.diff(today, "day");
        const yearsOfService = today.year() - join.year();

        if (diffDays >= 0 && diffDays <= 7) {
          return {
            ...e.toObject(),
            nextAnniversary: anniversary,
            yearsOfService,
            daysLeft: diffDays,
          };
        }

        return null;
      })
      .filter(Boolean)
      .sort((a, b) => a.nextAnniversary.diff(b.nextAnniversary));

    console.log("Final upcoming anniversaries:", upcoming.length);
    res.status(200).json(upcoming);
  } catch (err) {
    console.error("Error in getUpcomingAnniversaries:", err);
    res.status(500).json({ error: "Could not fetch anniversaries: " + err.message });
  }
};

exports.updateEmployeeRole = async (req, res) => {
  try {
    const { id } = req.params;
    const { role } = req.body;

    if (!role) {
      return res.status(400).json({ message: "Role is required" });
    }

    const employee = await Employee.findByIdAndUpdate(id, { role }, { new: true });
    if (!employee) return res.status(404).json({ message: "Employee not found" });

    res.status(200).json({ message: "Role updated successfully", employee });
  } catch (error) {
    console.error("Error updating role:", error);
    res.status(500).json({ message: "Failed to update employee role" });
  }
};
