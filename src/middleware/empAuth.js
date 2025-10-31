const jwt = require("jsonwebtoken");
const Employee = require("../models/Employees");
const JWT_SECRET = process.env.JWT_SECRET;

// Token lifespan (9 hours)
const TOKEN_LIFETIME = "9h";

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
    // ✅ Verify token
    const payload = jwt.verify(token, JWT_SECRET);
    const emp = await Employee.findById(payload.id).select(
      "_id role companyEmail name owner"
    );

    if (!emp) {
      console.warn("🔐 [Auth] Employee not found for ID", payload.id);
      return res
        .status(401)
        .json({ status: "error", message: "Unauthorized: employee not found" });
    }

    // ✅ Refresh token if it's about to expire (less than 30 minutes left)
    // const now = Math.floor(Date.now() / 1000);
    // const remainingTime = payload.exp - now;

    // if (remainingTime < 30 * 60) {
    //   // Issue a fresh token
    //   const newToken = jwt.sign({ id: emp._id }, JWT_SECRET, {
    //     expiresIn: TOKEN_LIFETIME,
    //   });
    //   res.setHeader("x-refreshed-token", newToken);
    //   console.log("🔄 [Auth] Token refreshed automatically for", emp.companyEmail);
    // }

    // ✅ Attach employee to request
    req.employee = {
      _id: emp._id,
      role: emp.role,
      companyEmail: emp.companyEmail,
      name: emp.name,
      owner: emp.owner,
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
