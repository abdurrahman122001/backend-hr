const jwt = require("jsonwebtoken");
const Employee = require("../models/Employees");
const JWT_SECRET = process.env.JWT_SECRET;

module.exports = async function requireEmployeeAuth(req, res, next) {
  console.log("🔐 [Auth] Checking auth header…");
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
    const payload = jwt.verify(token, JWT_SECRET);
    console.log("🔐 [Auth] JWT payload:", payload);

    const emp = await Employee.findById(payload.id).select(
      "_id role companyEmail name owner"
    );
    if (!emp) {
      console.warn("🔐 [Auth] Employee not found for ID", payload.id);
      return res
        .status(401)
        .json({ status: "error", message: "Unauthorized: employee not found" });
    }

    req.employee = {
      _id: emp._id,
      role: emp.role,
      companyEmail: emp.companyEmail,
      name: emp.name,
      owner: emp.owner,
    };
    console.log("🔐 [Auth] Authenticated employee:", req.employee);
    next();
  } catch (err) {
    console.error("🔐 [Auth] Token error:", err);
    return res
      .status(401)
      .json({
        status: "error",
        message: "Unauthorized: invalid or expired token",
      });
  }
};
