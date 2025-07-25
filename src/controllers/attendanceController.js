const mongoose = require("mongoose");
const { backfillForDate } = require("../backfillAttendance");
const Employee = require("../models/Employees");
const PayrollPeriod = require("../models/PayrollPeriod");
const SalarySlip = require("../models/SalarySlip");
const Attendance = require("../models/Attendance");
const { decrypt, encrypt } = require("../utils/encryption");
const {
  updateLeaveEntitlementForEmployee,
} = require("../utils/leaveEntitlement");
const Salaries = require("../models/Salaries");
exports.markAttendance = async (req, res) => {
  try {
    const ownerId = req.user._id;
    const { employeeId, date, status, checkIn, checkOut, notes, leaveType } =
      req.body;

    // 1. Mark attendance
    const updateDoc = {
      $set: {
        owner: ownerId,
        employee: employeeId,
        date,
        status,
        checkIn,
        checkOut,
        notes,
        markedByHR: true,
      },
    };
    if (status === "Absent") {
      updateDoc.$set.leaveType = leaveType || "Unpaid";
    } else {
      updateDoc.$unset = { leaveType: "" };
    }

    const rec = await Attendance.findOneAndUpdate(
      { owner: ownerId, employee: employeeId, date },
      updateDoc,
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    // 2. Get employee info
    const employee = await Employee.findById(employeeId).lean();
    if (!employee)
      return res.status(404).json({ error: "Employee not found." });

    // 3. Find payroll period for the attendance date
    const allPayrolls = await PayrollPeriod.find({
      owner: employee.owner,
    }).lean();
    const shiftId = employee.shifts?.[0];
    const payroll = allPayrolls.find(
      (p) =>
        Array.isArray(p.shifts) &&
        p.shifts.map(String).includes(String(shiftId))
    );
    if (!payroll)
      return res.status(404).json({ error: "Payroll period not found." });

    // Payroll period calculation
    const attendanceDate = new Date(date);
    const anchor = new Date(payroll.payrollPeriodStartDay);

    let periodStart, periodEnd;
    if (payroll.payrollPeriodType === "monthly") {
      const anchorDay = anchor.getDate();
      let thisMonthStart = new Date(
        attendanceDate.getFullYear(),
        attendanceDate.getMonth(),
        anchorDay
      );
      if (attendanceDate >= thisMonthStart) {
        periodStart = thisMonthStart;
      } else {
        periodStart = new Date(
          attendanceDate.getFullYear(),
          attendanceDate.getMonth() - 1,
          anchorDay
        );
      }
      periodEnd = new Date(
        periodStart.getFullYear(),
        periodStart.getMonth() + 1,
        periodStart.getDate()
      );
      periodEnd.setDate(periodEnd.getDate() - 1);
    } else {
      let length = payroll.payrollPeriodLength;
      if (payroll.payrollPeriodType === "weekly") length = 7;
      if (payroll.payrollPeriodType === "bimonthly") length = 15;
      if (payroll.payrollPeriodType === "10-days") length = 10;
      let diff = Math.floor((attendanceDate - anchor) / (1000 * 60 * 60 * 24));
      let cycles = Math.floor(diff / length);
      periodStart = new Date(anchor);
      periodStart.setDate(anchor.getDate() + cycles * length);
      periodEnd = new Date(periodStart);
      periodEnd.setDate(periodEnd.getDate() + length - 1);
    }
    const start = periodStart.toISOString().slice(0, 10);
    const end = periodEnd.toISOString().slice(0, 10);

    const payrollMonth = periodEnd.toLocaleString("en-US", { month: "long" });
    const payrollYear = periodEnd.getFullYear().toString();

    // 4. Fetch or create SalarySlip for this employee, payrollMonth, payrollYear
    let slip = await SalarySlip.findOne({
      owner: ownerId,
      employee: employeeId,
      month: payrollMonth,
      year: payrollYear,
    }); // DO NOT use .lean() here!
    if (!slip) {
      // Get Salaries doc (use ownerId for multi-tenant safety)
      const salaryDoc = await Salaries.findOne({
        employee: employeeId,
        owner: ownerId,
      });
      if (!salaryDoc) {
        return res
          .status(404)
          .json({ error: "Salary structure not found for employee." });
      }
      const allowanceFields = [
        "basic",
        "dearnessAllowance",
        "houseRentAllowance",
        "conveyanceAllowance",
        "medicalAllowance",
        "utilityAllowance",
        "overtimeCompensation",
        "dislocationAllowance",
        "leaveEncashment",
        "bonus",
        "arrears",
        "autoAllowance",
        "incentive",
        "fuelAllowance",
        "othersAllowances",
        "grossSalary",
      ];
      const slipData = {
        owner: ownerId,
        employee: employeeId,
        month: payrollMonth,
        year: payrollYear,
        lateDeductionDaysCredited: 0,
      };
      allowanceFields.forEach((f) => (slipData[f] = salaryDoc[f] || ""));
      slip = await SalarySlip.create(slipData);
    }

    // 5. Get gross salary for calculation
    let grossSalary = 0;
    if (slip.grossSalary) {
      grossSalary = Number(await decrypt(slip.grossSalary));
    }
    const totalWorkingDays = 22; // Can be dynamic
    const perDay = grossSalary / totalWorkingDays;

    // 6. Absence deduction logic (unchanged)
    if (status === "Absent") {
      const result = await updateLeaveEntitlementForEmployee(employeeId, 1);
      if (result.unpaid > 0) {
        let prevDeduction = 0;
        if (slip.leaveDeductions) {
          prevDeduction = Number(await decrypt(slip.leaveDeductions)) || 0;
        }
        const leaveDeduction = Math.round(
          perDay * result.unpaid + prevDeduction
        );
        slip.leaveDeductions = await encrypt(leaveDeduction.toString());
        await slip.save();
      }
    }

    // 7. LATE DEDUCTION LOGIC (fixed and always persists)
    if (status === "Late") {
      const lateRecords = await Attendance.find({
        employee: employeeId,
        date: { $gte: start, $lte: end },
        status: "Late",
      });
      const lateCount = lateRecords.length;
      const lateDeductionDays = Math.floor(lateCount / 3);
      const previouslyCredited = slip.lateDeductionDaysCredited || 0;
      const newLateDeductionDays = lateDeductionDays - previouslyCredited;

      console.log({
        lateCount,
        lateDeductionDays,
        previouslyCredited,
        newLateDeductionDays,
        slipId: slip._id,
      });

      if (newLateDeductionDays > 0) {
        // THIS must handle when paid leaves are already fully used
        const result = await updateLeaveEntitlementForEmployee(
          employeeId,
          newLateDeductionDays,
          "late"
        );
        console.log("Leave Entitlement Result:", result);
        // You want: result.unpaid === newLateDeductionDays if no paid leaves left

        let prevLateDeduction = 0;
        if (slip.lateDeductions) {
          prevLateDeduction = Number(await decrypt(slip.lateDeductions)) || 0;
        }
        const deductionDays = result.unpaid || 0; // Must be nonzero if no paid leaves left
        const newDeductionAmount = Math.round(perDay * deductionDays);
        slip.lateDeductions = await encrypt(
          (prevLateDeduction + newDeductionAmount).toString()
        );

        // Persist new deduction state
        slip.lateDeductionDaysCredited = lateDeductionDays;
        await slip.save();

        // Debug: check persisted value right now
        const slipAfter = await SalarySlip.findById(slip._id);
        console.log(
          "Persisted lateDeductionDaysCredited:",
          slipAfter.lateDeductionDaysCredited
        );
      }
    }

    // 6b. Half Day deduction logic (new addition)
if (status === "Half Day") {
  // Call the leave updater with 0.5
  const result = await updateLeaveEntitlementForEmployee(employeeId, 0.5);
  if (result.unpaid > 0) {
    let prevDeduction = 0;
    if (slip.leaveDeductions) {
      prevDeduction = Number(await decrypt(slip.leaveDeductions)) || 0;
    }
    // Deduct half-day salary per 0.5 unpaid (if no paid leave left)
    const leaveDeduction = Math.round((perDay / 2) * result.unpaid + prevDeduction);
    slip.leaveDeductions = await encrypt(leaveDeduction.toString());
    await slip.save();
  }
}


    // 9. Respond
    res.json(rec);
  } catch (err) {
    console.error("Error in markAttendance:", err);
    res.status(400).json({ error: err.message });
  }
};

// GET /api/attendance?date=YYYY-MM-DD
exports.getRecordsByDate = async (req, res) => {
  const { date } = req.query;
  if (!date) {
    return res.status(400).json({ error: "date query parameter is required" });
  }
  try {
    await backfillForDate(date, req.user._id);

    const records = await Attendance.find({
      owner: new mongoose.Types.ObjectId(req.user._id),
      date,
    })
      .populate("employee", "name designation department email")
      .lean();

    res.json(records);
  } catch (err) {
    console.error("Error in getRecordsByDate:", err);
    res.status(500).json({ error: err.message });
  }
};

// GET /api/attendance?from=YYYY-MM-DD&to=YYYY-MM-DD
exports.getRecordsByDateRange = async (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) {
    return res.status(400).json({ error: "Both 'from' and 'to' are required" });
  }
  try {
    const records = await Attendance.find({
      owner: new mongoose.Types.ObjectId(req.user._id),
      date: { $gte: from, $lte: to },
    })
      .populate("employee", "name position department")
      .lean();

    res.json(records);
  } catch (err) {
    console.error("Error in getRecordsByDateRange:", err);
    res.status(500).json({ error: err.message });
  }
};

