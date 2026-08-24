/**
 * profileAccessToken.js
 *
 * Candidates completing their profile arrive from an emailed link and have no
 * login yet, so they cannot present a normal JWT. Previously the employee's raw
 * ObjectId in the URL was the only thing standing between the public and that
 * person's CNIC scan and CV — an id is not a secret, never expires, and the
 * unauthenticated GET handed the file URLs straight back.
 *
 * This mints a short-lived token scoped to one employee, the same shape the
 * set-password email already uses. It grants access to that employee's own
 * documents and nothing else.
 */
const jwt = require("jsonwebtoken");

const SCOPE = "complete-profile";
const DEFAULT_TTL = "14d";

/** Sign a link token for one employee's document endpoints. */
function signProfileToken(employeeId, ttl = DEFAULT_TTL) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET is not configured");
  return jwt.sign({ sub: String(employeeId), scope: SCOPE }, secret, {
    expiresIn: ttl,
  });
}

/**
 * Verify a link token. Returns the employee id it is scoped to, or null if the
 * token is missing, malformed, expired, or was issued for a different purpose.
 */
function verifyProfileToken(token) {
  const secret = process.env.JWT_SECRET;
  if (!token || !secret) return null;
  try {
    const payload = jwt.verify(token, secret);
    if (payload.scope !== SCOPE || !payload.sub) return null;
    return String(payload.sub);
  } catch {
    return null;
  }
}

/** Pull the link token off a request, wherever the client put it. */
function readProfileToken(req) {
  const header = req.headers["x-profile-token"];
  if (header) return String(header);
  if (req.query?.profileToken) return String(req.query.profileToken);
  return null;
}

module.exports = { signProfileToken, verifyProfileToken, readProfileToken, SCOPE };
