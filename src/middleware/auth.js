// middleware/auth.js
const jwt = require('jsonwebtoken');
const User = require('../models/Users');

const JWT_SECRET = process.env.JWT_SECRET;
const REFRESH_SECRET = process.env.REFRESH_SECRET;
const ACCESS_TTL = process.env.ACCESS_TTL || '30m';

module.exports = async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7)
    : null;

  if (!token) {
    return res
      .status(401)
      .json({ status: "error", message: "Unauthorized: no token provided" });
  }

  try {
    // 1) Try verifying access token
    const payload = jwt.verify(token, JWT_SECRET);
    const userId = payload.id || payload.sub;
    
    // FIX: Include createdBy in the select
    const user = await User.findById(userId).select('_id role createdBy tokenVersion owner');
    if (!user) {
      return res.status(401).json({ status: "error", message: "Unauthorized: user not found" });
    }
    
    // optional: tokenVersion check to invalidate old tokens
    if ((user.tokenVersion || 0) !== (payload.tv || 0)) {
      return res.status(401).json({ status: "error", message: "Unauthorized: token invalidated" });
    }

    req.user = {
      _id: user._id,
      role: user.role,
      createdBy: user.createdBy || null,
      owner: user.owner || null  // Also include owner if it exists
    };
    return next();
  } catch (err) {
    // 2) If access token expired, try refresh flow
    if (err.name === 'TokenExpiredError') {
      try {
        const refreshToken = req.cookies?.rt;
        if (!refreshToken) {
          return res.status(401).json({ status: "error", message: "Unauthorized: expired token and no refresh" });
        }

        const rPayload = jwt.verify(refreshToken, REFRESH_SECRET);
        const userId = rPayload.id || rPayload.sub;
        
        // FIX: Include createdBy in the select for refresh flow too
        const user = await User.findById(userId).select('_id role createdBy tokenVersion owner');
        if (!user) {
          return res.status(401).json({ status: "error", message: "Unauthorized: user not found (refresh)" });
        }
        
        // tokenVersion guard
        if ((user.tokenVersion || 0) !== (rPayload.tv || 0)) {
          return res.status(401).json({ status: "error", message: "Unauthorized: refresh invalidated" });
        }

        // 3) Issue a new access token and continue
        const newAccessToken = jwt.sign(
          { 
            id: user._id.toString(), 
            role: user.role, 
            tv: user.tokenVersion || 0,
            createdBy: user.createdBy // Include createdBy in token payload if needed
          },
          JWT_SECRET,
          { expiresIn: ACCESS_TTL }
        );

        res.setHeader('x-access-token', newAccessToken);

        req.user = {
          _id: user._id,
          role: user.role,
          createdBy: user.createdBy || null,
          owner: user.owner || null
        };
        return next();
      } catch (refreshErr) {
        return res.status(401).json({ status: "error", message: "Unauthorized: invalid or expired refresh" });
      }
    }

    // 3) Other verify errors
    return res
      .status(401)
      .json({ status: "error", message: "Unauthorized: invalid or expired token" });
  }
};