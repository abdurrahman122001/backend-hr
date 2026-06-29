const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");

const Employee = require("../models/Employees");
const TrustedDevice = require("../models/TrustedDevice");
const {
  getUpcomingBirthdays,
  updateEmployeeRole,
  getUpcomingAnniversaries,
  getEmployeePermissions,
  updateEmployeePermissions,
  bulkResign,
  bulkActivate,
  autoOffboardEmployees,
} = require("../controllers/employeeController");
const upload = require("../middleware/upload");
const unifiedAuth = require("../middleware/unifiedAuth"); // Changed from auth
const requireAuth = unifiedAuth; // Alias for backward compatibility
const attendanceAuth = require("../middleware/attendanceAuth");

function getEffectiveOwnerId(user) {
  if (!user) return null;
  if (user.owner) return user.owner;
  if (user.role === "admin" || user.role === "super-admin") return user._id;
  return user.createdBy || user._id;
}

function buildEmployeeScope(user, includeTrashed = false) {
  if (!user) throw new Error("User context required");

  const tenantId = getEffectiveOwnerId(user);
  const userId = user._id;

  const ownershipScope = {
    $or: [
      { owner: tenantId },
      { owner: userId },
      { createdBy: tenantId },
      { createdBy: userId },
    ],
  };

  // Allow employees to see themselves
  if (user.isEmployee && user.employeeId) {
    ownershipScope.$or.push({ _id: user.employeeId });
  }

  const trashScope = includeTrashed
    ? { isTrashed: { $ne: false } }
    : { $or: [{ isTrashed: false }, { isTrashed: { $exists: false } }] };

  return {
    $and: [ownershipScope, trashScope],
  };
}


// ============================================
// Employee Routes
// ============================================

// Bulk Resign
router.post("/bulk/resign", requireAuth, bulkResign);

// Bulk Activate
router.post("/bulk/activate", requireAuth, bulkActivate);

// Auto-offboard
router.get("/auto-offboard", requireAuth, autoOffboardEmployees);

/**
 * GET /api/employees
 * Fetch employees with proper scope based on user type
 * Supports: trashed parameter
 */
router.get("/", unifiedAuth, async (req, res) => {
  try {
    const { trashed, department, role, search } = req.query;
    const includeTrashed = trashed === "true";

    if (!req.user || (!req.user._id && !req.user.owner)) {
      console.error("❌ No user context found");
      return res.status(401).json({
        status: "error",
        message: "Authentication required",
      });
    }

    // Build base scope
    const scope = buildEmployeeScope(req.user, includeTrashed);
    let query = { ...scope };

    // Add department filter
    if (department) {
      query.department = department;
    }

    // Add role filter
    if (role) {
      query.role = role;
    }

    // Add search filter
    if (search) {
      query.$and = query.$and || [];
      query.$and.push({
        $or: [
          { name: { $regex: search, $options: "i" } },
          { companyEmail: { $regex: search, $options: "i" } },
          { personalEmail: { $regex: search, $options: "i" } },
          { phone: { $regex: search, $options: "i" } },
        ],
      });
    }

    // Execute query
    const list = await Employee.find(query)
      .select("-password -__v") // Exclude sensitive fields
      .populate("shifts", "name")
      .sort({ name: 1 })
      .lean();

    // DO NOT auto-generate employeeId here - it will be generated when employee sets password

    res.json({
      status: "success",
      data: list,
      count: list.length,
    });
  } catch (err) {
    console.error("❌ [GET /employees Error]:", err);
    res.status(500).json({
      status: "error",
      message: err.message,
      stack: process.env.NODE_ENV === "development" ? err.stack : undefined,
    });
  }
});

router.get("/attendance", attendanceAuth, async (req, res) => {
  try {
    const { trashed, includeOffboarded } = req.query;
    const includeTrashed = trashed === "true";
    const showOffboarded = includeOffboarded === "true";

    const scope = buildEmployeeScope(req.user, includeTrashed);
    const query = { ...scope };

    // If not including offboarded, filter by status
    if (!showOffboarded) {
      query.status = { $nin: ["offboarded", "resigned", "terminated"] };
    }

    const list = await Employee.find(query).sort({ name: 1 }).lean();
    res.json({ status: "success", data: list });
  } catch (err) {
    res.status(500).json({ status: "error", message: err.message });
  }
});

// ------------------------------
// GET /api/employees/birthdays
// (delegates to controller)
// ------------------------------
router.get("/birthdays", requireAuth, getUpcomingBirthdays);
router.get("/anniversaries", requireAuth, getUpcomingAnniversaries);

