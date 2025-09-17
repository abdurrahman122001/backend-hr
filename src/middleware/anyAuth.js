const jwt = require("jsonwebtoken");
const Employee = require("../models/Employees");
const Admin = require("../models/Users"); // if you have an Admin model
const JWT_SECRET = process.env.JWT_SECRET;

async function requireAnyAuth(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ")
    ? authHeader.split(" ")[1]
    : null;

  if (!token) {
    return res.status(401).json({ error: "Unauthorized: no token provided" });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);

    // Try employee first
    let user = await Employee.findById(payload.id).select(
      "_id role companyEmail name owner"
    );

    if (user) {
      req.employee = user;
      return next();
    }

    // Try admin
    user = await Admin.findById(payload.id).select("_id role email name");
    if (user) {
      req.admin = user;
      return next();
    }

    return res.status(401).json({ error: "Unauthorized: user not found" });
  } catch (err) {
    console.error("[Auth ERROR]", err);
    return res.status(401).json({ error: "Unauthorized: invalid or expired token" });
  }
}

module.exports = requireAnyAuth;
