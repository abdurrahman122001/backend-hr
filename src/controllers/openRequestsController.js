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
const Employee = require("../models/Employees");
const User = require("../models/Users");
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

const uniqueById = (items = []) => {
  const seen = new Set();
  return items.filter((item) => {
    const id = toIdString(item?._id);
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
};

const toIdString = (value) => {
  if (!value) return null;
  if (typeof value === "object") {
    if (value._id) return String(value._id);
    if (typeof value.toString === "function") {
      const stringValue = value.toString();
      return stringValue && stringValue !== "[object Object]" ? stringValue : null;
    }
    return null;
  }
  return String(value);
};

const getAdminComment = (item) =>
  item.adminComment ||
  item.challengeAdminNotes ||
  item.adminReason ||
  item.adminNote ||
  item.adminResponse ||
  item.approvalNotes ||
  item.rejectionReason ||
  "";

const getAdminActorId = (item) => {
  if (item.reviewedBy) return toIdString(item.reviewedBy);
  if (String(item.status || item.challengeStatus || "").toLowerCase() === "rejected" && item.rejectedBy) {
    return toIdString(item.rejectedBy);
  }
  if (item.approvedBy) return toIdString(item.approvedBy);
  if (item.rejectedBy) return toIdString(item.rejectedBy);
  return null;
};

const actorFromObject = (value) => {
  if (!value || typeof value !== "object" || !(value.name || value.username || value.email || value.companyEmail)) return null;
  return {
    _id: value._id,
    name: value.name || value.username || value.companyEmail || value.email,
    email: value.email || value.companyEmail,
    companyEmail: value.companyEmail,
    designation: value.designation,
    role: value.role,
    photographUrl: value.photographUrl || value.photoUrl,
    photoUrl: value.photoUrl,
  };
};

const getOwnerId = (item) => {
  const owner = item?.owner || item?.employee?.owner;
  return toIdString(owner);
};

async function attachAdminCommentMeta(items = []) {
  const commentItems = items.filter((item) => getAdminComment(item));
  const actorIds = [
    ...new Set(
      commentItems
        .map(getAdminActorId)
        .filter((id) => id && mongoose.isValidObjectId(id))
    ),
  ];
  const ownerIds = [
    ...new Set(
      commentItems
        .map(getOwnerId)
        .filter((id) => id && mongoose.isValidObjectId(id))
    ),
  ];

  const [employees, users, ownerAdmins] = actorIds.length || ownerIds.length
    ? await Promise.all([
        actorIds.length
          ? Employee.find({ _id: { $in: actorIds } })
          .select("name companyEmail email designation role photographUrl photoUrl employeeId")
              .lean()
          : [],
        actorIds.length
          ? User.find({ _id: { $in: actorIds } })
          .select("username email role owner")
              .lean()
          : [],
        ownerIds.length
          ? Employee.find({ owner: { $in: ownerIds }, isAdmin: true })
              .select("name companyEmail email designation role photographUrl photoUrl employeeId owner isAdmin userAccount")
              .lean()
          : [],
      ])
    : [[], [], []];

  const linkedEmployeeClauses = [];
  for (const user of users) {
    linkedEmployeeClauses.push({ userAccount: user._id });
    linkedEmployeeClauses.push({ owner: user._id, isAdmin: true });
    if (user.owner) linkedEmployeeClauses.push({ owner: user.owner, isAdmin: true });
    if (user.email) {
      linkedEmployeeClauses.push({ email: user.email });
      linkedEmployeeClauses.push({ companyEmail: user.email });
    }
  }

  const linkedEmployees = linkedEmployeeClauses.length
    ? await Employee.find({ $or: linkedEmployeeClauses })
        .select("name companyEmail email designation role photographUrl photoUrl employeeId userAccount owner isAdmin")
        .lean()
    : [];

  const employeeMap = new Map(employees.map((emp) => [String(emp._id), emp]));
  const linkedEmployeeByUser = new Map();
  const linkedEmployeeByEmail = new Map();
  const linkedAdminByOwner = new Map();
  for (const emp of [...linkedEmployees, ...ownerAdmins]) {
    if (emp.userAccount) linkedEmployeeByUser.set(String(emp.userAccount), emp);
    if (emp.email) linkedEmployeeByEmail.set(String(emp.email).toLowerCase(), emp);
    if (emp.companyEmail) linkedEmployeeByEmail.set(String(emp.companyEmail).toLowerCase(), emp);
    if (emp.isAdmin && emp.owner && !linkedAdminByOwner.has(String(emp.owner))) {
      linkedAdminByOwner.set(String(emp.owner), emp);
    }
  }
  const userMap = new Map(users.map((user) => {
    const username = String(user.username || "").trim();
    const genericUsername = username.toLowerCase() === "admin";
    return [String(user._id), {
      _id: user._id,
      name: genericUsername ? (user.email || "") : (username || user.email || ""),
      email: user.email,
      role: user.role,
      owner: user.owner,
    }];
  }));

  return items.map((item) => {
    const adminComment = getAdminComment(item);
    if (!adminComment) return item;

    const actorId = getAdminActorId(item);
    const ownerId = getOwnerId(item);
    const userActor = actorId ? userMap.get(actorId) : null;
    const adminActor =
      actorFromObject(item.reviewedBy) ||
      actorFromObject(item.approvedBy) ||
      actorFromObject(item.rejectedBy) ||
      (actorId ? employeeMap.get(actorId) || linkedEmployeeByUser.get(actorId) : null) ||
      (userActor?.email ? linkedEmployeeByEmail.get(String(userActor.email).toLowerCase()) : null) ||
      (userActor?._id ? linkedAdminByOwner.get(String(userActor._id)) : null) ||
      (userActor?.owner ? linkedAdminByOwner.get(String(userActor.owner)) : null) ||
      (ownerId ? linkedAdminByOwner.get(ownerId) : null) ||
      userActor ||
      null;

    return {
      ...item,
      adminComment,
      adminActor,
      ownerAdmin: ownerId ? linkedAdminByOwner.get(ownerId) || null : null,
    };
  });
}

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
    const populateEmp = "name companyEmail email designation department photographUrl photoUrl employeeId owner";

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
      LoanRequest.find(base).populate("employee", populateEmp).lean(),
      BonusRequest.find(base).populate("employee", populateEmp).lean(),
      ReimbursementRequest.find(base).populate("employee", populateEmp).lean(),
      AdvanceSalaryRequest.find(base).populate("employee", populateEmp).lean(),
      SalaryChangeRequest.find(base).populate("employee", populateEmp).lean(),
      CommissionRequest.find(base).populate("employee", populateEmp).lean(),
      TaxAdjustmentRequest.find(base).populate("employee", populateEmp).lean(),
      LeaveEncashmentRequest.find(base).populate("employee", populateEmp).lean(),
      LeaveCarryForwardRequest.find(base).populate("employee", populateEmp).lean(),
      DocumentRequest.find({ ...base, documentType: "salary-slip" }).populate("employee", populateEmp).lean(),
      DocumentRequest.find({ ...base, documentType: "salary-certificate" }).populate("employee", populateEmp).lean(),
      WhistleblowingReport.find({ employee: employeeId }).populate("employee", populateEmp).lean(),
      OvertimeRequest.find(base).populate("employee", populateEmp).lean(),
      ProfileRevision.find(base).populate("employee", populateEmp).lean(),
      // ApplyLeave - populate all fields needed for the detail modal
      ApplyLeave.find({ employee: employeeId, isTrashed: { $ne: true } })
        .populate("employee", "name email companyEmail role designation photographUrl photoUrl employeeId owner")
        .populate("approvalChain", "name role designation")
        .populate("approvedBy", "name companyEmail email role designation photographUrl photoUrl")
        .populate("rejectedBy", "name companyEmail email role designation photographUrl photoUrl")
        .populate("appliedBy", "name role designation")
        .lean(),
      // AttendanceChallenge - get all statuses
      AttendanceChallenge.find({ employee: employeeId })
        .populate("employee", populateEmp)
        .populate("attendance", "status checkIn checkOut totalHours date")
        .lean(),
    ]);

    const overtime = await attachOvertimeAttendance(overtimeRaw);
    const enrichedAttendanceChallenges = attendanceChallenges.map((challenge) => ({
      ...challenge,
      status: challenge.attendance?.status || challenge.status,
      checkIn: challenge.attendance?.checkIn || challenge.checkIn,
      checkOut: challenge.attendance?.checkOut || challenge.checkOut,
      attendanceTotalHours: challenge.attendance?.totalHours,
      attendanceDate: challenge.attendance?.date || challenge.date,
    }));

    const all = await attachAdminCommentMeta([
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
      ...tagRequests(enrichedAttendanceChallenges, "attendance-challenge",  "attendance"),
    ]);

    all.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

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
    const populateEmp = "name companyEmail email designation department photographUrl photoUrl employeeId owner";

    const populateChain = { path: "approvalChain", select: "name companyEmail email role designation photographUrl photoUrl" };
    const populateApprovedBy = { path: "approvedBy", select: "name companyEmail email role designation photographUrl photoUrl" };
    const populateRejectedBy = { path: "rejectedBy", select: "name companyEmail email role designation photographUrl photoUrl" };
    const populateAppliedBy = { path: "appliedBy", select: "name companyEmail email role designation photographUrl photoUrl" };
    const pendingOnly = req.query.pendingOnly === "true";

    const [forApprovalRaw, escalated] = await Promise.all([
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
      pendingOnly ? Promise.resolve([]) : ApplyLeave.find({
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

    const forApproval = forApprovalRaw.map((leave) => ({
      ...leave,
      _type: "leave",
      _category: "attendance",
      canAct: true,
    }));

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
    let closedAdminRequests = [];
    const ownerIds = req.employee?.isAdmin
      ? [req.employee.owner, req.employee._id].filter(Boolean)
      : [];

    // Admin employees also see pending and closed payroll/profile/document/attendance requests from their org.
    if (req.employee?.isAdmin) {
      const adminBase = { owner: { $in: ownerIds }, employee: { $ne: employeeId }, status: "pending" };
      const closedAdminBase = {
        owner: { $in: ownerIds },
        employee: { $ne: employeeId },
        status: { $in: ["approved", "rejected"] },
      };
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
        closedLoans,
        closedBonuses,
        closedReimbursements,
        closedAdvances,
        closedSalaryChanges,
        closedCommissions,
        closedTaxAdjustments,
        closedLeaveEncashments,
        closedLeaveCarryForwards,
        closedOvertimeRaw,
        closedProfileRevisions,
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
        pendingOnly ? Promise.resolve([]) : LoanRequest.find(closedAdminBase).populate("employee", populateEmp).sort({ updatedAt: -1 }).lean(),
        pendingOnly ? Promise.resolve([]) : BonusRequest.find(closedAdminBase).populate("employee", populateEmp).sort({ updatedAt: -1 }).lean(),
        pendingOnly ? Promise.resolve([]) : ReimbursementRequest.find(closedAdminBase).populate("employee", populateEmp).sort({ updatedAt: -1 }).lean(),
        pendingOnly ? Promise.resolve([]) : AdvanceSalaryRequest.find(closedAdminBase).populate("employee", populateEmp).sort({ updatedAt: -1 }).lean(),
        pendingOnly ? Promise.resolve([]) : SalaryChangeRequest.find(closedAdminBase).populate("employee", populateEmp).sort({ updatedAt: -1 }).lean(),
        pendingOnly ? Promise.resolve([]) : CommissionRequest.find(closedAdminBase).populate("employee", populateEmp).sort({ updatedAt: -1 }).lean(),
        pendingOnly ? Promise.resolve([]) : TaxAdjustmentRequest.find(closedAdminBase).populate("employee", populateEmp).sort({ updatedAt: -1 }).lean(),
        pendingOnly ? Promise.resolve([]) : LeaveEncashmentRequest.find(closedAdminBase).populate("employee", populateEmp).sort({ updatedAt: -1 }).lean(),
        pendingOnly ? Promise.resolve([]) : LeaveCarryForwardRequest.find(closedAdminBase).populate("employee", populateEmp).sort({ updatedAt: -1 }).lean(),
        pendingOnly ? Promise.resolve([]) : OvertimeRequest.find(closedAdminBase).populate("employee", populateEmp).sort({ updatedAt: -1 }).lean(),
        pendingOnly ? Promise.resolve([]) : ProfileRevision.find(closedAdminBase).populate("employee", populateEmp).sort({ updatedAt: -1 }).lean(),
      ]);

      const overtime = await attachOvertimeAttendance(overtimeRaw);
      const closedOvertime = pendingOnly ? [] : await attachOvertimeAttendance(closedOvertimeRaw);

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

      closedAdminRequests = [
        ...tagRequests(closedLoans, "loan", "payroll"),
        ...tagRequests(closedBonuses, "bonus", "payroll"),
        ...tagRequests(closedReimbursements, "reimbursement", "payroll"),
        ...tagRequests(closedAdvances, "advance", "payroll"),
        ...tagRequests(closedSalaryChanges, "salary", "payroll"),
        ...tagRequests(closedCommissions, "commission", "payroll"),
        ...tagRequests(closedTaxAdjustments, "tax-adjustment", "payroll"),
        ...tagRequests(closedLeaveEncashments, "leave-encashment", "payroll"),
        ...tagRequests(closedLeaveCarryForwards, "leave-carry-forward", "attendance"),
        ...tagRequests(closedOvertime, "overtime-request", "attendance"),
        ...tagRequests(closedProfileRevisions, "profile", "profile"),
      ].map((item) => ({
        ...item,
        _yourAction: String(item.status || "").toLowerCase() === "rejected" ? "rejected" : "approved",
      }));
    }

    // Admin employees also see pending attendance challenges from their org
    let pendingChallenges = [];
    let closedChallenges = [];
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

      closedChallenges = pendingOnly
        ? []
        : await AttendanceChallenge.find({
            owner: { $in: ownerIds },
            employee: { $ne: employeeId },
            challengeStatus: { $in: ["Approved", "Rejected"] },
          })
            .populate("employee", populateEmp)
            .populate("attendance", "status checkIn checkOut")
            .sort({ updatedAt: -1 })
            .lean();

      closedChallenges = closedChallenges.map((c) => ({
        ...c,
        status: c.attendance?.status || c.status,
        checkIn: c.attendance?.checkIn || c.checkIn,
        checkOut: c.attendance?.checkOut || c.checkOut,
        _type: "attendance-challenge",
        _yourAction: String(c.challengeStatus || "").toLowerCase() === "rejected" ? "rejected" : "approved",
        canAct: false,
      }));
    }

    // Admin employees also see pending document requests from their org
    let pendingDocRequests = [];
    let closedDocRequests = [];
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

      const closedDocs = pendingOnly
        ? []
        : await DocumentRequest.find({
            owner: { $in: ownerIds },
            employee: { $ne: employeeId },
            status: { $in: ["approved", "rejected"] },
          })
            .populate("employee", populateEmp)
            .sort({ updatedAt: -1 })
            .lean();

      closedDocRequests = closedDocs.map((d) => ({
        ...d,
        _type: d.documentType,
        _yourAction: String(d.status || "").toLowerCase() === "rejected" ? "rejected" : "approved",
        canAct: false,
      }));
    }

    if (pendingOnly) {
      return res.status(200).json({
        preApprovals: [],
        forApproval: uniqueById([
          ...forApproval,
          ...pendingAdminRequests,
          ...pendingChallenges,
          ...pendingDocRequests,
        ]),
        escalated: [],
      });
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

    const [forApprovalWithMeta, escalatedWithMeta, preApprovalsWithMeta] = await Promise.all([
      attachAdminCommentMeta(uniqueById([
        ...forApproval,
        ...pendingAdminRequests,
        ...pendingChallenges,
        ...pendingDocRequests,
      ])),
      attachAdminCommentMeta([
        ...annotatedEscalated,
        ...closedAdminRequests,
        ...closedChallenges,
        ...closedDocRequests,
      ]),
      attachAdminCommentMeta(preApprovals),
    ]);

    escalatedWithMeta.sort(
      (a, b) =>
        new Date(b.updatedAt || b.approvedAt || b.reviewedAt || b.createdAt || 0).getTime() -
        new Date(a.updatedAt || a.approvedAt || a.reviewedAt || a.createdAt || 0).getTime()
    );

    return res.status(200).json({
      preApprovals: preApprovalsWithMeta,
      forApproval: forApprovalWithMeta,
      escalated: escalatedWithMeta,
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
