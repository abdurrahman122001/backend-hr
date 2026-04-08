// middleware/requireEmployeeAuth.js - Updated to include permissions
const jwt = require("jsonwebtoken");
const moment = require("moment-timezone");
const Employee = require("../models/Employees");
const EmployeeSession = require("../models/EmployeeSession");
const JWT_SECRET = process.env.JWT_SECRET;
const TIMEZONE = "Asia/Karachi";

module.exports = async function requireEmployeeAuth(req, res, next) {
  const authHeader = req.headers.authorization || "";
  // Show whether header is present and a short token snippet for debugging
  try {
    const tokenSnippet = authHeader && authHeader.startsWith('Bearer ') ? (authHeader.split(' ')[1] || '').slice(0, 8) + '...' : 'none';
  } catch (e) {
    // ignore logging errors
  }

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
      "_id role companyEmail name owner department permissions joiningDate"
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

      // First, try to find an active session
      let session = await EmployeeSession.findOne({
        employeeId: emp._id,
        active: true
      }).sort({ loginTime: -1 });

      // If no active session, check if there's a recently inactive session (page refresh/navigation detection)
      if (!session) {
        // Accept ANY recent inactive session within 60 seconds - covers:
        // 1. isAutoLogout sessions (beacon fired on close)
        // 2. Sessions inactive for any reason within the window
        // This handles race conditions where the beacon may not have fired yet or
        // the session was deactivated just before the new page loaded.
        const recentInactiveSession = await EmployeeSession.findOne({
          employeeId: emp._id,
          active: false
        }).sort({ updatedAt: -1 });

        // Allow access if within a generous reactivation window (60 seconds)
        if (recentInactiveSession) {
          const timeSinceInactive = Date.now() - new Date(recentInactiveSession.updatedAt).getTime();
          if (timeSinceInactive < 60000) {
            // Within reactivation window - allow access silently
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
      joiningDate: emp.joiningDate,
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