// GET /api/attendance/stats?date=YYYY-MM-DD
exports.getStats = async (req, res) => {
  try {
    const { date } = req.query;
    const stats = await Attendance.aggregate([
      {
        $match: {
          owner: new mongoose.Types.ObjectId(req.user._id),
          date,
        },
      },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]);

    const result = { present: 0, late: 0, halfDay: 0, absent: 0, total: 0 };
    stats.forEach(({ _id, count }) => {
      const key = _id === "Half Day" ? "halfDay" : _id.toLowerCase();
      result[key] = count;
      result.total += count;
    });

    res.json(result);
  } catch (err) {
    console.error("Error in getStats:", err);
    res.status(500).json({ error: err.message });
  }
};

// GET /api/attendance/employee/:id
exports.getRecordsByEmployee = async (req, res) => {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) {
    return res.status(400).json({ error: "Invalid employee ID" });
  }
  try {
    const records = await Attendance.find({
      owner: new mongoose.Types.ObjectId(req.user._id),
      employee: new mongoose.Types.ObjectId(id),
    })
      .sort("date")
      .populate("employee", "name position department")
      .lean();

    res.json(records);
  } catch (err) {
    console.error("Error in getRecordsByEmployee:", err);
    res.status(500).json({ error: err.message });
  }
};

