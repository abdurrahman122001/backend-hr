const jwt = require("jsonwebtoken");
const User = require("../models/Users");
const Employee = require("../models/Employees");

const JWT_SECRET = process.env.JWT_SECRET;

module.exports = async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || "";
  let token = authHeader.startsWith("Bearer ") ? authHeader.substring(7) : null;

  // Also check query for flexibility (common in redirects from attendance app)
  if (!token && req.query.token) {
    token = req.query.token;
  }

  if (!token || token === "undefined" || token === "null") {
    return res.status(401).json({ message: "No valid token provided" });
  }

  try {
    const JWT_SECRET = process.env.JWT_SECRET;
    if (!JWT_SECRET) {
      console.error("❌ [AuthMiddleware] JWT_SECRET is not defined in environment variables");
      return res.status(500).json({ message: "Server configuration error" });
    }

    const payload = jwt.verify(token, JWT_SECRET);

    // Find the user
    let user = await User.findById(payload.id).select(
      "_id role createdBy owner tokenVersion name email companyEmail"
    );

    let employee = null;

    if (!user) {
      // Fallback: Check if it's an Employee ID (employee-admin or Employee Dashboard)
      employee = await Employee.findById(payload.id).select(
        "_id role isAdmin permissions name department designation owner companyEmail"
      );

      if (employee) {
        // Create a user-like object from employee data
        // If the employee has been granted admin rights, treat them as admin
        user = {
          _id: employee._id,
          role: employee.isAdmin ? "admin" : employee.role,
          name: employee.name,
          companyEmail: employee.companyEmail,
          owner: employee.owner,
          isEmployeeFallback: true
        };
      } else {
        return res.status(401).json({ message: "User not found" });
      }
    }

    // Optional token version validation (only for actual User models)
    if (!user.isEmployeeFallback && (user.tokenVersion || 0) !== (payload.tv || 0)) {
      return res.status(401).json({ message: "Token invalidated" });
    }

    // Find the employee record if not already found (for User models)
    if (!employee) {
      employee = await Employee.findOne({
        $or: [
          { userAccount: user._id },
          { email: user.email },
          { companyEmail: user.companyEmail }
        ]
      }).select("role permissions name department designation owner");
    }

    // Check if user is a root administrator (admin or super-admin)
    const isRootAdmin = user.role === "admin" || user.role === "super-admin";

    // Normalize role string: Root administrators keep their admin role and do not downgrade to employee role
    const rawRole = isRootAdmin ? user.role : (employee?.role || user.role || "");
    const normalizedRole = rawRole.toLowerCase().replace("_", "-");

    // Build effective owner: Root admins are their own owners (company roots)
    let effectiveOwner;
    if (isRootAdmin) {
      effectiveOwner = user.owner || user._id;
    } else {
      effectiveOwner = user.owner || employee?.owner || user.createdBy || user._id;
    }

    const finalOwnerId = Array.isArray(effectiveOwner) ? effectiveOwner[0] : effectiveOwner;

    req.user = {
      _id: user._id,
      role: normalizedRole,
      userRole: user.role, // Preserve the original user role
      createdBy: user.createdBy,
      owner: finalOwnerId,
      // Add employee info if found
      ...(employee && {
        employeeId: employee._id,
        employeeName: employee.name,
        employeeRole: employee.role,
        employeePermissions: employee.permissions,
        department: employee.department,
        designation: employee.designation
      })
    };

    // If employee has permissions in DB, attach them to user object
    if (employee?.permissions) {
      req.user.permissions = employee.permissions;
    }

    return next();
  } catch (err) {
    console.error("🔐 [AuthMiddleware] Error:", err.name, err.message);
    
    if (err.name === "TokenExpiredError") {
      return res.status(401).json({ 
        message: "Token expired", 
        expiredAt: err.expiredAt 
      });
    }
    
    return res.status(401).json({ 
      message: "Invalid token or authentication failed",
      error: err.name === "JsonWebTokenError" ? "malformed" : "error"
    });
  }
};