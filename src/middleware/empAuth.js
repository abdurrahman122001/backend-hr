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
    console.log("🔐 [EmpAuth] Token from query params");
  }

  // ✅ Also allow token in POST body (useful for navigator.sendBeacon payloads)
  if (!token && req.body && req.body.token) {
    token = req.body.token;
    console.log("🔐 [EmpAuth] Token from request body");
  }

  if (!token || token === "undefined" || token === "null") {
    console.warn("🔐 [EmpAuth] No valid token provided");
    console.warn("🔐 [EmpAuth-DEBUG] Headers:", JSON.stringify(req.headers));
    console.warn("🔐 [EmpAuth-DEBUG] Body:", JSON.stringify(req.body));
    console.warn("🔐 [EmpAuth-DEBUG] Query:", JSON.stringify(req.query));
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
    let emp = await Employee.findById(payload.id).select(
      "_id role companyEmail name owner department permissions joiningDate"
    );
    let isAdminUser = false;

    if (!emp) {
      // Fallback: Check if it's an Admin/HR User
      const User = require("../models/Users");
      const user = await User.findById(payload.id).select("_id role name email companyEmail owner");
      
      if (user) {
        emp = user;
        isAdminUser = true;
      } else {
        console.warn("🔐 [EmpAuth] Subject not found for ID", payload.id);
        return res
          .status(401)
          .json({ status: "error", message: "Unauthorized: user/employee not found" });
      }
    }

    // 🔹 Session Check: Ensure session is active for today (Only for employees)
    const isExempted = req.path === "/reactivate-session" || req.path === "/logout";
    if (!isExempted && !isAdminUser) {
      // First, try to find an active session
      let session = await EmployeeSession.findOne({
        employeeId: emp._id,
        active: true
      }).sort({ loginTime: -1 });

      // If no active session, accept an inactive session only if it was an auto-logout
      // (i.e., user closed the tab). Do NOT accept arbitrary recent inactive sessions.
      if (!session) {
        const inactiveAuto = await EmployeeSession.findOne({
          employeeId: emp._id,
          active: false,
          isAutoLogout: true
        }).sort({ updatedAt: -1 });
        if (inactiveAuto) {
          session = inactiveAuto;
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
      companyEmail: emp.companyEmail || emp.email,
      name: emp.name,
      owner: emp.owner || emp.createdBy || emp._id,
      department: emp.department,
      designation: emp.designation,
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