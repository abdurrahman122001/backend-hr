// backend/src/middleware/auth.js
const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET;

module.exports = function requireAuth(req, res, next) {
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
    // you can fetch the user from DB here if you need more info:
    // const user = await User.findById(payload.id);
    req.user = { _id: payload.id };
    next();
  } catch (err) {
    return res
      .status(401)
      .json({ status: "error", message: "Unauthorized: invalid or expired token" });
  }
};
