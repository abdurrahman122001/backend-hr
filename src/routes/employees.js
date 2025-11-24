// backend/src/routes/employees.js
const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");

const Employee = require("../models/Employees");
const requireAuth = require("../middleware/auth");
const { getUpcomingBirthdays, updateEmployeeRole, getUpcomingAnniversaries } = require("../controllers/employeeController");
const upload = require("../middleware/upload");

// ------------------------------
// Helpers
// ------------------------------
function getEffectiveOwnerId(user) {
  return user?.owner || user?.createdBy || user?._id;
}

// Simple scope builder without circular references
function buildEmployeeScope(user, includeTrashed = false) {
  const ownerId = getEffectiveOwnerId(user);
  const userId = user?._id;

  console.log("🔍 Building employee scope for user:", {
    userId: userId?.toString(),
    ownerId: ownerId?.toString(),
    includeTrashed
  });

  // Create base ownership query
  const ownershipQuery = {
    $or: [
      { owner: { $in: [ownerId, userId] } },
      { createdBy: { $in: [ownerId, userId] } },
    ]
  };

  // Handle trashed condition
  if (includeTrashed) {
    return {
      ...ownershipQuery,
      isTrashed: true
    };
  } else {
    return {
      ...ownershipQuery,
      $or: [
        { isTrashed: false },
        { isTrashed: { $exists: false } }
      ]
    };
  }
}

// ------------------------------
// Debug Middleware
// ------------------------------
const debugAuth = (req, res, next) => {
  console.log("=== AUTH DEBUG ===");
  console.log("User from token:", {
    _id: req.user?._id?.toString(),
    owner: req.user?.owner?.toString(),
    createdBy: req.user?.createdBy?.toString(),
    role: req.user?.role,
    email: req.user?.email
  });
  console.log("=== END DEBUG ===");
  next();
};

// ------------------------------
// GET /api/employees
// ------------------------------
router.get("/", requireAuth, debugAuth, async (req, res) => {
  try {
    const { trashed } = req.query;
    const includeTrashed = trashed === "true";
    
    const scope = buildEmployeeScope(req.user, includeTrashed);

    console.log("📋 Final query scope:", JSON.stringify(scope, null, 2));

    const list = await Employee.find(scope)
      .populate("shifts", "name")
      .sort({ name: 1 })
      .lean();
    
    console.log(`✅ Found ${list.length} employees for user ${req.user?._id}`);
    
    res.json({ status: "success", data: list });
  } catch (err) {
    console.error("❌ Error fetching employees:", err);
    res.status(500).json({ status: "error", message: err.message });
  }
});

// ------------------------------
// GET /api/employees/simple (Alternative endpoint)
// ------------------------------
router.get("/simple", requireAuth, async (req, res) => {
  try {
    const { trashed } = req.query;
    const includeTrashed = trashed === "true";
    
    const ownerId = getEffectiveOwnerId(req.user);
    const userId = req.user?._id;

    console.log("🔍 Simple endpoint - User:", {
      userId: userId?.toString(),
      ownerId: ownerId?.toString()
    });

    // Simple query without complex nesting
    let query = {
      $or: [
        { owner: { $in: [ownerId, userId] } },
        { createdBy: { $in: [ownerId, userId] } },
      ]
    };

    // Add trashed condition
    if (includeTrashed) {
      query.isTrashed = true;
    } else {
      query.isTrashed = { $ne: true };
    }

    console.log("📋 Simple query:", JSON.stringify(query, null, 2));

    const list = await Employee.find(query)
      .populate("shifts", "name")
      .sort({ name: 1 })
      .lean();
    
    console.log(`✅ Simple endpoint found ${list.length} employees`);
    
    res.json({ status: "success", data: list });
  } catch (err) {
    console.error("❌ Error in simple employees fetch:", err);
    res.status(500).json({ status: "error", message: err.message });
  }
});

// ------------------------------
// GET /api/employees/attendance
// ------------------------------
router.get("/attendance", requireAuth, async (req, res) => {
  try {
    const { trashed, includeOffboarded } = req.query;
    const includeTrashed = trashed === "true";
    const showOffboarded = includeOffboarded === "true";

    const ownerId = getEffectiveOwnerId(req.user);
    const userId = req.user?._id;

    let query = {
      $or: [
        { owner: { $in: [ownerId, userId] } },
        { createdBy: { $in: [ownerId, userId] } },
      ]
    };

    if (includeTrashed) {
      query.isTrashed = true;
    } else {
      query.isTrashed = { $ne: true };
    }

    if (!showOffboarded) {
      query.status = { $ne: "offboarded" };
    }

    const list = await Employee.find(query)
      .populate("shifts", "name")
      .sort({ name: 1 })
      .lean();

    res.json({ status: "success", data: list });

  } catch (err) {
    console.error("❌ Error fetching attendance employees:", err);
    res.status(500).json({ status: "error", message: err.message });
  }
});

// ------------------------------
// GET /api/employees/birthdays
// ------------------------------
router.get("/birthdays", requireAuth, getUpcomingBirthdays);
router.get("/anniversaries", requireAuth, getUpcomingAnniversaries);

// ------------------------------
// GET /api/employees/names
// ------------------------------
router.get("/names", requireAuth, async (req, res) => {
  try {
    const ownerId = getEffectiveOwnerId(req.user);
    const userId = req.user?._id;

    const query = {
      $or: [
        { owner: { $in: [ownerId, userId] } },
        { createdBy: { $in: [ownerId, userId] } },
      ],
      isTrashed: { $ne: true }
    };

    const docs = await Employee.find(query)
      .sort({ name: 1 })
      .select("_id name")
      .lean();
    res.json({ status: "success", data: docs });
  } catch (err) {
    console.error("❌ Error fetching employee names:", err);
    res.status(500).json({ status: "error", message: err.message });
  }
});

