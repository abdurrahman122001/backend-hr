const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// Every model included by GET /api/open-requests/approvals is covered here.
// Keeping this at the HTTP boundary means new requests and status changes use
// one reliable Socket.IO contract instead of each controller inventing its own.
const REQUEST_PREFIXES = [
  "/api/apply-leave",
  "/api/document-requests",
  "/api/loan-requests",
  "/api/reimbursement-requests",
  "/api/advance-salary-requests",
  "/api/salary-change-requests",
  "/api/commission-requests",
  "/api/tax-adjustment-requests",
  "/api/bonus-requests",
  "/api/leave-encashment-requests",
  "/api/leave-carry-forward-requests",
  "/api/overtime-requests",
  "/api/emp-profile-revisions",
  "/api/admin/profile-revisions",
  "/api/open-requests",
];

const isWithinPrefix = (pathname, prefix) =>
  pathname === prefix || pathname.startsWith(`${prefix}/`);

function isThingsToDoMutation(req) {
  if (!MUTATING_METHODS.has(req.method)) return false;

  const rawPathname = (req.originalUrl || req.url || "").split("?", 1)[0];
  const pathname =
    rawPathname.length > 1 ? rawPathname.replace(/\/+$/, "") : rawPathname;

  // These endpoints live under request route families but do not change the
  // approval queue.
  if (
    pathname === "/api/apply-leave/check-policy" ||
    /^\/api\/apply-leave\/[^/]+\/messages(?:\/|$)/.test(pathname) ||
    pathname === "/api/emp-profile-revisions/upload-photo"
  ) {
    return false;
  }

  if (REQUEST_PREFIXES.some((prefix) => isWithinPrefix(pathname, prefix))) {
    return true;
  }

  const changesChallengeAtAttendanceRoot =
    /^\/api\/(?:admin\/)?attendances?\/?$/.test(pathname) &&
    String(req.body?.challengeStatus || "").trim().length > 0;

  // Attendance punches are deliberately excluded; only challenge changes can
  // alter the approval list shown by the dashboard widget.
  return (
    changesChallengeAtAttendanceRoot ||
    /^\/api\/emp-attendance\/challenge(?:\/|$)/.test(pathname) ||
    /^\/api\/(?:admin\/)?attendances?\/[^/]+\/challenge(?:\/|$)/.test(
      pathname,
    )
  );
}

function normalizeId(value) {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (!candidate) return null;
  if (typeof candidate === "object" && candidate._id) {
    return String(candidate._id);
  }
  return String(candidate);
}

function getThingsToDoOwnerId(req) {
  return normalizeId(
    req.employee?.owner || req.user?.owner || req.admin?.owner,
  );
}

function thingsToDoRealtime(req, res, next) {
  if (!isThingsToDoMutation(req)) return next();

  res.once("finish", () => {
    // Do not invalidate the dashboards when a mutation was rejected or failed.
    if (res.statusCode < 200 || res.statusCode >= 300) return;

    const io = req.app.get("io");
    if (!io) return;

    const ownerId = getThingsToDoOwnerId(req);
    const room = ownerId
      ? `things_to_do_${ownerId}`
      : "things_to_do_watchers";

    // The payload contains no request or tenant data. Each authenticated widget
    // re-fetches its own scoped approval list after receiving this signal.
    io.to(room).emit("things_to_do_updated", {
      changedAt: new Date().toISOString(),
    });
  });

  return next();
}

module.exports = thingsToDoRealtime;
module.exports.isThingsToDoMutation = isThingsToDoMutation;
module.exports.getThingsToDoOwnerId = getThingsToDoOwnerId;
