// middleware/unifiedAuth.js
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

    // Check if this is an Employee token (employee ID format)
    let isEmployeeToken = false;
    
    // Try to find employee first (since most tokens will be employee tokens)
    const employee = await Employee.findById(payload.id).select(
      "_id role companyEmail name owner department permissions userAccount"
    );

    if (employee) {
      // This is an employee token
      isEmployeeToken = true;
      
      req.user = {
        _id: employee._id,
        role: employee.role,
        name: employee.name,
        email: employee.companyEmail,
        owner: employee.owner,
        department: employee.department,
        permissions: employee.permissions || {},
        isEmployee: true,
        userAccount: employee.userAccount, // Link to User model if exists
      };
      
      // If employee has a linked user account, attach it
      if (employee.userAccount) {
        const user = await User.findById(employee.userAccount).select(
          "_id role createdBy owner tokenVersion"
        );
        if (user) {
          req.user.linkedUser = {
            _id: user._id,
            role: user.role,
            createdBy: user.createdBy,
            owner: user.owner,
          };
        }
      }
    } else {
      // Try to find user (admin token)
      const user = await User.findById(payload.id).select(
        "_id role createdBy owner tokenVersion name email"
      );

      if (!user) {
        return res.status(401).json({ message: "User not found" });
      }

      // Token version validation for user tokens
      if ((user.tokenVersion || 0) !== (payload.tv || 0)) {
        return res.status(401).json({ message: "Token invalidated" });
      }

      // Find linked employee record for this user
      const linkedEmployee = await Employee.findOne({
        userAccount: user._id
      }).select("role permissions name department");

      req.user = {
        _id: user._id,
        role: user.role,
        name: user.name,
        email: user.email,
        createdBy: user.createdBy,
        owner: user.owner,
        isEmployee: false,
        isAdmin: true,
        permissions: linkedEmployee?.permissions || {},
        employeeInfo: linkedEmployee ? {
          employeeId: linkedEmployee._id,
          role: linkedEmployee.role,
          name: linkedEmployee.name,
          department: linkedEmployee.department
        } : null
      };
    }

    console.log("🔐 [UnifiedAuth] User authenticated:", {
      id: req.user._id,
      name: req.user.name,
      role: req.user.role,
      isEmployee: req.user.isEmployee,
      hasPermissions: !!req.user.permissions
    });

    return next();
  } catch (err) {
    console.error("🔐 [UnifiedAuth] Error:", err.message);
    
    if (err.name === "TokenExpiredError") {
      return res.status(401).json({ 
        message: "Token expired. Please log in again." 
      });
    }
    
    if (err.name === "JsonWebTokenError") {
      return res.status(401).json({ 
        message: "Invalid token" 
      });
    }
    
    return res.status(401).json({ 
      message: "Authentication failed" 
    });
  }
};