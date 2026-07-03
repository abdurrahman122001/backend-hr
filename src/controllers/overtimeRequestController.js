const OvertimeRequest = require("../models/OvertimeRequest");
const LeaveYearBalance = require("../models/LeaveYearBalance");
const Attendance = require("../models/Attendance");
const Employee = require("../models/Employees");
const Shift = require("../models/Shift");
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

    if (newRequest.status === "approved") {
      await creditOvertimeBonusHours(newRequest, ownerId);
    }

    res.status(201).json({
      message: newRequest.status === "approved" ? "Overtime request approved successfully" : "Overtime request submitted successfully",
      data: newRequest,
    });
  } catch (error) {
    console.error("Overtime Apply Error:", error);
    res.status(500).json({ message: error.message });
  }
};

/* ─────────────────────────────────────────────────────────────────────────
 * EMPLOYEE: Days eligible for early-arrival overtime.
 * A day qualifies when the employee checked in BEFORE the shift start
 * (e.g. shift starts 15:00, checked in 13:00) AND the checkout happened at
 * 12:00 AM or after (i.e. rolled past midnight into the next day).
 * Days that already have a pending/approved overtime request are excluded.
 * ───────────────────────────────────────────────────────────────────────── */
exports.getEligibleEarlyDays = async (req, res) => {
  try {
    const employeeId = getEmployeeId(req);
    const ownerId = getOwnerId(req);

    const toMin = (hhmm) => {
      if (!hhmm) return null;
      const [hStr, mStr = "0"] = String(hhmm).trim().split(":");
      const h = Number(hStr);
      const m = Number(String(mStr).replace(/[^\d]/g, ""));
      if (Number.isNaN(h) || Number.isNaN(m)) return null;
      return h * 60 + m;
    };

    // Fallback shift start for old records without a shift snapshot
    let fallbackShiftStart = null;
    const employee = await Employee.findById(employeeId).select("shifts").lean();
    if (employee?.shifts?.length) {
      const shift = await Shift.findById(employee.shifts[0]).select("start").lean();
      fallbackShiftStart = shift?.start || null;
    }

    // Look back over the last 6 months (date is stored as "YYYY-MM-DD")
    const sinceDate = new Date();
    sinceDate.setMonth(sinceDate.getMonth() - 6);
    const since = sinceDate.toISOString().slice(0, 10);

    const records = await Attendance.find({
      owner: ownerId,
      employee: employeeId,
      date: { $gte: since },
      checkIn: { $nin: [null, ""] },
      checkOut: { $nin: [null, ""] },
      status: { $in: ["Present", "Late", "Half Day"] },
    })
      .select("date checkIn checkOut shiftStartTime shiftName status")
      .sort({ date: -1 })
      .lean();

    // Exclude days that already have a request (pending or approved)
    const existing = await OvertimeRequest.find({
      employee: employeeId,
      status: { $ne: "rejected" },
    })
      .select("date")
      .lean();
    const requestedDates = new Set(
      existing.map((r) => String(r.date).slice(0, 10))
    );

    const eligible = [];
    for (const rec of records) {
      if (requestedDates.has(String(rec.date).slice(0, 10))) continue;

      const shiftStart = rec.shiftStartTime || fallbackShiftStart;
      const inMin = toMin(rec.checkIn);
      const startMin = toMin(shiftStart);
      const outMin = toMin(rec.checkOut);
      if (inMin == null || startMin == null || outMin == null) continue;

      // Must have arrived before the shift started
      if (inMin >= startMin) continue;

      // Checkout must be 12:00 AM or after — a checkout past midnight shows up
      // as a time "earlier" than the check-in (e.g. in 13:00 → out 00:30)
      const checkedOutAtOrAfterMidnight = outMin < inMin;
      if (!checkedOutAtOrAfterMidnight) continue;

      const earlyMinutes = startMin - inMin;
      eligible.push({
        date: rec.date,
        checkIn: rec.checkIn,
        checkOut: rec.checkOut,
        shiftStart,
        shiftName: rec.shiftName || null,
        status: rec.status,
        earlyMinutes,
        earlyHours: +(earlyMinutes / 60).toFixed(2),
      });
    }

    res.status(200).json({ data: eligible });
  } catch (error) {
    console.error("Overtime EligibleDays Error:", error);
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
    const reviewerId = req.employee?._id || req.user?.employeeId || req.user?.employeeInfo?.employeeId || getUserId(req);

    request.status = status;
    request.adminReason = adminReason || null;
    request.reviewedBy = reviewerId;
    if (status === "approved") {
      request.approvedBy = reviewerId;
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
