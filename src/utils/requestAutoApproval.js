const autoApprovalNote = "Auto-approved by request center";

function getRequestUserId(req) {
  return req.employee?._id || req.user?.employeeId || req.user?.employeeInfo?.employeeId || req.user?.id || req.user?._id;
}

function hasRequestAutoApproval(req) {
  const employeeRole = String(req.employee?.role || "").toLowerCase();
  const userRole = String(req.user?.role || "").toLowerCase();

  return (
    req.employee?.isAdmin === true ||
    req.user?.isAdmin === true ||
    employeeRole === "admin" ||
    employeeRole === "owner" ||
    userRole === "admin" ||
    userRole === "owner"
  );
}

function approvedFields(req) {
  if (!hasRequestAutoApproval(req)) return {};

  return {
    status: "approved",
    approvedBy: getRequestUserId(req),
    reviewedBy: getRequestUserId(req),
    approvedAt: new Date(),
    adminReason: autoApprovalNote,
  };
}

function resolvedFields(req) {
  if (!hasRequestAutoApproval(req)) return {};

  return {
    status: "resolved",
    reviewedBy: getRequestUserId(req),
    reviewedAt: new Date(),
    adminNote: autoApprovalNote,
  };
}

module.exports = {
  autoApprovalNote,
  getRequestUserId,
  hasRequestAutoApproval,
  approvedFields,
  resolvedFields,
};
