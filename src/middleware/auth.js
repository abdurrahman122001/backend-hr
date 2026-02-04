const jwt = require("jsonwebtoken");
const User = require("../models/Users");
const Employee = require("../models/Employees");

const JWT_SECRET = process.env.JWT_SECRET;

module.exports = async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const token =
    authHeader.startsWith("Bearer ") ? authHeader.substring(7) : null;

  if (!token) {
    return res.status(401).json({ message: "No token provided" });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);

    // Find the user
    const user = await User.findById(payload.id).select(
      "_id role createdBy owner tokenVersion name email companyEmail"
    );

    if (!user) {
      return res.status(401).json({ message: "User not found" });
    }

    // Optional token version validation
    if ((user.tokenVersion || 0) !== (payload.tv || 0)) {
      return res.status(401).json({ message: "Token invalidated" });
    }

    // Find the employee record to get permissions and correct role
    const employee = await Employee.findOne({
      $or: [
        { userAccount: user._id },
        { email: user.email },
        { companyEmail: user.companyEmail }
      ]
    }).select("role permissions name department designation owner");

    // Normalize role string
    const rawRole = employee?.role || user.role || "";
    const normalizedRole = rawRole.toLowerCase().replace("_", "-");

    // Build user object with employee data
    const effectiveOwner = employee?.owner || user.createdBy || user._id;
    const finalOwnerId = Array.isArray(effectiveOwner) ? effectiveOwner[0] : effectiveOwner;

    req.user = {
      _id: user._id,
      role: normalizedRole,
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
    console.error("Auth middleware error:", err);
    return res.status(401).json({ message: "Invalid or expired token" });
  }
};