// GET /api/attendance/employee/:id/stats?from=...&to=...
exports.getStatsByEmployee = async (req, res) => {
  const { id } = req.params;
  const { from, to } = req.query;
  if (!mongoose.isValidObjectId(id)) {
    return res.status(400).json({ error: "Invalid employee ID" });
  }
  try {
    const match = {
      owner: new mongoose.Types.ObjectId(req.user._id),
      employee: new mongoose.Types.ObjectId(id),
    };
    if (from && to) {
      match.date = { $gte: from, $lte: to };
    }

    const stats = await Attendance.aggregate([
      { $match: match },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]);

    const result = { present: 0, late: 0, halfDay: 0, absent: 0, total: 0 };
    stats.forEach(({ _id, count }) => {
      const key = _id === "Half Day" ? "halfDay" : _id.toLowerCase();
      result[key] = count;
      result.total += count;
    });

    res.json(result);
  } catch (err) {
    console.error("Error in getStatsByEmployee:", err);
    res.status(500).json({ error: err.message });
  }
};
exports.deleteRecord = async (req, res) => {
  const { id } = req.params;
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(400).json({ error: "Invalid record ID" });
  }
  try {
    const deleted = await Attendance.findOneAndDelete({
      _id: id,
      owner: req.user._id,
    });
    if (!deleted) {
      return res.status(404).json({ error: "Record not found" });
    }
    res.json({ success: true });
  } catch (err) {
    console.error("Error in deleteRecord:", err);
    res.status(500).json({ error: err.message });
  }
};
