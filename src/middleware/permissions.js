const Employee = require("../models/Employees");

const checkPermission = (permissionName) => {
  return async (req, res, next) => {
    try {
      console.log(`🔐 [Permissions] Checking: ${permissionName} for:`, {
        userId: req.user._id,
        name: req.user.name,
        role: req.user.role,
        isEmployee: req.user.isEmployee,
        hasPermissions: !!req.user.permissions,
      });

      // 1. Check if user already has permissions attached
      if (req.user.permissions && req.user.permissions[permissionName]) {
        console.log(`🔐 [Permissions] Granted via req.user.permissions`);
        return next();
      }

      // 2. For admin users (non-employee), allow all
      if (
        req.user.isAdmin ||
        req.user.role === "admin" ||
        req.user.role === "super-admin"
      ) {
        console.log(
          `🔐 [Permissions] Granted via admin role: ${req.user.role}`
        );
        return next();
      }

      // 3. If employee, check their permissions from database
      let employee = null;

      if (req.user.isEmployee) {
        // Use employeeId if available (from unifiedAuth), otherwise fallback to _id
        const targetId = req.user.employeeId || req.user._id;
        employee = await Employee.findById(targetId).select(
          "permissions role"
        );
      } else if (req.user.employeeInfo?.employeeId) {
        // Admin with linked employee
        employee = await Employee.findById(
          req.user.employeeInfo.employeeId
        ).select("permissions role");
      } else {
        // Try to find employee by userAccount
        employee = await Employee.findOne({ userAccount: req.user._id }).select(
          "permissions role"
        );
      }

      if (!employee) {
        console.log("🔐 [Permissions] Employee record not found");
        return res.status(403).json({
          message: "Employee record not found",
          userId: req.user._id,
        });
      }

      console.log("🔐 [Permissions] Employee found:", {
        hasPermissions: !!employee.permissions,
        role: employee.role,
      });

      // 4. Check if employee has the permission
      if (employee.permissions && employee.permissions[permissionName]) {
        console.log(`🔐 [Permissions] Granted via employee.permissions`);
        return next();
      }

      // 5. Check if employee role grants permission
      if (employee.role === "admin" || employee.role === "super-admin") {
        console.log(
          `🔐 [Permissions] Granted via employee admin role: ${employee.role}`
        );
        return next();
      }

      // Permission denied
      console.log(`🔐 [Permissions] DENIED: ${permissionName}`);
      return res.status(403).json({
        message: `Access denied: You need ${permissionName} permission`,
        user: {
          id: req.user._id,
          name: req.user.name,
          role: req.user.role,
          isEmployee: req.user.isEmployee,
        },
        employee: employee
          ? {
            id: employee._id,
            role: employee.role,
            hasPermission: employee.permissions
              ? employee.permissions[permissionName]
              : false,
          }
          : null,
      });
    } catch (error) {
      console.error("🔐 [Permissions] Error:", error);
      res.status(500).json({
        message: "Internal server error checking permissions",
        error: error.message,
      });
    }
  };
};

/**
 * Middleware to check multiple permissions
 */
const checkPermissions = (permissionNames) => {
  return async (req, res, next) => {
    try {
      console.log(
        `🔐 Checking permissions: ${permissionNames.join(", ")} for user:`,
        {
          userId: req.user._id,
          role: req.user.role,
        }
      );

      // Check 1: If permissions are attached to req.user
      if (req.user.permissions) {
        const hasAnyPermission = permissionNames.some(
          (permission) => req.user.permissions[permission]
        );
        if (hasAnyPermission) {
          console.log(`🔐 Permissions granted via req.user.permissions`);
          return next();
        }
      }

      // Check 2: For admin users, allow all
      const userRole = req.user.employeeRole || req.user.role;
      if (userRole === "admin" || userRole === "super-admin") {
        console.log(`🔐 Permissions granted via admin role: ${userRole}`);
        return next();
      }

      // Check 3: Get employee record
      const employee = await Employee.findOne({
        $or: [
          { userAccount: req.user._id },
          { _id: req.user.employeeId }
        ],
      }).select("permissions role");

      if (!employee) {
        return res.status(403).json({ message: "Employee record not found" });
      }

      // Check if any of the required permissions exists
      const hasPermission = permissionNames.some(
        (permission) => employee.permissions && employee.permissions[permission]
      );

      if (!hasPermission) {
        // Check if employee is admin
        if (employee.role === "admin" || employee.role === "super-admin") {
          console.log(
            `🔐 Permissions granted via employee admin role: ${employee.role}`
          );
          req.employee = employee;
          return next();
        }

        return res.status(403).json({
          message: "Access denied: Insufficient permissions",
          requiredPermissions: permissionNames,
          userRole: req.user.role,
          employeeRole: employee.role,
        });
      }

      req.employee = employee;
      next();
    } catch (error) {
      console.error("🔐 Permissions check error:", error);
      res.status(500).json({ message: error.message });
    }
  };
};

module.exports = { checkPermission, checkPermissions };
