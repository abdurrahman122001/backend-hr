const autoApprovalNote = "Auto-approved by request center";

function getRequestUserId(req) {
  return req.user?.employeeId || req.user?.id || req.user?._id || req.employee?._id;
}

function approvedFields(req) {
  return {
    status: "approved",
    approvedBy: getRequestUserId(req),
    approvedAt: new Date(),
    adminReason: autoApprovalNote,
  };
}

function resolvedFields(req) {
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
  approvedFields,
  resolvedFields,
};
