// backend/src/middleware/empAuth.js
const jwt = require('jsonwebtoken');
const Employee = require('../models/Employees');
const JWT_SECRET = process.env.JWT_SECRET;

module.exports = async function requireEmployeeAuth(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ")
    ? authHeader.split(" ")[1]
    : null;

  if (!token) {
    return res
      .status(401)
      .json({ status: "error", message: "Unauthorized: no token provided" });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);

    // Fetch employee from DB
    const emp = await Employee.findById(payload.id).select('_id');
    if (!emp) {
      return res
        .status(401)
        .json({ status: "error", message: "Unauthorized: employee not found" });
    }

    // Attach employee to request (same idea as req.user)
    req.employee = { _id: emp._id };
    next();
  } catch (err) {
    return res
      .status(401)
      .json({ status: "error", message: "Unauthorized: invalid or expired token" });
  }
};