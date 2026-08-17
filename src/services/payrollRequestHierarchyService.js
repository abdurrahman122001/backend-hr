const Employee = require('../models/Employees');
const PayrollHierarchy = require('../models/PayrollHierarchy');

const normalizeId = (value) => value ? String(value._id || value) : null;

function ownerIdFromRequest(req) {
  return normalizeId(req.user?.owner || req.employee?.owner || req.user?._id);
}

async function reviewerFromRequest(req, ownerId) {
  const candidates = [
    req.employee?._id,
    req.user?.employeeId,
    req.user?.employeeInfo?.employeeId,
    req.user?._id,
  ].filter(Boolean);

  for (const candidate of candidates) {
    const employee = await Employee.findOne({ _id: candidate, owner: ownerId })
      .select('_id isAdmin status')
      .lean();
    if (employee) return employee;
  }
  return null;
}

async function payrollScope(req) {
  const ownerId = ownerIdFromRequest(req);
  if (!ownerId) return { ownerId: null, reviewerId: null, employeeIds: [] };

  const reviewer = await reviewerFromRequest(req, ownerId);
  // The company-owner login is not necessarily backed by an Employee record.
  // It retains tenant-wide access; employee logins must follow PayrollHierarchy.
  if (!reviewer) {
    const employeeIds = await Employee.find({ owner: ownerId }).distinct('_id');
    return { ownerId, reviewerId: null, employeeIds, isOwnerLogin: true };
  }

  const reviewerId = normalizeId(reviewer._id);
  const node = await PayrollHierarchy.findOne({ owner: ownerId, employee: reviewerId })
    .select('path senior hierarchyLevel')
    .lean();

  if (reviewer.isAdmin && (!node || !node.senior)) {
    const employeeIds = await Employee.find({ owner: ownerId }).distinct('_id');
    return { ownerId, reviewerId, employeeIds, isAdminRoot: true };
  }
  if (!node) return { ownerId, reviewerId, employeeIds: [] };

  const descendants = await PayrollHierarchy.find({
    owner: ownerId,
    path: { $regex: `^${node.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.` },
  }).distinct('employee');

  return { ownerId, reviewerId, employeeIds: descendants };
}

async function payrollRequestFilter(req, extra = {}) {
  const scope = await payrollScope(req);
  return {
    ...extra,
    owner: scope.ownerId,
    employee: { $in: scope.employeeIds },
  };
}

async function canReviewPayrollRequest(req, request) {
  if (!request) return false;
  const scope = await payrollScope(req);
  if (!scope.ownerId || normalizeId(request.owner) !== scope.ownerId) return false;
  const applicantId = normalizeId(request.employee);
  return applicantId !== scope.reviewerId && scope.employeeIds.some(
    (employeeId) => normalizeId(employeeId) === applicantId
  );
}

async function getPayrollSubmissionApprovers(ownerId, applicantId) {
  const node = await PayrollHierarchy.findOne({ owner: ownerId, employee: applicantId })
    .select('senior')
    .lean();
  if (node?.senior) return [node.senior];

  // Unassigned employees go to the seeded payroll admin root so a valid
  // request never becomes invisible while the hierarchy is being configured.
  const roots = await PayrollHierarchy.find({ owner: ownerId, senior: null })
    .select('employee')
    .lean();
  if (roots.length) return roots.map((root) => root.employee);

  const admins = await Employee.find({ owner: ownerId, isAdmin: true })
    .select('_id')
    .lean();
  return admins.map((admin) => admin._id);
}

function payrollReviewGuard(RequestModel) {
  return async (req, res, next) => {
    try {
      const request = await RequestModel.findById(req.params.id)
        .select('employee owner')
        .lean();
      if (!request) return res.status(404).json({ message: 'Payroll request not found' });
      if (!await canReviewPayrollRequest(req, request)) {
        return res.status(403).json({
          message: 'Only a senior in this employee’s Payroll Hierarchy can review this request',
        });
      }
      next();
    } catch (error) {
      res.status(500).json({ message: error.message || 'Failed to verify payroll hierarchy access' });
    }
  };
}

module.exports = {
  ownerIdFromRequest,
  payrollScope,
  payrollRequestFilter,
  canReviewPayrollRequest,
  getPayrollSubmissionApprovers,
  payrollReviewGuard,
};
