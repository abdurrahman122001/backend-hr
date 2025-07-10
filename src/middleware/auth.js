const jwt = require('jsonwebtoken');
const User = require('../models/Users');
const JWT_SECRET = process.env.JWT_SECRET;

module.exports = async function requireAuth(req, res, next) {
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
    // Fetch user from DB to get the role and createdBy
    const user = await User.findById(payload.id).select('_id role createdBy');
    if (!user) {
      return res
        .status(401)
        .json({ status: "error", message: "Unauthorized: user not found" });
    }
    // Attach full user object to req.user
    req.user = {
      _id: user._id,
      role: user.role,
      createdBy: user.createdBy ? user.createdBy : null // could be undefined for super-admin
    };
    next();
  } catch (err) {
    return res
      .status(401)
      .json({ status: "error", message: "Unauthorized: invalid or expired token" });
  }
};
