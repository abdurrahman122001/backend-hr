const OvertimeRequest = require("../models/OvertimeRequest");
const LeaveYearBalance = require("../models/LeaveYearBalance");
const { approvedFields } = require("../utils/requestAutoApproval");

const getEmployeeId = (req) => req.employee?._id;
const getOwnerId = (req) => req.employee?.owner || req.user?.owner || req.user?._id;
const getUserId = (req) => req.user?._id;
const resolveOwner = (req) => req.user?.owner || req.user?._id;

async function creditOvertimeBonusHours(request, ownerId) {
  const attendanceYear = new Date(request.date).getFullYear();

  let balance = await LeaveYearBalance.findOne({
    owner: ownerId,
    employee: request.employee,
    year: attendanceYear,
  });

  if (!balance) {
    balance = new LeaveYearBalance({
      owner: ownerId,
      employee: request.employee,
      year: attendanceYear,
      total: 0,
      bonus: 0,
      bonusHoursAccumulated: 0,
      usedPaid: 0,
      usedUnpaid: 0,
      remainingPaid: 0,
    });
  }

  balance.bonusHoursAccumulated = (balance.bonusHoursAccumulated || 0) + request.hours;

  while (balance.bonusHoursAccumulated >= 9) {
    balance.bonusHoursAccumulated -= 9;
    balance.bonus = (balance.bonus || 0) + 1;
  }

  await balance.save();
  return balance;
}

/* ─────────────────────────────────────────────────────────────────────────
 * EMPLOYEE: Submit an overtime request
 * ───────────────────────────────────────────────────────────────────────── */
exports.applyOvertimeRequest = async (req, res) => {
  try {
    const { date, hours, reason } = req.body;
    const employeeId = getEmployeeId(req);
    const ownerId = getOwnerId(req);

    if (!date || !hours || !reason) {
      return res.status(400).json({ message: "Date, hours, and reason are required" });
    }
    if (isNaN(Number(hours)) || Number(hours) < 0.5) {
      return res.status(400).json({ message: "Hours must be at least 0.5" });
    }

    const newRequest = await OvertimeRequest.create({
      employee: employeeId,
      owner: ownerId,
      date,
      hours: Number(hours),
      reason,
      ...approvedFields(req),
    });

    await creditOvertimeBonusHours(newRequest, ownerId);

    res.status(201).json({ message: "Overtime request approved successfully", data: newRequest });
  } catch (error) {
    console.error("Overtime Apply Error:", error);
    res.status(500).json({ message: error.message });
  }
};

/* ─────────────────────────────────────────────────────────────────────────
 * EMPLOYEE: Get my overtime requests
 * ───────────────────────────────────────────────────────────────────────── */
exports.getMyRequests = async (req, res) => {
  try {
    const employeeId = getEmployeeId(req);
    const requests = await OvertimeRequest.find({ employee: employeeId })
      .sort({ createdAt: -1 })
      .lean();
    res.status(200).json({ data: requests });
  } catch (error) {
    console.error("Overtime GetMy Error:", error);
    res.status(500).json({ message: error.message });
  }
};

/* ─────────────────────────────────────────────────────────────────────────
 * ADMIN: Get all overtime requests for owner
 * ───────────────────────────────────────────────────────────────────────── */
exports.getAllRequests = async (req, res) => {
  try {
    const ownerId = resolveOwner(req);
    const { status } = req.query;
    const filter = { owner: ownerId };
    if (status) filter.status = status;

    const requests = await OvertimeRequest.find(filter)
      .populate("employee", "name designation department photographUrl employeeId")
      .sort({ createdAt: -1 })
      .lean();

    res.status(200).json({ data: requests });
  } catch (error) {
    console.error("Overtime GetAll Error:", error);
    res.status(500).json({ message: error.message });
  }
};

/* ─────────────────────────────────────────────────────────────────────────
 * ADMIN: Approve or reject an overtime request
 * When approved: add hours to LeaveYearBalance.bonusHoursAccumulated
 *               every 9 accumulated hours = +1 bonus leave day
 * ───────────────────────────────────────────────────────────────────────── */
exports.updateStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, adminReason } = req.body;
    const ownerId = resolveOwner(req);

    if (!["approved", "rejected"].includes(status)) {
      return res.status(400).json({ message: "Invalid status" });
    }

    const request = await OvertimeRequest.findOne({ _id: id, owner: ownerId });
    if (!request) return res.status(404).json({ message: "Request not found" });

    const wasAlreadyApproved = request.status === "approved";

    request.status = status;
    request.adminReason = adminReason || null;
    if (status === "approved") {
      request.approvedBy = getUserId(req);
      request.approvedAt = new Date();
    }
    await request.save();

    // ── Credit bonus hours on approval (idempotent: skip if already approved) ──
    if (status === "approved" && !wasAlreadyApproved) {
      const attendanceYear = new Date(request.date).getFullYear();

      let balance = await LeaveYearBalance.findOne({
        owner: ownerId,
        employee: request.employee,
        year: attendanceYear,
      });

      if (!balance) {
        balance = new LeaveYearBalance({
          owner: ownerId,
          employee: request.employee,
          year: attendanceYear,
          total: 0,
          bonus: 0,
          bonusHoursAccumulated: 0,
          usedPaid: 0,
          usedUnpaid: 0,
          remainingPaid: 0,
        });
      }

      balance.bonusHoursAccumulated = (balance.bonusHoursAccumulated || 0) + request.hours;

      // Every 9 hours converts to 1 bonus leave day
      while (balance.bonusHoursAccumulated >= 9) {
        balance.bonusHoursAccumulated -= 9;
        balance.bonus = (balance.bonus || 0) + 1;
      }

      await balance.save();
      console.log(
        `✅ [OVERTIME-APPROVED] +${request.hours}h for emp=${request.employee}. ` +
        `Accumulated: ${balance.bonusHoursAccumulated}h, Bonus days: ${balance.bonus}`
      );
    }

    res.status(200).json({ message: `Overtime request ${status}`, data: request });
  } catch (error) {
    console.error("Overtime UpdateStatus Error:", error);
    res.status(500).json({ message: error.message });
  }
};

/* ─────────────────────────────────────────────────────────────────────────
 * EMPLOYEE/ADMIN: Delete a pending overtime request
 * ───────────────────────────────────────────────────────────────────────── */
exports.deleteRequest = async (req, res) => {
  try {
    const { id } = req.params;
    const deleted = await OvertimeRequest.findByIdAndDelete(id);
    if (!deleted) return res.status(404).json({ message: "Request not found" });
    res.status(200).json({ message: "Overtime request deleted" });
  } catch (error) {
    console.error("Overtime Delete Error:", error);
    res.status(500).json({ message: error.message });
  }
};
