// backend/src/routes/hrAuth.js
const express   = require("express");
const jwt       = require("jsonwebtoken");
const Employee  = require("../models/Employees");
const requireAuth = require("../middleware/auth");

const router    = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || "your_jwt_secret_here";

// ─────────────────────────────────────────────────────────
// POST /hr/login
//   Body: { email, password }
//   1) Find Employee by email
//   2) Verify password via instance.comparePassword
//   3) Ensure isHR === true
//   4) Return JWT + employee info
// ─────────────────────────────────────────────────────────
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required." });
    }

    // 1) Lookup Employee by email
    const employee = await Employee.findOne({ email });
    if (!employee) {
      return res.status(401).json({ error: "Invalid credentials." });
    }

    // → Reject if no hashed password saved
    if (!employee.password) {
      return res.status(401).json({ error: "Invalid credentials." });
    }

    // 2) Compare password on the instance
    const isMatch = await employee.comparePassword(password);
    if (!isMatch) {
      return res.status(401).json({ error: "Invalid credentials." });
    }

    // 3) Ensure this employee is marked as HR
    if (!employee.isHR) {
      return res.status(403).json({ error: "Access denied. Not an HR account." });
    }

    // 4) Sign JWT (expires in 7 days)
    const payload = { userId: employee._id };
    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: "7d" });

    return res.json({
      token,
      user: {
        _id: employee._id,
        email: employee.email
      }
    });
  } catch (err) {
    console.error("❌ /hr/login error:", err);
    return res.status(500).json({ error: "Server error." });
  }
});

// ─────────────────────────────────────────────────────────
// GET /hr/profile  (protected)
//   Requires: Authorization: Bearer <token>
//   Returns HR employee’s basic info
// ─────────────────────────────────────────────────────────
router.get("/profile", requireAuth, async (req, res) => {
  try {
    const userId = req.user.userId;

    // Ensure the logged‐in employee is still marked as HR
    const hrEmp = await Employee.findOne({
      _id: userId,
      isHR: true
    }).lean();
    if (!hrEmp) {
      return res.status(403).json({ error: "Not authorized." });
    }

    return res.json({
      employee: {
        _id: hrEmp._id,
        name: hrEmp.name,
        email: hrEmp.email,
        department: hrEmp.department,
        designation: hrEmp.designation,
        isHR: hrEmp.isHR,
      }
    });
  } catch (err) {
    console.error("❌ /hr/profile error:", err);
    return res.status(500).json({ error: "Server error." });
  }
});

module.exports = router;
