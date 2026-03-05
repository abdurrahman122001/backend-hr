// middleware/requireEmployeeAuth.js - Updated to include permissions
const jwt = require("jsonwebtoken");
const Employee = require("../models/Employees");
const JWT_SECRET = process.env.JWT_SECRET;

module.exports = async function requireEmployeeAuth(req, res, next) {
  const authHeader = req.headers.authorization || "";
  let token = authHeader.startsWith("Bearer ")
    ? authHeader.split(" ")[1]
    : null;

  // ✅ Also check query params (useful for sendBeacon/logout on browser close)
  if (!token && req.query.token) {
    token = req.query.token;
  }

  if (!token) {
    console.warn("🔐 [Auth] No token provided");
    return res
      .status(401)
      .json({ status: "error", message: "Unauthorized: no token provided" });
  }

  try {
    // Verify token
    const payload = jwt.verify(token, JWT_SECRET);
    // Fetch employee with permissions
    const emp = await Employee.findById(payload.id).select(
      "_id role companyEmail name owner department permissions"
    );

    if (!emp) {
      console.warn("🔐 [Auth] Employee not found for ID", payload.id);
      return res
        .status(401)
        .json({ status: "error", message: "Unauthorized: employee not found" });
    }
    // 🔹 Session Check: Ensure session is active for today
    // Skip this check for reactivation or logout itself
    const isExempted = req.path === "/reactivate-session" || req.path === "/logout";
    if (!isExempted) {
      const moment = require("moment-timezone");
      const EmployeeSession = require("../models/EmployeeSession");
      
      // First, try to find an active session
      let session = await EmployeeSession.findOne({
        employeeId: emp._id,
        active: true
      }).sort({ loginTime: -1 });

      // If no active session, check if there's a recent inactive auto-logout session (page refresh detection)
      if (!session) {
        const recentInactiveSession = await EmployeeSession.findOne({
          employeeId: emp._id,
          active: false,
          isAutoLogout: true
        }).sort({ updatedAt: -1 });

        // Allow access if within reactivation window (30 seconds)
        if (recentInactiveSession) {
          const timeSinceInactive = Date.now() - new Date(recentInactiveSession.updatedAt).getTime();
          if (timeSinceInactive < 30000) {
            // Within reactivation window - allow access and log it
            console.info(`🔄 [Auth] User in reactivation window (${timeSinceInactive}ms), allowing temporary access`);
            session = recentInactiveSession;
          }
        }
      }

      if (!session) {
        console.warn("🔐 [Auth] No active session for", emp.companyEmail);
        return res.status(401).json({
          status: "error",
          message: "Session inactive. Please log in again.",
          isSessionError: true
        });
      }
    }

    // Attach employee data to request
    req.employee = {
      _id: emp._id,
      role: emp.role,
      companyEmail: emp.companyEmail,
      name: emp.name,
      owner: emp.owner,
      department: emp.department,
      permissions: emp.permissions || {},
    };

    next();
  } catch (err) {
    console.error("🔐 [Auth] Token error:", err);

    if (err.name === "TokenExpiredError") {
      return res.status(401).json({
        status: "error",
        message: "Session expired. Please log in again.",
      });
    }

    return res.status(401).json({
      status: "error",
      message: "Unauthorized: invalid or expired token",
    });
  }
};