// ------------------------------
// GET /api/employees/names
// Minimal payload (id + name) with the same scope
// ------------------------------
router.get("/names", requireAuth, async (req, res) => {
  try {
    const scope = buildEmployeeScope(req.user);
    const docs = await Employee.find(scope)
      .sort({ name: 1 })
      .select("_id name")
      .lean();
    res.json({ status: "success", data: docs });
  } catch (err) {
    res.status(500).json({ status: "error", message: err.message });
  }
});

// ------------------------------
// POST /api/employees
// Create employee and record BOTH owner and createdBy
// (owner = effective tenant id, createdBy = current user id)
// ------------------------------
router.post("/", requireAuth, async (req, res) => {
  const {
    name,
    position,
    department,
    email,
    rt,
    salaryOffered,
    leaveEntitlement,
    photographUrl,
    // optional extras (kept for compatibility—send any that you use)
    phone,
    qualification,
    presentAddress,
    maritalStatus,
    nomineeName,
    emergencyContact,
    joiningDate,
    leavingDate, // NEW
    cnic,
    dateOfBirth,
    bankAccount,
    companyEmail,
    shifts, // optional: array of ObjectIds
    experiences, // NEW: Designation journey
  } = req.body;

  if (!name || !position || !department || !email) {
    return res
      .status(400)
      .json({ status: "error", message: "Missing required fields" });
  }

  try {
    const ownerId = getEffectiveOwnerId(req.user);

    // DO NOT auto-generate employeeId here - it will be generated when employee sets password
    const emp = await Employee.create({
      owner: [ownerId], // tenant/HR id (array as per your schema)
      createdBy: req.user._id, // who created this employee
      name,
      position,
      department,
      email,
      employeeId: "", // Will be generated on password set
      companyEmail,
      phone,
      qualification,
      presentAddress,
      maritalStatus,
      nomineeName,
      emergencyContact,
      joiningDate,
      leavingDate, // NEW: last working day
      cnic,
      dateOfBirth,
      bankAccount,
      rt,
      salaryOffered,
      leaveEntitlement,
      photographUrl,
      shifts,
      experiences: experiences || [], // NEW: Save experiences if provided
      isTrashed: false,
    });

    res.status(201).json({ status: "success", data: emp });
  } catch (err) {
    res.status(500).json({ status: "error", message: err.message });
  }
});

// ------------------------------
// GET /api/employees/list
// Same scope; includes shift names
// ------------------------------
router.get("/list", requireAuth, async (req, res) => {
  try {
    const scope = buildEmployeeScope(req.user);
    const emps = await Employee.find(scope)
      .select("-owner")
      .populate("shifts", "name")
      .sort({ name: 1 })
      .lean();

    // DO NOT auto-generate employeeId here - it will be generated when employee sets password

    res.json({ status: "success", data: emps });
  } catch (err) {
    res.status(500).json({ status: "error", message: err.message });
  }
});

// ------------------------------
// GET /api/employees/:id
// Scoped by owner OR createdBy
// ------------------------------
router.get("/:id", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res
        .status(400)
        .json({ status: "error", message: "Invalid employee id" });
    }

    const scope = buildEmployeeScope(req.user);
    const emp = await Employee.findOne({ _id: id, ...scope })
      .populate("shifts", "name")
      .lean();

    if (!emp) return res.status(404).json({ error: "Employee not found" });

    res.json({ status: "success", employee: emp });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ------------------------------
// PATCH /api/employees/:id
// Scoped update by owner OR createdBy
// ------------------------------
router.patch("/:id", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res
        .status(400)
        .json({ status: "error", message: "Invalid employee id" });
    }

    const scope = buildEmployeeScope(req.user);

    // If updating experiences, handle them properly
    if (req.body.experiences) {
      req.body.experiences = req.body.experiences.map((exp) => {
        // Add timestamps to new experiences
        if (!exp._id) {
          exp.createdAt = new Date();
          exp.updatedAt = new Date();

          // Add timestamps to positions
          exp.positions = exp.positions.map((pos) => {
            if (!pos._id) {
              pos.createdAt = new Date();
              pos.updatedAt = new Date();
            }
            return pos;
          });
        }
        return exp;
      });
    }

    const emp = await Employee.findOneAndUpdate(
      { _id: id, ...scope },
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
});