// ------------------------------
// POST /api/employees
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
    phone,
    qualification,
    presentAddress,
    maritalStatus,
    nomineeName,
    emergencyContact,
    joiningDate,
    leavingDate,
    cnic,
    dateOfBirth,
    bankAccount,
    companyEmail,
    shifts,
  } = req.body;

  if (!name || !position || !department || !email) {
    return res
      .status(400)
      .json({ status: "error", message: "Missing required fields" });
  }

  try {
    const ownerId = getEffectiveOwnerId(req.user);

    console.log("👤 Creating employee with owner:", ownerId?.toString());

    const emp = await Employee.create({
      owner: [ownerId],
      createdBy: req.user._id,
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
      leavingDate,
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
    console.error("❌ Error creating employee:", err);
    res.status(500).json({ status: "error", message: err.message });
  }
});

// ------------------------------
// GET /api/employees/list
// ------------------------------
router.get("/list", requireAuth, async (req, res) => {
  try {
    const ownerId = getEffectiveOwnerId(req.user);
    const userId = req.user?._id;

    const query = {
      $or: [
        { owner: { $in: [ownerId, userId] } },
        { createdBy: { $in: [ownerId, userId] } },
      ],
      isTrashed: { $ne: true }
    };

    const emps = await Employee.find(query)
      .select("-owner")
      .populate("shifts", "name")
      .sort({ name: 1 })
      .lean();

    res.json({ status: "success", data: emps });
  } catch (err) {
    console.error("❌ Error fetching employee list:", err);
    res.status(500).json({ status: "error", message: err.message });
  }
});

// ------------------------------
// GET /api/employees/:id
// ------------------------------
router.get("/:id", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res
        .status(400)
        .json({ status: "error", message: "Invalid employee id" });
    }

    const ownerId = getEffectiveOwnerId(req.user);
    const userId = req.user?._id;

    const query = {
      _id: id,
      $or: [
        { owner: { $in: [ownerId, userId] } },
        { createdBy: { $in: [ownerId, userId] } },
      ]
    };

    const emp = await Employee.findOne(query)
      .populate("shifts", "name")
      .lean();

    if (!emp) return res.status(404).json({ error: "Employee not found" });
    res.json({ status: "success", employee: emp });
  } catch (err) {
    console.error("❌ Error fetching employee by ID:", err);
    res.status(500).json({ error: err.message });
  }
});

// ------------------------------
// PATCH /api/employees/:id
// ------------------------------
router.patch("/:id", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res
        .status(400)
        .json({ status: "error", message: "Invalid employee id" });
    }

    const ownerId = getEffectiveOwnerId(req.user);
    const userId = req.user?._id;

    const query = {
      _id: id,
      $or: [
        { owner: { $in: [ownerId, userId] } },
        { createdBy: { $in: [ownerId, userId] } },
      ]
    };

    const emp = await Employee.findOneAndUpdate(
      query,
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
    console.error("❌ Error updating employee:", err);
    res.status(400).json({ error: err.message });
  }
});

// ------------------------------
// DELETE /api/employees/:id
// ------------------------------
router.delete("/:id", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res
        .status(400)
        .json({ status: "error", message: "Invalid employee id" });
    }

    const ownerId = getEffectiveOwnerId(req.user);
    const userId = req.user?._id;

    const query = {
      _id: id,
      $or: [
        { owner: { $in: [ownerId, userId] } },
        { createdBy: { $in: [ownerId, userId] } },
      ]
    };

    const emp = await Employee.findOneAndUpdate(
      query,
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
    console.error("❌ Error deleting employee:", err);
    res.status(500).json({ error: err.message });
  }
});

// ------------------------------
// POST /api/employees/:id/restore
// ------------------------------
router.post("/:id/restore", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res
        .status(400)
        .json({ status: "error", message: "Invalid employee id" });
    }

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
    console.error("❌ Error restoring employee:", err);
    res.status(500).json({ error: err.message });
  }
});

// ------------------------------
// DELETE /api/employees/:id/permanent
// ------------------------------
router.delete("/:id/permanent", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res
        .status(400)
        .json({ status: "error", message: "Invalid employee id" });
    }

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
    console.error("❌ Error permanently deleting employee:", err);
    res.status(500).json({ error: err.message });
  }
});

// ------------------------------
// GET /api/employees/trash/count
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
    console.error("❌ Error fetching trash count:", err);
    res.status(500).json({ error: err.message });
  }
});

// ------------------------------
// GET /api/employees/roles
// ------------------------------
router.get("/roles", requireAuth, async (req, res) => {
  try {
    const ownerId = getEffectiveOwnerId(req.user);
    const userId = req.user?._id;

    const query = {
      $or: [
        { owner: { $in: [ownerId, userId] } },
        { createdBy: { $in: [ownerId, userId] } },
      ],
      isTrashed: { $ne: true },
      role: { $ne: null },
    };

    const roles = await Employee.distinct("role", query);

    const formatted = roles.map((r) => ({
      label: r,
      value: r,
    }));

    res.json({ status: "success", data: formatted });
  } catch (error) {
    console.error("❌ Error fetching roles:", error);
    res.status(500).json({ status: "error", message: error.message });
  }
});

// PATCH /api/employees/:id/role
router.patch("/:id/role", updateEmployeeRole);

module.exports = router;