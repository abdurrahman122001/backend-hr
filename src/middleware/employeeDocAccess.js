/**
 * employeeDocAccess.js
 *
 * Authorization for employee identity documents (CNIC, CV, education
 * certificates). These routes previously had no authentication at all: anyone
 * who could guess or observe an employee ObjectId could read, replace, or
 * delete that person's identity documents, for any company.
 *
 * Access is granted to exactly three callers:
 *
 *   1. The employee themselves (their own JWT).
 *   2. Someone in the employee's company — an admin/HR user, or an employee of
 *      the same owner. Cross-company access is refused.
 *   3. A candidate holding a valid, unexpired complete-profile link token that
 *      is scoped to this specific employee (see utils/profileAccessToken.js).
 *      This keeps onboarding working for people who have no login yet.
 *
 * Sets `req.docSubject` to the resolved Employee document so handlers do not
 * have to look it up again.
 */
const jwt = require("jsonwebtoken");
const Employee = require("../models/Employees");
const User = require("../models/Users");
const { verifyProfileToken, readProfileToken } = require("../utils/profileAccessToken");

const isObjectId = (v) => /^[0-9a-fA-F]{24}$/.test(String(v || ""));
const sameId = (a, b) => !!a && !!b && String(a) === String(b);
const normalizeId = (v) => (Array.isArray(v) ? v[0] : v);

/**
 * Resolve the bearer token to { ownerId, employeeId, isAdmin } without assuming
 * which of the two auth systems issued it — employee tokens and admin/HR tokens
 * are both valid here.
 */
async function resolveCaller(req) {
  const authHeader = req.headers.authorization || "";
  let token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

  // A browser opening a document in a new tab cannot set a header, so accept
  // the token from the query as well — middleware/auth.js already does this for
  // the same reason.
  if (!token && req.query?.token) token = String(req.query.token);

  if (!token || token === "undefined" || token === "null") return null;

  const secret = process.env.JWT_SECRET;
  if (!secret) return null;

  let payload;
  try {
    payload = jwt.verify(token, secret);
  } catch {
    return null;
  }

  const subjectId = payload.id || payload._id || payload.userId;
  if (!subjectId) return null;

  const user = await User.findById(subjectId).select("_id role owner createdBy").lean();
  if (user) {
    const isRootAdmin = user.role === "admin" || user.role === "super-admin";
    const owner = normalizeId(user.owner) || (isRootAdmin ? user._id : user.createdBy || user._id);
    return { ownerId: owner, employeeId: null, isAdmin: true };
  }

  const employee = await Employee.findById(subjectId).select("_id owner isAdmin").lean();
  if (employee) {
    return {
      ownerId: normalizeId(employee.owner),
      employeeId: employee._id,
      isAdmin: !!employee.isAdmin,
    };
  }

  return null;
}

/**
 * The access rule itself, shared by the route middleware and by the protected
 * file server so both cannot drift apart.
 *
 * Returns { status, subject, via } — status 200 means allowed.
 */
async function canAccessEmployeeDocs(req, employeeId) {
  if (!isObjectId(employeeId)) {
    return { status: 400, error: "Invalid employee id" };
  }

  const subject = await Employee.findById(employeeId).select("_id owner").lean();
  if (!subject) {
    return { status: 404, error: "Employee not found" };
  }

  // 1. Candidate with a link token scoped to this employee.
  const linkSubject = verifyProfileToken(readProfileToken(req));
  if (linkSubject && sameId(linkSubject, employeeId)) {
    return { status: 200, subject, via: "profile-link" };
  }

  // 2 & 3. A logged-in caller: the employee themselves, or their company.
  const caller = await resolveCaller(req);
  if (!caller) {
    return { status: 401, error: "Authentication required" };
  }

  if (sameId(caller.employeeId, employeeId)) {
    return { status: 200, subject, via: "self" };
  }

  if (sameId(caller.ownerId, normalizeId(subject.owner))) {
    return { status: 200, subject, via: "owner" };
  }

  return { status: 403, error: "Not permitted to access this employee's documents" };
}

module.exports = async function employeeDocAccess(req, res, next) {
  try {
    const result = await canAccessEmployeeDocs(req, req.params.employeeId);
    if (result.status !== 200) {
      return res.status(result.status).json({ success: false, error: result.error });
    }
    req.docSubject = result.subject;
    req.docAccessVia = result.via;
    return next();
  } catch (err) {
    console.error("[employeeDocAccess] error:", err);
    return res.status(500).json({ success: false, error: "Authorization check failed" });
  }
};

module.exports.canAccessEmployeeDocs = canAccessEmployeeDocs;
module.exports.resolveCaller = resolveCaller;
module.exports.isObjectId = isObjectId;
module.exports.sameId = sameId;
module.exports.normalizeId = normalizeId;
