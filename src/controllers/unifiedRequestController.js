const mongoose = require("mongoose");
const LeaveRequest = require("../models/ApplyLeave");
const LoanRequest = require("../models/LoanRequest");
const SalaryChangeRequest = require("../models/SalaryChangeRequest");
const AdvanceSalaryRequest = require("../models/AdvanceSalaryRequest");
const ReimbursementRequest = require("../models/ReimbursementRequest");
const CommissionRequest = require("../models/CommissionRequest");
const TaxAdjustmentRequest = require("../models/TaxAdjustmentRequest");
const BonusRequest = require("../models/BonusRequest");
const LeaveEncashmentRequest = require("../models/LeaveEncashmentRequest");
const LeaveCarryForwardRequest = require("../models/LeaveCarryForwardRequest");
const Attendance = require("../models/Attendance");
const SalaryRevisionHistory = require("../models/SalaryRevisionHistory");
const Employee = require("../models/Employees");
const { decrypt } = require("../utils/encryption");

// Helper to safely parse numbers
const toNum = (v) => {
  if (v === null || v === undefined) return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const n = Number(String(v).replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : 0;
};

// Helper to decrypt salary value
const decryptValue = async (encryptedValue) => {
  if (!encryptedValue || encryptedValue === "") return 0;
  try {
    const decrypted = await decrypt(encryptedValue);
    return toNum(decrypted);
  } catch (err) {
    return 0;
  }
};

exports.getUnifiedToDoList = async (req, res) => {
  try {
    const ownerId = req.user.owner;
    const { limit = 5, skip = 0, status = "pending" } = req.query;
    
    const parsedLimit = parseInt(limit);
    const parsedSkip = parseInt(skip);

    // Get all employee IDs for this owner to filter models that don't have direct owner field
    const ownerEmployees = await Employee.find({ owner: new mongoose.Types.ObjectId(ownerId) }).select("_id");
    const employeeIds = ownerEmployees.map(emp => emp._id);

    // Common Match for most models
    const baseMatch = { owner: new mongoose.Types.ObjectId(ownerId) };
    if (status !== "all") {
      baseMatch.status = status;
    }

    // Leave Match (Uses employee IDs as it lacks direct owner field)
    const leaveMatch = { employee: { $in: employeeIds } };
    if (status !== "all") {
      leaveMatch.status = status;
    }

    // Attendance Match
    const attendanceMatch = { owner: new mongoose.Types.ObjectId(ownerId) };
    if (status === "pending") {
      attendanceMatch.challengeStatus = "Pending";
    } else if (status !== "all") {
      attendanceMatch.challengeStatus = status.charAt(0).toUpperCase() + status.slice(1);
    } else {
        attendanceMatch.challengeStatus = { $exists: true, $ne: "None" };
    }

// Counts
     const counts = await Promise.all([
         LeaveRequest.countDocuments(leaveMatch),
         LoanRequest.countDocuments(baseMatch),
         SalaryChangeRequest.countDocuments(baseMatch),
         AdvanceSalaryRequest.countDocuments(baseMatch),
         ReimbursementRequest.countDocuments(baseMatch),
         CommissionRequest.countDocuments(baseMatch),
         TaxAdjustmentRequest.countDocuments(baseMatch),
         BonusRequest.countDocuments(baseMatch),
         LeaveEncashmentRequest.countDocuments(baseMatch),
         LeaveCarryForwardRequest.countDocuments(baseMatch),
         Attendance.countDocuments(attendanceMatch),
         status === "pending" ? 0 : SalaryRevisionHistory.countDocuments({ owner: new mongoose.Types.ObjectId(ownerId) })
     ]);

    const totalCount = counts.reduce((acc, curr) => acc + curr, 0);

    // Fetching data - fetch enough from each to sort across types
    const fetchLimit = parsedSkip + parsedLimit + 10; 

    // 1. Leave Requests
    const leavePromise = LeaveRequest.find(leaveMatch)
      .populate("employee", "name department designation photographUrl")
      .populate("approvalChain", "name designation role")
      .populate("supervisor", "name designation role")
      .sort({ createdAt: -1 })
      .limit(fetchLimit);

    // 2. Loan Requests
    const loanPromise = LoanRequest.find(baseMatch)
      .populate("employee", "name department designation photographUrl")
      .sort({ createdAt: -1 })
      .limit(fetchLimit);

    // 3. Salary Change Requests
    const salaryChangePromise = SalaryChangeRequest.find(baseMatch)
      .populate("employee", "name department designation photographUrl")
      .sort({ createdAt: -1 })
      .limit(fetchLimit);

    // 4. Advance Salary Requests
    const advanceSalaryPromise = AdvanceSalaryRequest.find(baseMatch)
      .populate("employee", "name department designation photographUrl")
      .sort({ createdAt: -1 })
      .limit(fetchLimit);

    // 5. Reimbursement Requests
    const reimbursementPromise = ReimbursementRequest.find(baseMatch)
      .populate("employee", "name department designation photographUrl")
      .sort({ createdAt: -1 })
      .limit(fetchLimit);

// 6. Commission Requests
     const commissionPromise = CommissionRequest.find(baseMatch)
       .populate("employee", "name department designation photographUrl")
       .sort({ createdAt: -1 })
       .limit(fetchLimit);

     // 7. Tax Adjustment Requests
     const taxAdjustmentPromise = TaxAdjustmentRequest.find(baseMatch)
       .populate("employee", "name department designation photographUrl")
       .sort({ createdAt: -1 })
       .limit(fetchLimit);

     // 8. Bonus Requests
     const bonusPromise = BonusRequest.find(baseMatch)
       .populate("employee", "name department designation photographUrl")
       .sort({ createdAt: -1 })
       .limit(fetchLimit);

     // 9. Leave Encashment Requests
     const leaveEncashmentPromise = LeaveEncashmentRequest.find(baseMatch)
       .populate("employee", "name department designation photographUrl")
       .sort({ createdAt: -1 })
       .limit(fetchLimit);

     // 10. Leave Carry Forward Requests
     const leaveCarryForwardPromise = LeaveCarryForwardRequest.find(baseMatch)
       .populate("employee", "name department designation photographUrl")
       .sort({ createdAt: -1 })
       .limit(fetchLimit);

    // 11. Attendance Challenges
    const attendancePromise = Attendance.find(attendanceMatch)
      .populate("employee", "name department designation photographUrl")
      .sort({ challengeAt: -1 })
      .limit(fetchLimit);

    // 7. Salary Revision History
    const promotionPromise = (status === "pending") ? Promise.resolve([]) : SalaryRevisionHistory.find({ owner: new mongoose.Types.ObjectId(ownerId) })
      .populate("employee", "name department designation photographUrl")
      .sort({ revisionDate: -1 })
      .limit(fetchLimit);

const [leaves, loans, salaryChanges, advanceSalaries, reimbursements, commissions, taxAdjustments, bonuses, leaveEncashments, leaveCarryForwards, attendances, promotions] = await Promise.all([
       leavePromise,
       loanPromise,
       salaryChangePromise,
       advanceSalaryPromise,
       reimbursementPromise,
       commissionPromise,
       taxAdjustmentPromise,
       bonusPromise,
       leaveEncashmentPromise,
       leaveCarryForwardPromise,
       attendancePromise,
       promotionPromise
     ]);

    // Transform and Unified Format
    const unifiedList = [];

    // Add Leaves
    leaves.forEach(item => {
      const isAwaitingSenior = item.supervisor &&
        item.supervisor.role !== "admin" &&
        item.supervisor.role !== "hr";

      unifiedList.push({
        _id: item._id,
        type: "leave",
        typeLabel: item.leaveTypeLabel || item.leaveType,
        employee: item.employee,
        status: item.status,
        date: item.createdAt || item.appliedDate,
        amount: (item.totalDays || 0) + " day(s)",
        reason: item.reason,
        policyConcerns: item.policyAnalysis?.violations?.length || 0,
        awaitingSenior: isAwaitingSenior,
        originalData: { ...item.toObject(), awaitingSenior: isAwaitingSenior }
      });
    });

    // Add Loans
    loans.forEach(item => {
      unifiedList.push({
        _id: item._id,
        type: "loan",
        typeLabel: "Loan Request",
        employee: item.employee,
        status: item.status,
        date: item.createdAt,
        amount: "PKR " + (item.amount?.toLocaleString() || "0"),
        reason: item.reason,
        originalData: item
      });
    });

    // Add Salary Changes
    salaryChanges.forEach(item => {
      unifiedList.push({
        _id: item._id,
        type: "salary-change",
        typeLabel: "Salary Revision",
        employee: item.employee,
        status: item.status,
        date: item.createdAt,
        amount: "New Gross: PKR " + (item.proposedSalary?.grossSalary?.toLocaleString() || "0"),
        reason: item.reason,
        originalData: item
      });
    });

    // Add Advance Salaries
    advanceSalaries.forEach(item => {
      unifiedList.push({
        _id: item._id,
        type: "advance-salary",
        typeLabel: "Advance Salary",
        employee: item.employee,
        status: item.status,
        date: item.createdAt,
        amount: "PKR " + (item.amount?.toLocaleString() || "0"),
        reason: item.reason,
        originalData: item
      });
    });

    // Add Reimbursements
    reimbursements.forEach(item => {
      unifiedList.push({
        _id: item._id,
        type: "reimbursement",
        typeLabel: "Reimbursement",
        employee: item.employee,
        status: item.status,
        date: item.createdAt,
        amount: "PKR " + (item.amount?.toLocaleString() || "0"),
        reason: item.reason,
        originalData: item
      });
    });

// Add Commissions
     commissions.forEach(item => {
       unifiedList.push({
         _id: item._id,
         type: "commission",
         typeLabel: "Commission",
         employee: item.employee,
         status: item.status,
         date: item.createdAt,
         amount: "PKR " + (item.amount?.toLocaleString() || "0"),
         reason: item.reason,
         originalData: item
       });
     });

     // Add Tax Adjustments
     taxAdjustments.forEach(item => {
       unifiedList.push({
         _id: item._id,
         type: "tax-adjustment",
         typeLabel: "Tax Adjustment",
         employee: item.employee,
         status: item.status,
         date: item.createdAt,
         amount: item.payrollMonth,
         reason: item.reason,
         originalData: item
       });
     });

     // Add Bonuses
     bonuses.forEach(item => {
       unifiedList.push({
         _id: item._id,
         type: "bonus",
         typeLabel: "Bonus Request",
         employee: item.employee,
         status: item.status,
         date: item.createdAt,
         amount: "PKR " + (item.amount?.toLocaleString() || "0"),
         reason: item.reason,
         originalData: item
       });
     });

     // Add Leave Encashments
     leaveEncashments.forEach(item => {
       unifiedList.push({
         _id: item._id,
         type: "leave-encashment",
         typeLabel: "Leave Encashment",
         employee: item.employee,
         status: item.status,
         date: item.createdAt,
         amount: (item.encashmentDays || 0) + " day(s)",
         reason: item.reason,
         originalData: item
       });
     });

     // Add Leave Carry Forwards
     leaveCarryForwards.forEach(item => {
       unifiedList.push({
         _id: item._id,
         type: "leave-carry-forward",
         typeLabel: "Leave Carry Forward",
         employee: item.employee,
         status: item.status,
         date: item.createdAt,
         amount: (item.daysToCarryForward || 0) + " day(s)",
         reason: item.reason,
         originalData: item
       });
     });

     // Add Attendance Challenges
    attendances.forEach(item => {
      if (item.challengeStatus) {
        unifiedList.push({
          _id: item._id,
          type: "attendance-query",
          typeLabel: "Attendance Query",
          employee: item.employee,
          status: item.challengeStatus.toLowerCase(),
          date: item.challengeAt || item.date,
          amount: new Date(item.date).toLocaleDateString(),
          reason: item.challengeReason,
          originalData: item
        });
      }
    });

    // Add Promotions (from history)
    for (const item of (promotions || [])) {
      const gross = await decryptValue(item.grossSalary);
      unifiedList.push({
        _id: item._id,
        type: "promotion",
        typeLabel: "Promotion/Revision",
        employee: item.employee,
        status: "approved",
        date: item.revisionDate || item.createdAt,
        amount: "PKR " + gross.toLocaleString(),
        reason: "Salary Revision to " + item.designation,
        originalData: item
      });
    }

    // Sort all by date
    unifiedList.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    // Final Pagination on combined list
    const paginatedList = unifiedList.slice(parsedSkip, parsedSkip + parsedLimit);

    res.json({
      success: true,
      total: totalCount,
      data: paginatedList
    });

  } catch (error) {
    console.error("Error fetching unified to-do list:", error);
    res.status(500).json({ success: false, message: "Internal server error", error: error.message });
  }
};
