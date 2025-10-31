// backend/src/routes/employees.js
const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");

const Employee = require("../models/Employees");
const requireAuth = require("../middleware/auth");
const { getUpcomingBirthdays, updateEmployeeRole } = require("../controllers/employeeController");

// ------------------------------
// Helpers
// ------------------------------
/**
 * Resolve the effective tenant/owner id for the current user.
 * Priority: explicit user.owner -> user.createdBy -> user._id
 */
function getEffectiveOwnerId(user) {
  return user?.owner || user?.createdBy || user?._id;
}

/**
 * Backward-compatible scope:
 * Match employees when EITHER
 *  - owner array contains ownerId OR userId
 *  - OR createdBy equals ownerId OR userId
 */
function buildEmployeeScope(user, includeTrashed = false) {
  const ownerId = getEffectiveOwnerId(user);
  const userId = user?._id;
  const scope = {
    $or: [
      { owner: { $in: [ownerId, userId] } },
      { createdBy: { $in: [ownerId, userId] } },
    ],
  };
  
  // Exclude trashed items by default
  if (!includeTrashed) {
    // Handle both cases: isTrashed = false OR isTrashed doesn't exist (for backward compatibility)
    scope.$or = [
      { isTrashed: false },
      { isTrashed: { $exists: false } }
    ];
  } else {
    // When including trashed, only show items where isTrashed is explicitly true
    scope.isTrashed = true;
  }
  
  return scope;
}

// ------------------------------
// GET /api/employees
// Fetch employees by owner OR createdBy (both supported)
// ------------------------------
router.get("/", requireAuth, async (req, res) => {
  try {
    const { trashed } = req.query;
    const includeTrashed = trashed === "true";
    
    const scope = buildEmployeeScope(req.user, includeTrashed);

    let query = { ...scope };

    // If req._id is provided, filter by that as well
    if (req._id) {
      query._id = req._id;
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
  } = req.body;

  if (!name || !position || !department || !email) {
    return res
      .status(400)
      .json({ status: "error", message: "Missing required fields" });
  }

  try {
    const ownerId = getEffectiveOwnerId(req.user);

    const emp = await Employee.create({
      owner: [ownerId], // tenant/HR id (array as per your schema)
      createdBy: req.user._id, // who created this employee
      name,
      position,
      department,
      email,
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
    const emp = await Employee.findOne({ _id: id, ...scope }).lean();

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
        trashedBy: req.user._id
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
      data: emp 
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
        isTrashed: true 
      },
      {
        isTrashed: false,
        trashedAt: null,
        trashedBy: null
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
      data: emp 
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
      isTrashed: true 
    });

    if (!emp) {
      return res
        .status(404)
        .json({ error: "Trashed employee not found or unauthorized" });
    }

    res.json({ 
      status: "success", 
      message: "Employee permanently deleted" 
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
      isTrashed: true 
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

// ------------------------------
// PATCH /api/employees/:id/role
// Update employee role
// ------------------------------
router.patch("/:id/role", updateEmployeeRole);

module.exports = router;