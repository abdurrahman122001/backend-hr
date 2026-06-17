const Employee = require("../models/Employees");

/**
 * Admin-only gate. Must run AFTER requireAuth (which normalizes req.user.role
 * and attaches req.user.employeeId when an employee record is linked).
 *
 * Allows:
 *  - company admins / super-admins (role normalized to "admin"/"super-admin"), and
 *  - employee-admins: any employee whose record has isAdmin=true. We verify this
 *    against the DB flag because requireAuth only maps isAdmin -> role:"admin" in
 *    the employee-fallback path; an employee-admin signed in via a linked User
 *    account keeps their employee role, so the role string alone isn't enough.
 *
 * Blocks regular employees, so company-scoped admin data (e.g. task workspaces)
 * is not exposed just because an employee token resolves to a company owner.
 */
module.exports = async function requireAdmin(req, res, next) {
  try {
    const role = req.user?.role;
    if (role === "admin" || role === "super-admin") {
      return next();
    }

    const employeeId = req.user?.employeeId || req.user?._id;
    if (employeeId) {
      const emp = await Employee.findById(employeeId).select("isAdmin");
      if (emp?.isAdmin) {
        return next();
      }
    }

    return res.status(403).json({ message: "Admin access required" });
  } catch (err) {
    console.error("🔐 [requireAdmin] Error:", err);
    return res.status(500).json({ message: "Authorization check failed" });
  }
};
