// middleware/requireEmployeeAuth.js - Updated to include permissions
const jwt = require("jsonwebtoken");
const Employee = require("../models/Employees");
const JWT_SECRET = process.env.JWT_SECRET;

module.exports = async function requireEmployeeAuth(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ")
    ? authHeader.split(" ")[1]
    : null;

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