// ------------------------------
// PATCH /api/employees/:id/experiences
// Update only experiences array
// ------------------------------
router.patch("/:id/experiences", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { experiences } = req.body;

    if (!mongoose.isValidObjectId(id)) {
      return res
        .status(400)
        .json({ status: "error", message: "Invalid employee id" });
    }

    if (!Array.isArray(experiences)) {
      return res
        .status(400)
        .json({ status: "error", message: "Experiences must be an array" });
    }

    const scope = buildEmployeeScope(req.user);

    // Add timestamps to experiences
    const experiencesWithTimestamps = experiences.map((exp) => {
      // Keep existing timestamps for existing experiences
      if (exp._id) {
        exp.updatedAt = new Date();

        // Update timestamps for existing positions
        if (exp.positions) {
          exp.positions = exp.positions.map((pos) => {
            if (pos._id) {
              pos.updatedAt = new Date();
            } else {
              pos.createdAt = new Date();
              pos.updatedAt = new Date();
            }
            return pos;
          });
        }
      } else {
        // New experience
        exp.createdAt = new Date();
        exp.updatedAt = new Date();

        // Add timestamps to positions
        if (exp.positions) {
          exp.positions = exp.positions.map((pos) => {
            pos.createdAt = new Date();
            pos.updatedAt = new Date();
            return pos;
          });
        }
      }
      return exp;
    });

    const emp = await Employee.findOneAndUpdate(
      { _id: id, ...scope },
      { experiences: experiencesWithTimestamps },
      { new: true, runValidators: true }
    );

    if (!emp) {
      return res
        .status(404)
        .json({ error: "Employee not found or unauthorized" });
    }

    res.json({
      status: "success",
      message: "Experiences updated successfully",
      data: emp.experiences,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ------------------------------
// DELETE /api/employees/:id
// Move to trash instead of actual deletion
// ------------------------------
router.delete("/:id", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res
        .status(400)
        .json({ status: "error", message: "Invalid employee id" });
    }

    const scope = buildEmployeeScope(req.user);
    const emp = await Employee.findOneAndUpdate(
      { _id: id, ...scope },
      {
        isTrashed: true,
        trashedAt: new Date(),
        trashedBy: req.user._id,
      },
      { new: true }
    );

    if (!emp) {
      return res
        .status(404)
        .json({ error: "Employee not found or unauthorized" });
    }

    res.json({
      status: "success",
      message: "Employee moved to trash",
      data: emp,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ------------------------------
// POST /api/employees/:id/restore
// Restore from trash
// ------------------------------
router.post("/:id/restore", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res
        .status(400)
        .json({ status: "error", message: "Invalid employee id" });
    }

    // For restore, we need to find trashed employees specifically
    const ownerId = getEffectiveOwnerId(req.user);
    const userId = req.user?._id;

    const emp = await Employee.findOneAndUpdate(
      {
        _id: id,
        $or: [
          { owner: { $in: [ownerId, userId] } },
          { createdBy: { $in: [ownerId, userId] } },
        ],
        isTrashed: true,
      },
      {
        isTrashed: false,
        trashedAt: null,
        trashedBy: null,
      },
      { new: true }
    );

    if (!emp) {
      return res
        .status(404)
        .json({ error: "Trashed employee not found or unauthorized" });
    }

    res.json({
      status: "success",
      message: "Employee restored from trash",
      data: emp,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ------------------------------
// DELETE /api/employees/:id/permanent
// Permanent deletion (only for trashed items)
// ------------------------------
router.delete("/:id/permanent", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res
        .status(400)
        .json({ status: "error", message: "Invalid employee id" });
    }

    // For permanent delete, we need to find trashed employees specifically
    const ownerId = getEffectiveOwnerId(req.user);
    const userId = req.user?._id;

    const emp = await Employee.findOneAndDelete({
      _id: id,
      $or: [
        { owner: { $in: [ownerId, userId] } },
        { createdBy: { $in: [ownerId, userId] } },
      ],
      isTrashed: true,
    });

    if (!emp) {
      return res
        .status(404)
        .json({ error: "Trashed employee not found or unauthorized" });
    }

    res.json({
      status: "success",
      message: "Employee permanently deleted",
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ------------------------------
// GET /api/employees/trash/count
// Get count of trashed items
// ------------------------------
router.get("/trash/count", requireAuth, async (req, res) => {
  try {
    const ownerId = getEffectiveOwnerId(req.user);
    const userId = req.user?._id;

    const count = await Employee.countDocuments({
      $or: [
        { owner: { $in: [ownerId, userId] } },
        { createdBy: { $in: [ownerId, userId] } },
      ],
      isTrashed: true,
    });

    res.json({ status: "success", count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ------------------------------
// GET /api/employees/roles
// Get distinct roles
// ------------------------------
router.get("/roles", requireAuth, async (req, res) => {
  try {
    const scope = buildEmployeeScope(req.user);

    // Distinct roles only for employees within user's scope
    const roles = await Employee.distinct("role", {
      ...scope,
      role: { $ne: null },
    });

    const formatted = roles.map((r) => ({
      label: r,
      value: r,
    }));

    res.json({ status: "success", data: formatted });
  } catch (error) {
    console.error("Error fetching roles:", error);
    res.status(500).json({ status: "error", message: error.message });
  }
});

// PATCH /api/employees/:id/role
// Update employee role
// ------------------------------
router.patch("/:id/role", updateEmployeeRole);
router.put("/:id/permissions", requireAuth, updateEmployeePermissions);
router.get("/:id/permissions", requireAuth, getEmployeePermissions);

// ------------------------------
// Admin rights management (super-admin only)
// Sets employee.isAdmin so they can log into the admin dashboard
// using their existing company email + password.
// ------------------------------
function ensureSuperAdmin(req, res) {
  const role = String(req.user?.role || "").toLowerCase();
  if (req.user?.isEmployee || role !== "super-admin") {
    res.status(403).json({ error: "Only a super admin can manage admin rights" });
    return false;
  }
  return true;
}

// GET /api/employees/:id/admin-rights
router.get("/:id/admin-rights", requireAuth, async (req, res) => {
  try {
    if (!ensureSuperAdmin(req, res)) return;
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id))
      return res.status(400).json({ error: "Invalid employee ID" });
    const scope = buildEmployeeScope(req.user);
    const employee = await Employee.findOne({ _id: id, ...scope }).select("name isAdmin");
    if (!employee)
      return res.status(404).json({ error: "Employee not found or unauthorized" });
    res.json({ isAdmin: !!employee.isAdmin });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/employees/:id/admin-rights  { isAdmin: true|false }
router.patch("/:id/admin-rights", requireAuth, async (req, res) => {
  try {
    if (!ensureSuperAdmin(req, res)) return;
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id))
      return res.status(400).json({ error: "Invalid employee ID" });
    const grant = !!req.body.isAdmin;
    const scope = buildEmployeeScope(req.user);
    const employee = await Employee.findOneAndUpdate(
      { _id: id, ...scope },
      { isAdmin: grant },
      { new: true }
    ).select("name isAdmin");
    if (!employee)
      return res.status(404).json({ error: "Employee not found or unauthorized" });
    res.json({
      success: true,
      isAdmin: employee.isAdmin,
      message: `Admin rights ${grant ? "granted to" : "revoked from"} ${employee.name}`,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ------------------------------
// DELETE /api/employees/:id/devices/:deviceSubId
// Revoke a trusted device by subdocument _id
// ------------------------------
router.delete("/:id/devices/:deviceSubId", requireAuth, async (req, res) => {
  try {
    const { id, deviceSubId } = req.params;
    if (!mongoose.isValidObjectId(id) || !mongoose.isValidObjectId(deviceSubId)) {
      return res.status(400).json({ status: "error", message: "Invalid ID format" });
    }

    const scope = buildEmployeeScope(req.user);

    // Ensure the target employee is within the requester's scope (owner-scoped).
    const emp = await Employee.findOne({ _id: id, ...scope })
      .select("_id")
      .lean();
    if (!emp) {
      return res.status(404).json({ error: "Employee not found or unauthorized" });
    }

    // Capture the device being revoked BEFORE deleting it, so we know which
    // deviceId to target for realtime logout.
    const removedDevice = await TrustedDevice.findOne({
      _id: deviceSubId,
      employee: id,
    }).lean();
    if (!removedDevice) {
      return res.status(404).json({ error: "Device not found" });
    }

    await TrustedDevice.deleteOne({ _id: deviceSubId, employee: id });

    // 🔒 Realtime logout: tell the revoked device to sign out immediately.
    try {
      const io = req.app.get("io");
      if (io && removedDevice?.deviceId) {
        io.to(`employee_${id}`).emit("device_revoked", {
          deviceId: removedDevice.deviceId,
          deviceName: removedDevice.deviceName || null,
        });
      }
    } catch (emitErr) {
      console.error("[device_revoked emit error]", emitErr);
    }

    const remaining = await TrustedDevice.find({ employee: id })
      .sort({ addedAt: -1 })
      .lean();
    res.json({ status: "success", message: "Device revoked", data: remaining });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
