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
      // ApplyLeave - populate all fields needed for the detail modal
      ApplyLeave.find({ employee: employeeId, isTrashed: { $ne: true } })
        .populate("employee", "name email role designation photographUrl photoUrl")
        .populate("approvalChain", "name role designation")
        .populate("approvedBy", "name role designation")
        .populate("rejectedBy", "name role designation")
        .populate("appliedBy", "name role designation")
        .lean(),
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

    const populateChain = { path: "approvalChain", select: "name role designation" };
    const populateApprovedBy = { path: "approvedBy", select: "name role designation" };
    const populateRejectedBy = { path: "rejectedBy", select: "name role designation" };
    const populateAppliedBy = { path: "appliedBy", select: "name role designation" };

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
        .populate(populateChain)
        .populate(populateApprovedBy)
        .populate(populateRejectedBy)
        .populate(populateAppliedBy)
        .sort({ createdAt: -1 })
        .lean(),

      // Leaves where this employee already acted (passed up, rejected, or finally approved)
      ApplyLeave.find({
        approvalChain: empObjId,
        isTrashed: { $ne: true },
        $or: [
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
          { rejectedBy: empObjId },
          { approvedBy: empObjId },
        ],
      })
        .populate("employee", populateEmp)
        .populate(populateChain)
        .populate(populateApprovedBy)
        .populate(populateRejectedBy)
        .populate(populateAppliedBy)
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

    // Admin employees also see pending attendance challenges from their org
    let pendingChallenges = [];
    if (req.employee?.isAdmin) {
      const ownerIds = [req.employee.owner, req.employee._id].filter(Boolean);
      pendingChallenges = await AttendanceChallenge.find({
        owner: { $in: ownerIds },
        challengeStatus: "Pending",
      })
        .populate("employee", populateEmp)
        .populate("attendance", "status checkIn checkOut")
        .sort({ createdAt: -1 })
        .lean();

      // Flatten attendance fields onto the challenge document
      pendingChallenges = pendingChallenges.map((c) => ({
        ...c,
        status: c.attendance?.status || c.status,
        checkIn: c.attendance?.checkIn || c.checkIn,
        checkOut: c.attendance?.checkOut || c.checkOut,
        _type: "attendance-challenge",
        canAct: true,
      }));
    }

    // Admin employees also see pending document requests from their org
    let pendingDocRequests = [];
    if (req.employee?.isAdmin) {
      const ownerIds = [req.employee.owner, req.employee._id].filter(Boolean);
      const docs = await DocumentRequest.find({
        owner: { $in: ownerIds },
        status: "pending",
      })
        .populate("employee", populateEmp)
        .sort({ createdAt: -1 })
        .lean();

      pendingDocRequests = docs.map((d) => ({
        ...d,
        _type: d.documentType,
        canAct: true,
      }));
    }

    return res.status(200).json({
      forApproval: [...forApproval, ...pendingChallenges, ...pendingDocRequests],
      escalated: annotatedEscalated,
    });
  } catch (error) {
    console.error("Leave Approvals Error:", error);
    return res.status(500).json({ message: error.message });
  }
};

// ── Unified edit for payroll request types ────────────────────────────────
const TYPE_MODEL_MAP = {
  loan:                LoanRequest,
  bonus:               BonusRequest,
  reimbursement:       ReimbursementRequest,
  advance:             AdvanceSalaryRequest,
  commission:          CommissionRequest,
  "leave-encashment":  LeaveEncashmentRequest,
  "leave-carry-forward": LeaveCarryForwardRequest,
  "overtime-request":  OvertimeRequest,
};

const TYPE_EDITABLE_FIELDS = {
  loan:                ["amount", "period", "reason", "loanCategory", "loanAllowanceField"],
  bonus:               ["amount", "reason"],
  reimbursement:       ["amount", "reason"],
  advance:             ["amount", "reason"],
  commission:          ["amount", "reason"],
  "leave-encashment":  ["days", "encashmentRate", "reason"],
  "leave-carry-forward": ["days", "year", "reason"],
  "overtime-request":  ["hours", "reason"],
};

exports.editPayrollRequest = async (req, res) => {
  try {
    const { type, id } = req.params;
    const employeeId = req.employee?._id;
    if (!employeeId) return res.status(401).json({ message: "Unauthorized" });

    const Model = TYPE_MODEL_MAP[type];
    if (!Model) return res.status(400).json({ message: "Invalid request type" });

    const record = await Model.findOne({ _id: id, employee: employeeId });
    if (!record) return res.status(404).json({ message: "Request not found" });
    if (record.status !== "pending") {
      return res.status(400).json({ message: "Only pending requests can be edited" });
    }

    const allowed = TYPE_EDITABLE_FIELDS[type] || [];
    allowed.forEach((field) => {
      if (req.body[field] !== undefined) record[field] = req.body[field];
    });

    await record.save();
    return res.status(200).json({ message: "Request updated successfully", data: record });
  } catch (error) {
    console.error("Edit Payroll Request Error:", error);
    return res.status(500).json({ message: error.message });
  }
};

exports.withdrawPayrollRequest = async (req, res) => {
  try {
    const { type, id } = req.params;
    const employeeId = req.employee?._id;
    if (!employeeId) return res.status(401).json({ message: "Unauthorized" });

    const Model = TYPE_MODEL_MAP[type];
    if (!Model) return res.status(400).json({ message: "Invalid request type" });

    const record = await Model.findOne({ _id: id, employee: employeeId });
    if (!record) return res.status(404).json({ message: "Request not found" });
    if (record.status !== "pending") {
      return res.status(400).json({ message: "Only pending requests can be withdrawn" });
    }

    record.status = "cancelled";
    await record.save();
    return res.status(200).json({ message: "Request withdrawn successfully" });
  } catch (error) {
    console.error("Withdraw Payroll Request Error:", error);
    return res.status(500).json({ message: error.message });
  }
};
