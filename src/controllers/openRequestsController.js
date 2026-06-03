const LoanRequest = require("../models/LoanRequest");
const BonusRequest = require("../models/BonusRequest");
const ReimbursementRequest = require("../models/ReimbursementRequest");
const AdvanceSalaryRequest = require("../models/AdvanceSalaryRequest");
const SalaryChangeRequest = require("../models/SalaryChangeRequest");
const CommissionRequest = require("../models/CommissionRequest");
const TaxAdjustmentRequest = require("../models/TaxAdjustmentRequest");
const LeaveEncashmentRequest = require("../models/LeaveEncashmentRequest");
const LeaveCarryForwardRequest = require("../models/LeaveCarryForwardRequest");
const DocumentRequest = require("../models/DocumentRequest");
const WhistleblowingReport = require("../models/WhistleblowingReport");
const OvertimeRequest = require("../models/OvertimeRequest");
const ProfileRevision = require("../models/ProfileRevision");
const ApplyLeave = require("../models/ApplyLeave");
const AttendanceChallenge = require("../models/AttendanceChallenge");
const mongoose = require("mongoose");

exports.getMyOpenRequests = async (req, res) => {
  try {
    const employeeId = req.employee?._id;
    if (!employeeId) return res.status(401).json({ message: "Unauthorized" });

    const base = { employee: employeeId };

    const [
      loans,
      bonuses,
      reimbursements,
      advances,
      salaryChanges,
      commissions,
      taxAdjustments,
      leaveEncashments,
      leaveCarryForwards,
      salarySlips,
      salaryCerts,
      whistleBlowing,
      overtime,
      profileRevisions,
      leaves,
      attendanceChallenges,
    ] = await Promise.all([
      LoanRequest.find(base).lean(),
      BonusRequest.find(base).lean(),
      ReimbursementRequest.find(base).lean(),
      AdvanceSalaryRequest.find(base).lean(),
      SalaryChangeRequest.find(base).lean(),
      CommissionRequest.find(base).lean(),
      TaxAdjustmentRequest.find(base).lean(),
      LeaveEncashmentRequest.find(base).lean(),
      LeaveCarryForwardRequest.find(base).lean(),
      DocumentRequest.find({ ...base, documentType: "salary-slip" }).lean(),
      DocumentRequest.find({ ...base, documentType: "salary-certificate" }).lean(),
      WhistleblowingReport.find({ employee: employeeId }).lean(),
      OvertimeRequest.find(base).lean(),
      ProfileRevision.find(base).lean(),
      // ApplyLeave - filter out trashed but get all statuses
      ApplyLeave.find({ employee: employeeId, isTrashed: { $ne: true } }).lean(),
      // AttendanceChallenge - get all statuses
      AttendanceChallenge.find({ employee: employeeId }).lean(),
    ]);

    const tag = (items, type, category) =>
      items.map((item) => ({ ...item, _type: type, _category: category }));

    const all = [
      ...tag(loans,                "loan",                  "payroll"),
      ...tag(bonuses,              "bonus",                 "payroll"),
      ...tag(reimbursements,       "reimbursement",         "payroll"),
      ...tag(advances,             "advance",               "payroll"),
      ...tag(salaryChanges,        "salary",                "payroll"),
      ...tag(commissions,          "commission",            "payroll"),
      ...tag(taxAdjustments,       "tax-adjustment",        "payroll"),
      ...tag(leaveEncashments,     "leave-encashment",      "payroll"),
      ...tag(leaveCarryForwards,   "leave-carry-forward",   "attendance"),
      ...tag(salarySlips,          "salary-slip",           "documents"),
      ...tag(salaryCerts,          "salary-certificate",    "documents"),
      ...tag(whistleBlowing,       "whistle-blowing",       "compliance"),
      ...tag(overtime,             "overtime-request",      "attendance"),
      ...tag(profileRevisions,     "profile",               "profile"),
      ...tag(leaves,               "leave",                 "attendance"),
      ...tag(attendanceChallenges, "attendance-challenge",  "attendance"),
    ].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    return res.status(200).json({ data: all, total: all.length });
  } catch (error) {
    console.error("Open Requests Error:", error);
    return res.status(500).json({ message: error.message });
  }
};

exports.getLeaveApprovals = async (req, res) => {
  try {
    const employeeId = req.employee?._id;
    if (!employeeId) return res.status(401).json({ message: "Unauthorized" });

    const empObjId = new mongoose.Types.ObjectId(String(employeeId));
    const empIdStr = String(empObjId);
    const populateEmp = "name designation department photographUrl";

    const [forApproval, escalated] = await Promise.all([
      // Pending leaves where it is THIS employee's turn to approve
      ApplyLeave.find({
        status: "pending",
        approvalChain: empObjId,
        isTrashed: { $ne: true },
        $expr: {
          $eq: [
            { $indexOfArray: ["$approvalChain", empObjId] },
            "$currentApprovalIndex",
          ],
        },
      })
        .populate("employee", populateEmp)
        .sort({ createdAt: -1 })
        .lean(),

      // Leaves where this employee already acted (passed up, rejected, or finally approved)
      ApplyLeave.find({
        approvalChain: empObjId,
        isTrashed: { $ne: true },
        $or: [
          // Still pending but their turn already passed (forwarded to next approver)
          {
            status: "pending",
            $expr: {
              $and: [
                { $gt: [{ $indexOfArray: ["$approvalChain", empObjId] }, -1] },
                {
                  $lt: [
                    { $indexOfArray: ["$approvalChain", empObjId] },
                    "$currentApprovalIndex",
                  ],
                },
              ],
            },
          },
          // They rejected it
          { rejectedBy: empObjId },
          // They were the final approver
          { approvedBy: empObjId },
        ],
      })
        .populate("employee", populateEmp)
        .sort({ updatedAt: -1 })
        .lean(),
    ]);

    // Annotate each escalated item with what action the current employee took
    const annotatedEscalated = escalated.map((leave) => {
      let yourAction = "forwarded";
      const approverId =
        leave.approvedBy?._id
          ? String(leave.approvedBy._id)
          : leave.approvedBy
            ? String(leave.approvedBy)
            : null;
      const rejecterId =
        leave.rejectedBy?._id
          ? String(leave.rejectedBy._id)
          : leave.rejectedBy
            ? String(leave.rejectedBy)
            : null;

      if (approverId === empIdStr) yourAction = "approved";
      else if (rejecterId === empIdStr) yourAction = "rejected";

      return { ...leave, _yourAction: yourAction };
    });

    return res.status(200).json({
      forApproval,
      escalated: annotatedEscalated,
    });
  } catch (error) {
    console.error("Leave Approvals Error:", error);
    return res.status(500).json({ message: error.message });
  }
};
