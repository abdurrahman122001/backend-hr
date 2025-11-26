// middleware/auth.js
const jwt = require("jsonwebtoken");
const User = require("../models/Users");

const JWT_SECRET = process.env.JWT_SECRET;

module.exports = async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const token =
    authHeader.startsWith("Bearer ") ? authHeader.substring(7) : null;

  if (!token) {
    return res.status(401).json({ message: "No token provided" });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);

    const user = await User.findById(payload.id).select(
      "_id role createdBy owner tokenVersion"
    );

    if (!user) {
      return res.status(401).json({ message: "User not found" });
    }

    // Optional token version validation
    if ((user.tokenVersion || 0) !== (payload.tv || 0)) {
      return res.status(401).json({ message: "Token invalidated" });
    }

    req.user = {
      _id: user._id,
      role: user.role,
      createdBy: user.createdBy,
      owner: user.owner,
    };

    return next();
  } catch (err) {
    return res.status(401).json({ message: "Invalid or expired token" });
  }
};
