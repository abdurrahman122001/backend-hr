// middleware/requireEmployeeAuth.js - Updated to include permissions
const jwt = require("jsonwebtoken");
const moment = require("moment-timezone");
const Employee = require("../models/Employees");
const EmployeeSession = require("../models/EmployeeSession");
const JWT_SECRET = process.env.JWT_SECRET;
const TIMEZONE = "Asia/Karachi";

module.exports = async function requireEmployeeAuth(req, res, next) {
  const authHeader = req.headers.authorization || "";
  let token = authHeader.startsWith("Bearer ")
    ? authHeader.split(" ")[1]
    : null;

  // ✅ Also check query params (useful for sendBeacon/logout on browser close)
  if (!token && req.query.token) {
    token = req.query.token;
  }

  if (!token || token === "undefined" || token === "null") {
    console.warn("🔐 [EmpAuth] No valid token provided");
    return res
      .status(401)
      .json({ status: "error", message: "Unauthorized: no token provided" });
  }

  try {
    const JWT_SECRET = process.env.JWT_SECRET;
    if (!JWT_SECRET) {
      console.error("❌ [EmpAuth] JWT_SECRET is not defined in environment variables");
      return res.status(500).json({ status: "error", message: "Server configuration error" });
    }

    // Verify token
    const payload = jwt.verify(token, JWT_SECRET);
    // Fetch employee with permissions
    const emp = await Employee.findById(payload.id).select(
      "_id role companyEmail name owner department permissions joiningDate"
    );

    if (!emp) {
      console.warn("🔐 [EmpAuth] Employee not found for ID", payload.id);
      return res
        .status(401)
        .json({ status: "error", message: "Unauthorized: employee not found" });
    }

    // 🔹 Session Check: Ensure session is active for today
    const isExempted = req.path === "/reactivate-session" || req.path === "/logout";
    if (!isExempted) {
      // First, try to find an active session
      let session = await EmployeeSession.findOne({
        employeeId: emp._id,
        active: true
      }).sort({ loginTime: -1 });

      // If no active session, check if there's a recently inactive session (page refresh/navigation detection)
      if (!session) {
        const recentInactiveSession = await EmployeeSession.findOne({
          employeeId: emp._id,
          active: false
        }).sort({ updatedAt: -1 });

        // Allow access if within a generous reactivation window (60 seconds)
        if (recentInactiveSession) {
          const timeSinceInactive = Date.now() - new Date(recentInactiveSession.updatedAt).getTime();
          if (timeSinceInactive < 60000) {
            session = recentInactiveSession;
          }
        }
      }

      if (!session) {
        console.warn("🔐 [EmpAuth] No active session for", emp.companyEmail);
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
    console.error("🔐 [EmpAuth] Error:", err.name, err.message);

    if (err.name === "TokenExpiredError") {
      return res.status(401).json({
        status: "error",
        message: "Session expired. Please log in again.",
        expiredAt: err.expiredAt
      });
    }

    return res.status(401).json({
      status: "error",
      message: "Unauthorized: invalid or expired token",
      error: err.name === "JsonWebTokenError" ? "malformed" : "error"
    });
  }
};