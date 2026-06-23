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
const Attendance = require("../models/Attendance");
const EmployeeHierarchy = require("../models/OrgHierarchy");
const mongoose = require("mongoose");

async function getAllJuniorIds(ownerId, seniorId) {
  const visited = new Set();
  const result = [];
  let queue = [String(seniorId)];

  while (queue.length > 0) {
    const links = await EmployeeHierarchy.find({
      owner: ownerId,
      senior: { $in: queue.map((id) => new mongoose.Types.ObjectId(id)) },
    })
      .select("junior")
      .lean();

    queue = [];

    for (const link of links) {
      const juniorId = String(link.junior);
      if (visited.has(juniorId)) continue;
      visited.add(juniorId);
      result.push(new mongoose.Types.ObjectId(juniorId));
      queue.push(juniorId);
    }
  }

  return result;
}

const tagRequests = (items, type, category) =>
  items.map((item) => ({ ...item, _type: type, _category: category }));

async function attachOvertimeAttendance(items = []) {
  const overtimeItems = Array.isArray(items) ? items : [];
  if (overtimeItems.length === 0) return overtimeItems;

  const keys = overtimeItems
    .map((item) => ({
      employee: item.employee?._id || item.employee,
      owner: item.owner,
      date: item.date,
    }))
    .filter((key) => key.employee && key.owner && key.date);

  if (keys.length === 0) return overtimeItems;

  const attendanceRows = await Attendance.find({ $or: keys })
    .select("employee owner date status checkIn checkOut totalHours")
    .lean();

  const attendanceByKey = new Map(
    attendanceRows.map((row) => [
      `${String(row.owner)}:${String(row.employee)}:${row.date}`,
      row,
    ])
  );

  return overtimeItems.map((item) => {
    const employeeId = item.employee?._id || item.employee;
    const attendance = attendanceByKey.get(`${String(item.owner)}:${String(employeeId)}:${item.date}`);
    if (!attendance) return item;

    return {
      ...item,
      attendanceId: attendance._id,
      attendanceStatus: attendance.status,
      checkIn: attendance.checkIn,
      checkOut: attendance.checkOut,
      attendanceTotalHours: attendance.totalHours,
    };
  });
}

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
      overtimeRaw,
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

    const overtime = await attachOvertimeAttendance(overtimeRaw);

    const all = [
      ...tagRequests(loans,                "loan",                  "payroll"),
      ...tagRequests(bonuses,              "bonus",                 "payroll"),
      ...tagRequests(reimbursements,       "reimbursement",         "payroll"),
      ...tagRequests(advances,             "advance",               "payroll"),
      ...tagRequests(salaryChanges,        "salary",                "payroll"),
      ...tagRequests(commissions,          "commission",            "payroll"),
      ...tagRequests(taxAdjustments,       "tax-adjustment",        "payroll"),
      ...tagRequests(leaveEncashments,     "leave-encashment",      "payroll"),
      ...tagRequests(leaveCarryForwards,   "leave-carry-forward",   "attendance"),
      ...tagRequests(salarySlips,          "salary-slip",           "documents"),
      ...tagRequests(salaryCerts,          "salary-certificate",    "documents"),
      ...tagRequests(whistleBlowing,       "whistle-blowing",       "compliance"),
      ...tagRequests(overtime,             "overtime-request",      "attendance"),
      ...tagRequests(profileRevisions,     "profile",               "profile"),
      ...tagRequests(leaves,               "leave",                 "attendance"),
      ...tagRequests(attendanceChallenges, "attendance-challenge",  "attendance"),
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

      const actedApprovalIndex = Array.isArray(leave.approvalChain)
        ? leave.approvalChain.findIndex((approver) => {
            const id = approver?._id ? String(approver._id) : String(approver);
            return id === empIdStr;
          })
        : -1;

      return {
        ...leave,
        _yourAction: yourAction,
        _actedApprovalIndex: actedApprovalIndex >= 0 ? actedApprovalIndex : undefined,
      };
    });

    let pendingAdminRequests = [];
    const ownerIds = req.employee?.isAdmin
      ? [req.employee.owner, req.employee._id].filter(Boolean)
      : [];

    // Admin employees also see pending payroll/profile requests from their org
    if (req.employee?.isAdmin) {
      const adminBase = { owner: { $in: ownerIds }, employee: { $ne: employeeId }, status: "pending" };
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
        overtimeRaw,
        profileRevisions,
      ] = await Promise.all([
        LoanRequest.find(adminBase).populate("employee", populateEmp).sort({ createdAt: -1 }).lean(),
        BonusRequest.find(adminBase).populate("employee", populateEmp).sort({ createdAt: -1 }).lean(),
        ReimbursementRequest.find(adminBase).populate("employee", populateEmp).sort({ createdAt: -1 }).lean(),
        AdvanceSalaryRequest.find(adminBase).populate("employee", populateEmp).sort({ createdAt: -1 }).lean(),
        SalaryChangeRequest.find(adminBase).populate("employee", populateEmp).sort({ createdAt: -1 }).lean(),
        CommissionRequest.find(adminBase).populate("employee", populateEmp).sort({ createdAt: -1 }).lean(),
        TaxAdjustmentRequest.find(adminBase).populate("employee", populateEmp).sort({ createdAt: -1 }).lean(),
        LeaveEncashmentRequest.find(adminBase).populate("employee", populateEmp).sort({ createdAt: -1 }).lean(),
        LeaveCarryForwardRequest.find(adminBase).populate("employee", populateEmp).sort({ createdAt: -1 }).lean(),
        OvertimeRequest.find(adminBase).populate("employee", populateEmp).sort({ createdAt: -1 }).lean(),
        ProfileRevision.find(adminBase).populate("employee", populateEmp).sort({ createdAt: -1 }).lean(),
      ]);

      const overtime = await attachOvertimeAttendance(overtimeRaw);

      pendingAdminRequests = [
        ...tagRequests(loans, "loan", "payroll"),
        ...tagRequests(bonuses, "bonus", "payroll"),
        ...tagRequests(reimbursements, "reimbursement", "payroll"),
        ...tagRequests(advances, "advance", "payroll"),
        ...tagRequests(salaryChanges, "salary", "payroll"),
        ...tagRequests(commissions, "commission", "payroll"),
        ...tagRequests(taxAdjustments, "tax-adjustment", "payroll"),
        ...tagRequests(leaveEncashments, "leave-encashment", "payroll"),
        ...tagRequests(leaveCarryForwards, "leave-carry-forward", "attendance"),
        ...tagRequests(overtime, "overtime-request", "attendance"),
        ...tagRequests(profileRevisions, "profile", "profile"),
      ];
    }

    // Admin employees also see pending attendance challenges from their org
    let pendingChallenges = [];
    if (req.employee?.isAdmin) {
      pendingChallenges = await AttendanceChallenge.find({
        owner: { $in: ownerIds },
        employee: { $ne: employeeId },
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
      const docs = await DocumentRequest.find({
        owner: { $in: ownerIds },
        employee: { $ne: employeeId },
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

    const ownerId = req.employee.owner;
    const juniorIds = ownerId ? await getAllJuniorIds(ownerId, employeeId) : [];
    let preApprovals = [];

    if (juniorIds.length > 0) {
      const preLeaves = await ApplyLeave.find({
        status: "pending",
        approvalChain: { $in: juniorIds },
        isTrashed: { $ne: true },
        $expr: {
          $in: [
            { $arrayElemAt: ["$approvalChain", "$currentApprovalIndex"] },
            juniorIds,
          ],
        },
      })
        .populate("employee", populateEmp)
        .populate(populateChain)
        .populate(populateApprovedBy)
        .populate(populateRejectedBy)
        .populate(populateAppliedBy)
        .sort({ createdAt: -1 })
        .lean();

      preApprovals = tagRequests(preLeaves, "leave", "attendance");
    }

    return res.status(200).json({
      preApprovals,
      forApproval: [...forApproval, ...pendingAdminRequests, ...pendingChallenges, ...pendingDocRequests],
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
