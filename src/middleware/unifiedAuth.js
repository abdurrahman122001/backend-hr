// middleware/unifiedAuth.js - FIXED VERSION
const jwt = require("jsonwebtoken");
const User = require("../models/Users");
const Employee = require("../models/Employees");

const JWT_SECRET = process.env.JWT_SECRET;

module.exports = async function unifiedAuth(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ")
    ? authHeader.substring(7)
    : null;

  if (!token) {
    return res.status(401).json({ message: "No token provided" });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);

    // Get the ID from token
    const userId = payload.id || payload._id;

    if (!userId) {
      return res.status(401).json({ message: "Invalid token: No user ID" });
    }

    // Check if it's an employee or admin user
    let isEmployee = false;
    let employee = null;
    let user = null;

    // Try to find as employee first
    employee = await Employee.findById(userId).select(
      "_id role companyEmail name owner department permissions userAccount status"
    );

    if (employee) {
      isEmployee = true;
    } else {
      // Try to find as admin user
      user = await User.findById(userId).select(
        "_id role createdBy owner tokenVersion name email"
      );

      if (user) {
      } else {
        return res.status(401).json({ message: "User not found" });
      }
    }

    // BUILD THE UNIFIED USER OBJECT
    if (isEmployee) {
      // This is CRITICAL FIX:
      // When employee logs in, req.user._id should be the COMPANY OWNER ID
      // not the employee's personal ID
      req.user = {
        _id: employee.owner, // COMPANY ID - for database queries
        employeeId: employee._id, // Employee's personal ID
        role: employee.role,
        name: employee.name,
        email: employee.companyEmail,
        owner: Array.isArray(employee.owner) ? employee.owner[0] : employee.owner,
        department: employee.department,
        permissions: employee.permissions || {},
        isEmployee: true,
        isAdmin: false,
        userAccount: employee.userAccount,
        status: employee.status,
      };
    } else {
      // Admin user
      if ((user.tokenVersion || 0) !== (payload.tv || 0)) {
        return res.status(401).json({ message: "Token invalidated" });
      }

      // Find linked employee record for this user
      const linkedEmployee = await Employee.findOne({
        userAccount: user._id,
      }).select("role permissions name department");

      req.user = {
        _id: user._id, // Admin's ID is the company ID
        role: user.role,
        name: user.name,
        email: user.email,
        createdBy: user.createdBy,
        owner: user._id, // Same as _id for admin
        isEmployee: false,
        isAdmin: true,
        permissions: linkedEmployee?.permissions || {},
        employeeInfo: linkedEmployee
          ? {
            employeeId: linkedEmployee._id,
            role: linkedEmployee.role,
            name: linkedEmployee.name,
            department: linkedEmployee.department,
          }
          : null,
      };
    }
    return next();
  } catch (err) {
    console.error("🔐 [UnifiedAuth] Error:", err.message);

    if (err.name === "TokenExpiredError") {
      return res.status(401).json({
        message: "Token expired. Please log in again.",
      });
    }

    if (err.name === "JsonWebTokenError") {
      return res.status(401).json({
        message: "Invalid token",
      });
    }

    return res.status(500).json({
      message: "Authentication failed",
      error: err.message,
    });
  }
};
