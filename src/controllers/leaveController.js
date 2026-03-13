const Leave = require("../models/ApplyLeave");
const Employee = require("../models/Employees");
const SalarySlip = require("../models/SalarySlip");
const HrPolicy = require("../models/HrPolicy");
const LeaveYearBalance = require("../models/LeaveYearBalance");
const LeaveTransaction = require("../models/LeaveTransaction");
const EmployeeHierarchy = require("../models/EmployeeHierarchy");
const { encrypt, decrypt } = require("../utils/encryption");
const mongoose = require("mongoose");
const {
  extractLeaveRules,
  isEmployeeOnProbation,
} = require("../utils/policyParser");
const { getLeaveYear } = require("../utils/leaveEntitlement");
const salaryController = require("./employeeSalaryController");
const Attendance = require("../models/Attendance");
const EmployeeSession = require("../models/EmployeeSession");
const moment = require("moment-timezone");

/** ---------- utils ---------- **/
function buildPublicUrl(req, filename) {
  const base =
    process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`;
  return `${base}/uploads/${filename}`;
}

// Helper function to process employee data and add full photo URLs
function processEmployeeWithPhoto(employee, req) {
  if (!employee) return employee;

  // Ensure we have a plain object if it's a Mongoose document
  const employeeObj = employee.toObject ? employee.toObject() : employee;
  const processedEmployee = { ...employeeObj };

  // Add full photo URL if photographUrl exists
  if (employeeObj.photographUrl) {
    processedEmployee.fullPhotoUrl = buildPublicUrl(
      req,
      employeeObj.photographUrl,
    );
  } else {
    processedEmployee.fullPhotoUrl = null;
  }

  return processedEmployee;
}

// Helper function to get company holidays
async function getCompanyHolidays(ownerId) {
  // Implement based on your Holiday model
  // For now, return empty array
  return [];
}

// Helper function to analyze leave with HR policy (AI-ONLY ANALYSIS - NO AUTO DECISIONS)
async function analyzeLeaveWithPolicy(employee, leaveData, ownerId) {
  try {
    // Fetch HR policy for the company
    const hrPolicy = await HrPolicy.findOne({
      owner: ownerId || employee.owner,
    });

    if (!hrPolicy) {
      return {
        decision: "pending",
        reason: "No HR policy found. Manual review required.",
        isAutoDecision: false,
        isPaid: true,
        violations: [],
        rulesChecked: {},
        recommendation: "MANUAL_REVIEW",
      };
    }

    // Extract rules from policy
    const rules = extractLeaveRules(hrPolicy.content);

    const analysis = {
      decision: "pending", // Always pending for AI analysis
      isPaid: true,
      reason: "",
      isAutoDecision: false, // Set to false as we're not auto-deciding
      violations: [],
      rulesChecked: {
        paidLeaveAdvanceNoticeDays: rules.paidLeaveAdvanceNoticeDays || null,
        totalPaidLeavesPerYear: rules.totalPaidLeavesPerYear || null,
        hasSandwichPolicy: rules.hasSandwichPolicy || false,
        probationPeriodMonths: rules.probationPeriodMonths || null,
        annualLeaveEntitlement: rules.annualLeaveEntitlement || null,
      },
      recommendation: "APPROVE", // Default recommendation
      severity: "LOW", // Severity level: LOW, MEDIUM, HIGH
      analyzedAt: new Date(),
    };

    // Check if employee is on probation
    if (rules.probationPeriodMonths && employee.joiningDate) {
      if (
        isEmployeeOnProbation(employee.joiningDate, rules.probationPeriodMonths)
      ) {
        analysis.violations.push({
          type: "PROBATION", // This matches your enum
          message: `Employee is on probation (${rules.probationPeriodMonths} months probation period)`,
          impact: "Requires supervisor approval",
          severity: "MEDIUM",
          rule: `Probation period: ${rules.probationPeriodMonths} months`,
        });
        analysis.severity = "MEDIUM";
        analysis.recommendation = "MANUAL_REVIEW";
      }
    }

    // Calculate calendar days notice for ALL PAID LEAVES
    if (rules.paidLeaveAdvanceNoticeDays) {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const leaveStartDate = new Date(leaveData.dates[0].date);
      leaveStartDate.setHours(0, 0, 0, 0);

      // Don't include the leave start date in the notice calculation
      const noticeEndDate = new Date(leaveStartDate);
      noticeEndDate.setDate(noticeEndDate.getDate() - 1);

      const daysNotice = Math.max(0, Math.ceil((noticeEndDate.getTime() - today.getTime()) / (1000 * 3600 * 24)) + 1);

      // Check if this is a paid leave type (annual, personal, etc.)
      const paidLeaveTypes = ["annual", "personal", "sick", "emergency"];
      const isPaidLeaveType = paidLeaveTypes.includes(leaveData.leaveType);

      if (
        isPaidLeaveType &&
        daysNotice < rules.paidLeaveAdvanceNoticeDays
      ) {
        // Mark as unpaid due to insufficient notice but don't auto-decide
        const requiredDays = rules.paidLeaveAdvanceNoticeDays;
        const shortByDays = requiredDays - daysNotice;

        analysis.violations.push({
          type: "ADVANCE_NOTICE", // This matches your enum
          message: `Paid leave requires at least ${requiredDays} days advance notice. Only ${daysNotice} days notice given (short by ${shortByDays} days).`,
          impact:
            leaveData.leaveType === "annual"
              ? "Leave should be unpaid or require special approval"
              : "Consider marking as unpaid",
          severity: leaveData.leaveType === "annual" ? "HIGH" : "MEDIUM",
          rule: `Paid leave advance notice: ${requiredDays} days`,
          data: {
            required: requiredDays,
            given: daysNotice,
            shortBy: shortByDays,
          },
        });

        analysis.isPaid = false; // Suggest unpaid due to insufficient notice

        if (leaveData.leaveType === "annual") {
          analysis.severity = "HIGH";
          analysis.recommendation = "REJECT_OR_UNPAID";
        } else {
          analysis.severity =
            analysis.severity === "LOW" ? "MEDIUM" : analysis.severity;
          analysis.recommendation =
            analysis.recommendation === "APPROVE"
              ? "APPROVE_AS_UNPAID"
              : analysis.recommendation;
        }
      }
    }

    // Check sandwich policy
    if (
      rules.hasSandwichPolicy &&
      leaveData.dates &&
      leaveData.dates.length > 0
    ) {
      const dates = leaveData.dates
        .map((d) => new Date(d.date))
        .sort((a, b) => a - b);

      for (let i = 1; i < dates.length; i++) {
        const prevDate = new Date(dates[i - 1]);
        const currDate = new Date(dates[i]);
        prevDate.setDate(prevDate.getDate() + 1);

        if (prevDate.toDateString() !== currDate.toDateString()) {
          const gapDays = Math.max(0, Math.ceil((new Date(currDate.getTime() - 24 * 60 * 60 * 1000).getTime() - prevDate.getTime()) / (1000 * 3600 * 24)) + 1);
          if (gapDays > 0) {
            analysis.violations.push({
              type: "SANDWICH_POLICY", // This matches your enum
              message:
                "Leave includes dates with gaps in between. According to sandwich policy, these gaps will be counted as leave.",
              impact: "Additional days may be deducted from leave balance",
              severity: "LOW",
              rule: "Sandwich policy is active",
              data: {
                gapDays: gapDays,
              },
            });
            break;
          }
        }
      }
    }

    // Check leave balance only for annual leave
    if (leaveData.leaveType === "annual" && rules.totalPaidLeavesPerYear) {
      const leaveSummary = await Leave.getLeaveSummary(employee._id);
      const usedAnnual = leaveSummary.annual
        ? leaveSummary.annual.totalDays
        : 0;
      const requestedDays = leaveData.dates.length;
      const availableDays = rules.totalPaidLeavesPerYear - usedAnnual;

      if (usedAnnual + requestedDays > rules.totalPaidLeavesPerYear) {
        const exceedBy =
          usedAnnual + requestedDays - rules.totalPaidLeavesPerYear;

        analysis.violations.push({
          type: "LEAVE_BALANCE", // This matches your enum
          message: `Exceeds annual leave entitlement. Only ${availableDays} days available but ${requestedDays} days requested (exceeds by ${exceedBy} days).`,
          impact: "Leave may be partially paid, unpaid, or rejected",
          severity: "HIGH",
          rule: `Total paid leaves per year: ${rules.totalPaidLeavesPerYear} days`,
          data: {
            used: usedAnnual,
            available: availableDays,
            requested: requestedDays,
            exceedBy: exceedBy,
            totalEntitlement: rules.totalPaidLeavesPerYear,
          },
        });

        analysis.severity = "HIGH";
        analysis.recommendation = "REJECT_OR_PARTIAL";

        // If exceeding significantly, suggest rejection
        if (exceedBy > 5) {
          analysis.recommendation = "REJECT";
        }
      } else if (availableDays < requestedDays) {
        // This shouldn't happen but as a safety check
        analysis.violations.push({
          type: "OTHER", // Using OTHER for warnings
          message: `Low leave balance: ${availableDays} days available for ${requestedDays} days requested.`,
          impact: "Consider partial approval or unpaid days",
          severity: "MEDIUM",
          rule: `Total paid leaves per year: ${rules.totalPaidLeavesPerYear} days`,
          data: {
            available: availableDays,
            requested: requestedDays,
          },
        });
        analysis.severity =
          analysis.severity === "LOW" ? "MEDIUM" : analysis.severity;
      }
    }

    // Determine final recommendation based on violations
    if (analysis.violations.length === 0) {
      analysis.recommendation = "APPROVE";
      analysis.reason = "Complies with all HR policy rules";
      analysis.severity = "LOW";
    } else {
      // Count violations by severity
      const highViolations = analysis.violations.filter(
        (v) => v.severity === "HIGH",
      );
      const mediumViolations = analysis.violations.filter(
        (v) => v.severity === "MEDIUM",
      );

      if (highViolations.length > 0) {
        analysis.recommendation = "REJECT_OR_UNPAID";
        analysis.reason = `${highViolations.length} high-severity policy violations detected`;
      } else if (mediumViolations.length > 0) {
        analysis.recommendation = "MANUAL_REVIEW";
        analysis.reason = `${mediumViolations.length} policy violations require manual review`;
      } else {
        analysis.recommendation = "APPROVE_WITH_NOTES";
        analysis.reason = "Minor policy considerations noted";
      }
    }

    // Add summary statistics
    analysis.summary = {
      totalViolations: analysis.violations.length,
      highSeverityCount: analysis.violations.filter(
        (v) => v.severity === "HIGH",
      ).length,
      mediumSeverityCount: analysis.violations.filter(
        (v) => v.severity === "MEDIUM",
      ).length,
      lowSeverityCount: analysis.violations.filter((v) => v.severity === "LOW")
        .length,
      complianceScore:
        analysis.violations.length === 0
          ? 100
          : Math.max(0, 100 - analysis.violations.length * 10),
    };

    return analysis;
  } catch (error) {
    console.error("❌ Policy analysis error:", error);
    return {
      decision: "pending",
      reason: "Error analyzing policy. Manual review required.",
      isAutoDecision: false,
      isPaid: true,
      violations: [
        {
          type: "OTHER", // Using OTHER for system errors
          message: error.message,
          impact: "Manual review required",
          severity: "MEDIUM",
        },
      ],
      rulesChecked: {},
      recommendation: "MANUAL_REVIEW",
      severity: "MEDIUM",
      analyzedAt: new Date(),
    };
  }
}
// @desc    Apply for leave with AI analysis (NO AUTO-DECISION)
// @route   POST /api/leaves
// @access  Private
exports.applyLeave = async (req, res) => {
  try {
    const { dates, leaveType, customLeaveType, reason } = req.body;
    const employeeId = req.user.employeeId || req.user.id;

    // Validate dates
    if (!dates || dates.length === 0) {
      return res
        .status(400)
        .json({ message: "Please select at least one date" });
    }

    // NOTE: Past date validation removed - users can now apply for past dates
    // This allows back-dating leave requests for record-keeping purposes

    // Validate reason length
    if (!reason || reason.trim().length < 10) {
      return res.status(400).json({
        message: "Reason must be at least 10 characters",
      });
    }

    // Calculate start and end dates
    const sortedDates = [...dates].sort(
      (a, b) => new Date(a.date) - new Date(b.date),
    );
    const startDate = new Date(sortedDates[0].date);
    const endDate = new Date(sortedDates[sortedDates.length - 1].date);

    // Calculate totals
    const totalDays = dates.length;
    const totalHours = dates.reduce((sum, day) => sum + day.hours, 0);

    // Get employee details
    const employee = await Employee.findById(employeeId);
    if (!employee) {
      return res.status(404).json({ message: "Employee not found" });
    }

    // Check for overlapping leaves
    const overlappingLeave = await Leave.checkOverlap(
      employeeId,
      startDate,
      endDate,
    );

    if (overlappingLeave) {
      return res.status(400).json({
        message: "You already have a leave request for these dates",
        overlappingLeave,
      });
    }

    // Check leave balance (for annual leaves) - but don't block application
    if (leaveType === "annual") {
      const leaveSummary = await Leave.getLeaveSummary(employeeId);
      const usedAnnual = leaveSummary.annual
        ? leaveSummary.annual.totalDays
        : 0;
      const totalEntitlement = employee.leaveEntitlement.total;

      if (usedAnnual + totalDays > totalEntitlement) {
        // Just add a warning but don't block - let admin decide
        console.warn(
          `⚠️ Leave balance warning: Employee ${employeeId} requesting ${totalDays} days but only ${totalEntitlement - usedAnnual} available`,
        );
      }
    }

    // Analyze leave with HR policy (AI ANALYSIS ONLY - NO AUTO DECISION)
    const policyAnalysis = await analyzeLeaveWithPolicy(
      employee,
      { dates, leaveType, totalDays, startDate, endDate },
      employee.owner,
    );

    // Build approval chain based on hierarchy (using EmployeeHierarchy model)
    let approvalChain = [];

    try {
      let currentJuniorId = employeeId;
      const visited = new Set();

      // Traverse up the hierarchy (limit to 10 levels)
      for (let i = 0; i < 10; i++) {
        if (visited.has(String(currentJuniorId))) break;
        visited.add(String(currentJuniorId));

        // Find the senior for this junior
        const link = await EmployeeHierarchy.findOne({
          owner: employee.owner,
          junior: currentJuniorId
        }).populate("senior");

        if (!link || !link.senior) break;

        approvalChain.push(link.senior._id);

        // Stop if senior is Admin or HR
        if (link.senior.role === "admin" || link.senior.role === "hr") {
          break;
        }

        currentJuniorId = link.senior._id;
      }

      // If no chain found from EmployeeHierarchy, fallback to employee.supervisor
      if (approvalChain.length === 0 && employee.supervisor) {
        approvalChain.push(employee.supervisor);
      }

      // If still no chain and direct mode, use super admin
      if (approvalChain.length === 0) {
        const superAdmin = await Employee.findOne({ role: "admin" }).sort({ createdAt: 1 });
        const adminId = superAdmin ? superAdmin._id : employee.owner;
        approvalChain = [adminId];
      }
    } catch (hierarchyError) {
      console.error("❌ Error building hierarchy chain:", hierarchyError);
      // Fallback
      if (employee.supervisor) approvalChain = [employee.supervisor];
    }

    // Set first supervisor from the chain
    let supervisor = approvalChain[0];

    // ALWAYS set status to "pending" - NO AUTO-APPROVAL/REJECTION
    const status = "pending";

    // Create leave request
    const leave = new Leave({
      employee: employeeId,
      supervisor,
      appliedBy: employeeId,
      dates,
      leaveType,
      customLeaveType: leaveType === "other" ? customLeaveType : undefined,
      reason,
      totalDays,
      totalHours,
      startDate,
      endDate,
      appliedDate: new Date(),
      status: status, // Always pending
      isPaid: policyAnalysis.isPaid, // Initial payment status based on analysis
      policyAnalysis: policyAnalysis,
      approvalChain: approvalChain,
      currentApprovalIndex: 0,
    });

    // IMPORTANT: Use "submitted" instead of "applied" to match your enum
    // Add to workflow history
    leave.workflowHistory.push({
      action: "submitted", // Changed from "applied" to "submitted"
      performedBy: employeeId,
      performedByName: employee.name || "Employee",
      notes: "Leave request submitted",
      timestamp: new Date(),
    });

    // If policy analysis suggests unpaid, add a system note
    if (!policyAnalysis.isPaid && policyAnalysis.violations.length > 0) {
      const noticeViolation = policyAnalysis.violations.find(
        (v) => v.type === "ADVANCE_NOTICE",
      );
      leave.workflowHistory.push({
        action: "system_approved", // Using system_approved for system notes
        performedBy: null,
        performedByName: "System Analysis",
        notes: noticeViolation
          ? `Policy analysis suggests leave should be unpaid due to: ${noticeViolation.message}`
          : "Policy analysis suggests leave should be unpaid due to policy violations",
        timestamp: new Date(),
      });
    }

    await leave.save();

    // Prepare response message based on analysis
    let message = "Leave request submitted for approval";
    let warning = null;

    if (policyAnalysis.violations.length > 0) {
      const highViolations = policyAnalysis.violations.filter(
        (v) => v.severity === "HIGH",
      );
      if (highViolations.length > 0) {
        warning = `⚠️ High-severity policy violations detected. This leave may be rejected or marked unpaid.`;
      } else {
        warning = `ℹ️ Policy considerations noted. Supervisor will review.`;
      }
    }

    res.status(201).json({
      success: true,
      data: {
        ...leave.toObject(),
        policyAnalysis: leave.policyAnalysis,
      },
      message: message,
      warning: warning,
      isAutoDecision: false, // Always false now
      requiresManualApproval: true, // Always true
      analysisSummary: {
        violations: policyAnalysis.violations.length,
        recommendation: policyAnalysis.recommendation,
        severity: policyAnalysis.severity,
      },
    });
  } catch (error) {
    console.error("❌ Apply leave error:", error);

    // More detailed error logging
    if (error.name === "ValidationError") {
      console.error("Validation errors:", error.errors);
      return res.status(400).json({
        message: "Validation failed",
        errors: Object.keys(error.errors).map((key) => ({
          field: key,
          message: error.errors[key].message,
        })),
      });
    }

    res.status(500).json({
      message: error.message,
      error: process.env.NODE_ENV === "development" ? error.stack : undefined,
    });
  }
};

// @desc    Approve leave request (Admin/Supervisor only)
// @route   PUT /api/leaves/:id/approve
// @access  Private (Supervisors/Admins)
exports.approveLeave = async (req, res) => {
  try {
    // Check if user exists
    if (!req.user) {
      console.error("❌ [approveLeave] req.user is null!");
      return res.status(401).json({
        message: "Authentication required - User not found in request",
        error: "Please log in again",
      });
    }

    const {
      notes,
      overridePolicy = false,
      markAsPaid = null, // null = use system suggestion, true/false = override
      partialApproval = null, // { approvedDays: number, unpaidDays: number }
    } = req.body;
    const user = req.user;

    const leave = await Leave.findById(req.params.id)
      .populate(
        "employee",
        "name email role department supervisor photographUrl leaveEntitlement owner",
      )
      .populate("supervisor", "name email");

    if (!leave) {
      return res.status(404).json({ message: "Leave request not found" });
    }

    // Check if leave is in a state that can be approved
    if (leave.status !== "pending") {
      return res.status(400).json({
        message: `Cannot approve a ${leave.status} leave request`,
        currentStatus: leave.status,
      });
    }

    // Authorization check
    let approver;
    let userRole = user.role || "employee";
    let isSuperAdmin =
      user.isAdmin || userRole === "admin" || userRole === "hr";
    let isSupervisor = false;

    if (user.isEmployee) {
      // User is an employee (not admin/HR)
      const employeeId = user.employeeId || user._id;
      approver = await Employee.findById(employeeId);
      if (!approver) {
        return res.status(404).json({
          message: "Employee record not found for approver",
        });
      }

      // Check if this employee is the supervisor for this leave
      isSupervisor =
        leave.supervisor &&
        leave.supervisor._id.toString() === employeeId.toString();
    } else if (user.isAdmin) {
      // User is an admin/HR
      approver = {
        _id: user._id,
        role: user.role,
        name: user.name,
        email: user.email,
      };
      isSuperAdmin = true;
    }

    // Only admins/HR or supervisors can approve
    if (!isSuperAdmin && !isSupervisor) {
      return res.status(403).json({
        message: "Not authorized to approve this leave",
        details: {
          userRole: userRole,
          isAdmin: isSuperAdmin,
          isSupervisor: isSupervisor,
          required: "Must be admin/HR or the assigned supervisor",
        },
      });
    }

    // Determine approver ID
    let approverId;
    if (user.isEmployee) {
      approverId = user.employeeId || approver._id;
    } else {
      approverId = user._id;
    }

    // Handle policy violations warning
    let policyOverrideNotes = "";
    if (leave.policyAnalysis && leave.policyAnalysis.violations.length > 0) {
      const highSeverityViolations = leave.policyAnalysis.violations.filter(
        (v) => v.severity === "HIGH",
      );

      if (highSeverityViolations.length > 0 && !overridePolicy) {
        return res.status(200).json({
          success: false,
          requiresConfirmation: true,
          message: "This leave has high-severity policy violations",
          violations: highSeverityViolations,
          analysis: {
            recommendation: leave.policyAnalysis.recommendation,
            severity: leave.policyAnalysis.severity,
          },
          suggestion:
            "Add 'overridePolicy: true' in request body to approve despite violations",
        });
      }

      if (overridePolicy) {
        policyOverrideNotes = " (Policy override)";
      }
    }

    // Determine payment status
    let finalIsPaid = leave.isPaid;
    let paymentNotes = "";

    if (markAsPaid !== null) {
      // Admin is explicitly setting payment status
      finalIsPaid = markAsPaid;
      paymentNotes = markAsPaid
        ? "Manually marked as paid"
        : "Manually marked as unpaid";
    } else if (
      overridePolicy &&
      leave.policyAnalysis &&
      !leave.policyAnalysis.isPaid
    ) {
      // If overriding policy and system suggested unpaid, make it paid
      finalIsPaid = true;
      paymentNotes = "Marked as paid despite policy violation";
    }

    // Handle partial approval
    let partialApprovalNotes = "";
    let actualApprovedDays = leave.totalDays;

    if (partialApproval && partialApproval.approvedDays > 0) {
      if (partialApproval.approvedDays > leave.totalDays) {
        return res.status(400).json({
          message: `Cannot approve more days (${partialApproval.approvedDays}) than requested (${leave.totalDays})`,
        });
      }

      actualApprovedDays = partialApproval.approvedDays;
      partialApprovalNotes = `Partially approved: ${partialApproval.approvedDays} out of ${leave.totalDays} days`;

      if (partialApproval.unpaidDays > 0) {
        partialApprovalNotes += ` (${partialApproval.unpaidDays} days unpaid)`;
      }
    }

    // Check if there's someone next in the hierarchy chain
    const isLastInChain = !leave.approvalChain || leave.approvalChain.length === 0 ||
      leave.currentApprovalIndex >= leave.approvalChain.length - 1;

    // If user is Admin or HR, we'll treat it as final approval regardless of where they are in the chain
    // UNLESS they are specifically the current supervisor and NOT the last one, but usually admins want final say.
    // For now, let's say Admin/HR approval is ALWAYS final to give them power.
    const isFinalApproval = isSuperAdmin || isLastInChain;

    if (!isFinalApproval) {
      // Move to next level in hierarchy
      leave.currentApprovalIndex += 1;
      const nextSupervisorId = leave.approvalChain[leave.currentApprovalIndex];
      leave.supervisor = nextSupervisorId;
      leave.status = "pending"; // Stay pending

      const nextSupervisor = await Employee.findById(nextSupervisorId);

      // Add to workflow history
      const historyEntry = {
        action: "updated",
        performedBy: approverId,
        performedByName: approver.name || user.name,
        notes: (notes || "Leave approved") + policyOverrideNotes + `. Sent to ${nextSupervisor ? nextSupervisor.name : "next level"} for final approval.`,
        timestamp: new Date(),
      };
      leave.workflowHistory.push(historyEntry);

      await leave.save();

      return res.json({
        success: true,
        data: leave,
        message: `Leave approved by you and moved to ${nextSupervisor ? nextSupervisor.name : "next supervisor"} for final approval.`,
        nextApprover: nextSupervisor ? { id: nextSupervisor._id, name: nextSupervisor.name } : null,
      });
    }

    // FINAL APPROVAL LOGIC
    leave.status = "approved";
    leave.approvedBy = approverId;
    leave.approvedDate = new Date();
    leave.isPaid = finalIsPaid;
    leave.approvalNotes = notes || "Leave approved";

    // Add to workflow history
    const historyEntry = {
      action: "approved",
      performedBy: approverId,
      performedByName: approver.name || user.name,
      notes: (notes || "Leave approved") + policyOverrideNotes,
      timestamp: new Date(),
    };

    if (paymentNotes) {
      historyEntry.paymentNote = paymentNotes;
    }

    if (partialApprovalNotes) {
      historyEntry.partialApproval = partialApprovalNotes;
    }

    if (overridePolicy) {
      historyEntry.policyOverride = true;
      historyEntry.originalRecommendation = leave.policyAnalysis.recommendation;
    }

    leave.workflowHistory.push(historyEntry);

    await leave.save();

    // UPDATE ATTENDANCE RECORDS FOR PAST/PRESENT DATES
    // When leave is approved, mark all leave dates as "Leave" in attendance
    try {
      const Attendance = require("../models/Attendance");
      
      for (const dateObj of leave.dates) {
        const dateStr = dateObj.date; // Format: YYYY-MM-DD
        const leaveDate = new Date(dateStr);
        
        // Check if attendance record exists for this date
        let attendance = await Attendance.findOne({
          employee: leave.employee,
          date: dateStr,
          owner: leave.employee.owner,
        });
        
        if (attendance) {
          // Update existing attendance - preserve original status if needed
          if (!attendance.originalStatus) {
            attendance.originalStatus = attendance.status;
          }
          attendance.status = "Leave";
          attendance.leaveType = finalIsPaid ? "Paid" : "Unpaid";
          attendance.markedByHR = true;
          attendance.notes = attendance.notes 
            ? `${attendance.notes}; Updated to Leave via approved leave request`
            : "Marked as Leave via approved leave request";
          await attendance.save();
        } else {
          // Create new attendance record as Leave
          attendance = new Attendance({
            owner: leave.employee.owner,
            employee: leave.employee,
            date: dateStr,
            status: "Leave",
            leaveType: finalIsPaid ? "Paid" : "Unpaid",
            markedByHR: true,
            notes: "Auto-created from approved leave request",
          });
          await attendance.save();
        }
        
        console.log(`✅ Attendance updated for ${dateStr}: Leave (${finalIsPaid ? "Paid" : "Unpaid"})`);
      }
    } catch (attendanceError) {
      console.error("⚠️ Error updating attendance for leave:", attendanceError);
      // Don't fail the approval if attendance update fails
    }

    // Get updated leave with populated fields
    const updatedLeave = await Leave.findById(leave._id)
      .populate("employee", "name email department photographUrl")
      .populate("approvedBy", "name email")
      .lean();

    // Process employee data
    const processedLeave = {
      ...updatedLeave,
      employee: processEmployeeWithPhoto(updatedLeave.employee, req),
    };

    res.json({
      success: true,
      data: processedLeave,
      message: "Leave request approved successfully",
      approvedBy: {
        id: approverId,
        name: approver.name || user.name,
        role: approver.role || userRole,
        isAdmin: isSuperAdmin,
      },
      policyOverride: overridePolicy,
      paymentStatus: finalIsPaid ? "paid" : "unpaid",
      partialApproval: partialApproval
        ? {
          approvedDays: actualApprovedDays,
          totalDays: leave.totalDays,
        }
        : null,
    });
  } catch (error) {
    console.error("❌ [approveLeave] Error:", error);
    res.status(500).json({
      message: error.message,
      stack: process.env.NODE_ENV === "development" ? error.stack : undefined,
    });
  }
};

// @desc    Reject leave request
// @route   PUT /api/leaves/:id/reject
// @access  Private (Supervisors/Admins)
exports.rejectLeave = async (req, res) => {
  try {
    const { reason, basedOnPolicy = false } = req.body;
    const user = req.user;

    if (!reason || reason.trim().length < 5) {
      return res.status(400).json({
        message: "Rejection reason is required (minimum 5 characters)",
      });
    }

    if (!req.user) {
      return res.status(401).json({
        message: "Authentication required - User not found in request",
      });
    }

    const leave = await Leave.findById(req.params.id)
      .populate("employee", "name email photographUrl")
      .populate("supervisor", "name email");

    if (!leave) {
      return res.status(404).json({ message: "Leave request not found" });
    }

    if (leave.status !== "pending") {
      return res.status(400).json({
        message: `Cannot reject a ${leave.status} leave request`,
      });
    }

    // Authorization check
    let isSuperAdmin =
      user.isAdmin || user.role === "admin" || user.role === "hr";
    let isSupervisor = false;
    let rejectorId;

    if (user.isEmployee) {
      const employeeId = user.employeeId || user._id;
      isSupervisor =
        leave.supervisor &&
        leave.supervisor._id.toString() === employeeId.toString();
      rejectorId = employeeId;
    } else if (user.isAdmin) {
      isSuperAdmin = true;
      rejectorId = user._id;
    }

    if (!isSuperAdmin && !isSupervisor) {
      return res
        .status(403)
        .json({ message: "Not authorized to reject this leave" });
    }

    // Update leave
    leave.status = "rejected";
    leave.rejectedBy = rejectorId;
    leave.rejectedDate = new Date();
    leave.rejectionReason = reason;

    // Add policy-based rejection note if applicable
    let rejectionNotes = `Rejected: ${reason}`;
    if (basedOnPolicy && leave.policyAnalysis) {
      rejectionNotes += " (Based on HR policy violations)";
    }

    // Add to workflow history
    leave.workflowHistory.push({
      action: "rejected",
      performedBy: rejectorId,
      notes: rejectionNotes,
      timestamp: new Date(),
    });

    await leave.save();

    // UPDATE ATTENDANCE RECORDS WHEN LEAVE IS REJECTED
    // Mark leave dates as "Absent" and "Unpaid" unless already Absent and Unpaid
    try {
      const Attendance = require("../models/Attendance");
      
      for (const dateObj of leave.dates) {
        const dateStr = dateObj.date; // Format: YYYY-MM-DD
        
        // Check if attendance record exists for this date
        let attendance = await Attendance.findOne({
          employee: leave.employee._id,
          date: dateStr,
          owner: leave.employee.owner,
        });
        
        if (attendance) {
          // Only update if NOT already Absent and Unpaid
          const isAlreadyAbsentUnpaid = attendance.status === "Absent" && attendance.leaveType === "Unpaid";
          
          if (!isAlreadyAbsentUnpaid) {
            // Update existing attendance to Absent/Unpaid
            if (!attendance.originalStatus) {
              attendance.originalStatus = attendance.status;
            }
            attendance.status = "Absent";
            attendance.leaveType = "Unpaid";
            attendance.markedByHR = true;
            attendance.notes = attendance.notes 
              ? `${attendance.notes}; Marked as Absent due to rejected leave`
              : "Marked as Absent - leave request was rejected";
            await attendance.save();
            console.log(`⚠️ Attendance updated for ${dateStr}: Absent (Unpaid) - leave rejected`);
          } else {
            console.log(`ℹ️ Attendance for ${dateStr} already Absent/Unpaid - no change needed`);
          }
        } else {
          // Create new attendance record as Absent/Unpaid
          attendance = new Attendance({
            owner: leave.employee.owner,
            employee: leave.employee._id,
            date: dateStr,
            status: "Absent",
            leaveType: "Unpaid",
            markedByHR: true,
            notes: "Auto-created from rejected leave request",
          });
          await attendance.save();
          console.log(`⚠️ Attendance created for ${dateStr}: Absent (Unpaid) - leave rejected`);
        }
      }
    } catch (attendanceError) {
      console.error("⚠️ Error updating attendance for rejected leave:", attendanceError);
      // Don't fail the rejection if attendance update fails
    }

    // IMPLEMENT SALARY DEDUCTION FOR REJECTED LEAVE
    try {
      const leaveDate = new Date(leave.startDate);
      const now = new Date();

      const leaveMonthNum = (leaveDate.getMonth() + 1).toString();
      const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
      const leaveMonthName = monthNames[leaveDate.getMonth()];
      const yearStr = leaveDate.getFullYear().toString();

      const salarySlip = await SalarySlip.findOne({
        employee: leave.employee._id,
        $or: [
          { month: leaveMonthNum, year: yearStr },
          { month: leaveMonthName, year: yearStr },
          { month: (now.getMonth() + 1).toString(), year: now.getFullYear().toString() },
          { month: monthNames[now.getMonth()], year: now.getFullYear().toString() }
        ]
      }).sort({ updatedAt: -1 });

      if (salarySlip) {
        // Try to get Gross, fallback to Basic
        let decryptedAmt = "";
        if (salarySlip.grossSalary && salarySlip.grossSalary !== "") {
          decryptedAmt = await decrypt(salarySlip.grossSalary);
        }

        // If gross decryption failed or was empty, try basic
        if ((!decryptedAmt || decryptedAmt === "[Decryption Error]") && salarySlip.basic) {
          decryptedAmt = await decrypt(salarySlip.basic);
        }

        const baseSalary = Number(decryptedAmt) || 0;

        if (baseSalary > 0) {
          const perDaySalary = baseSalary / 22;
          const deductionAmount = Math.round(perDaySalary * leave.totalDays);

          // Read current leave deduction
          let currentDeduction = 0;
          if (salarySlip.leaveDeductions) {
            try {
              const decDed = await decrypt(salarySlip.leaveDeductions);
              currentDeduction = Number(decDed) || 0;
            } catch (e) {
              currentDeduction = 0;
            }
          }

          const totalDeduction = currentDeduction + deductionAmount;
          salarySlip.leaveDeductions = await encrypt(totalDeduction.toString());

          // Use the exported controller function to recalculate tax, total deductions, and net payable
          if (salaryController && salaryController.autoCalculateAndSaveTax) {
            await salaryController.autoCalculateAndSaveTax(salarySlip);
          } else {
            // Fallback if controller method is not available (should not happen now)
            await salarySlip.save();
          }
        } else {
          console.error(`[rejectLeave] Could not determine base salary for slip ${salarySlip._id}. Decrypted: ${decryptedAmt}`);
        }
      } else {
        console.warn(`⚠️ [rejectLeave] No salary slip found for employee ${leave.employee._id} for month ${leaveMonthName}.`);
      }
    } catch (deductionError) {
      console.error("⚠️ [rejectLeave] Salary deduction failed:", deductionError);
    }

    const processedLeave = {
      ...leave.toObject(),
      employee: processEmployeeWithPhoto(leave.employee, req),
    };

    res.json({
      success: true,
      data: processedLeave,
      message: "Leave request rejected",
      basedOnPolicy: basedOnPolicy,
    });
  } catch (error) {
    console.error("Reject leave error:", error);
    res.status(500).json({ message: error.message });
  }
};

// Get leaves function remains the same...
exports.getLeaves = async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({
        error: "Authentication required - User not found in request",
        message: "Please log in again",
      });
    }

    const {
      page = 1,
      limit = 10,
      status,
      employeeId,
      startDate,
      endDate,
      getAll = "false",
    } = req.query;
    const skip = (page - 1) * limit;

    // Build filter
    let filter = {};

    // Get employees for this company
    const tenantId = req.user.owner;
    const ownedEmployees = await Employee.find({ owner: tenantId }).select("_id");
    const ownedEmployeeIds = ownedEmployees.map(e => e._id);

    // RESTRICT TO COMPANY
    filter.employee = { $in: ownedEmployeeIds };

    // ADMIN LOGIC
    const isAdmin =
      req.user.isAdmin || req.user.role === "admin" || req.user.role === "hr";

    if (isAdmin) {
      if (getAll === "true") {
        const allLeaves = await Leave.find(filter)
          .sort({ createdAt: -1 })
          .populate(
            "employee",
            "name email department position employeeId photographUrl status",
          )
          .lean();

        const processedLeaves = allLeaves.map((leave) => ({
          ...leave,
          employee: processEmployeeWithPhoto(leave.employee, req),
        }));

        return res.json({
          success: true,
          data: processedLeaves,
          total: processedLeaves.length,
          isAdmin: true,
        });
      }

      if (employeeId) {
        filter.employee = employeeId;
      }
    } else {
      if (!req.user._id && !req.user.id) {
        return res.status(400).json({
          error: "User ID not found",
          message: "User data is incomplete",
        });
      }

      const userId = req.user._id || req.user.id;
      filter.employee = userId;

      if (employeeId && employeeId !== userId.toString()) {
        return res.status(403).json({
          error: "Forbidden",
          message: "You can only view your own leaves",
        });
      }
    }

    // Add status filter if provided
    if (status) {
      filter.status = status;
    }

    // Add date range filter if provided
    if (startDate || endDate) {
      filter.startDate = {};
      if (startDate) filter.startDate.$gte = new Date(startDate);
      if (endDate) filter.startDate.$lte = new Date(endDate);
    }

    filter.isTrashed = { $ne: true };
    const total = await Leave.countDocuments(filter);

    // Get leaves with pagination and population
    const leaves = await Leave.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .populate(
        "employee",
        "name email department position employeeId photographUrl status"
      )
      .lean();

    // Process employee data
    const processedLeaves = leaves.map((leave) => ({
      ...leave,
      employee: processEmployeeWithPhoto(leave.employee, req),
    }));

    res.json({
      success: true,
      data: processedLeaves,
      pagination: {
        currentPage: parseInt(page),
        totalPages: Math.ceil(total / limit),
        totalItems: total,
        itemsPerPage: parseInt(limit),
      },
      isAdmin: isAdmin,
      filtersApplied: {
        status: status || "all",
        employeeId: employeeId || "all",
        dateRange: startDate || endDate ? { startDate, endDate } : "all",
      },
    });
  } catch (err) {
    console.error("❌ [getLeaves] Error:", err);
    res.status(500).json({
      error: err.message,
      stack: process.env.NODE_ENV === "development" ? err.stack : undefined,
    });
  }
};

// @desc    Get leaves pending approval
// @route   GET /api/leaves/pending
// @access  Private (Supervisors/Admins)
exports.getPendingLeaves = async (req, res) => {
  try {
    const user = req.user;
    

    const query = { status: "pending" };

    // RESTRICT TO COMPANY
    const tenantId = user.owner;
    const ownedEmployees = await Employee.find({ owner: tenantId }).select("_id");
    const ownedEmployeeIds = ownedEmployees.map(e => e._id);
    query.employee = { $in: ownedEmployeeIds };

    const pendingLeaves = await Leave.find(query)
      .populate("employee", "name email department designation photographUrl status")
      .populate("appliedBy", "name email")
      .sort({ appliedDate: -1 })
      .lean();

    const processedPendingLeaves = pendingLeaves.map((leave) => ({
      ...leave,
      employee: processEmployeeWithPhoto(leave.employee, req),
    }));

    res.json({
      success: true,
      data: processedPendingLeaves,
    });
  } catch (error) {
    console.error("Get pending leaves error:", error);
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get single leave by ID
// @route   GET /api/leaves/:id
// @access  Private
exports.getLeaveById = async (req, res) => {
  try {
    const leave = await Leave.findById(req.params.id)
      .populate(
        "employee",
        "name email department designation position phone photographUrl status",
      )
      .populate("supervisor", "name email")
      .populate("approvedBy", "name email")
      .populate("rejectedBy", "name email")
      .populate("cancelledBy", "name email")
      .lean();

    if (!leave) {
      return res.status(404).json({ message: "Leave request not found" });
    }

    // Check permissions
    const user = req.user;
    const employee = await Employee.findById(user.employeeId || user.id);

    if (
      employee.role !== "admin" &&
      employee.role !== "hr" &&
      leave.employee._id.toString() !== employee._id.toString()
    ) {
      return res
        .status(403)
        .json({ message: "Not authorized to view this leave" });
    }

    const processedLeave = {
      ...leave,
      employee: processEmployeeWithPhoto(leave.employee, req),
    };

    res.json({
      success: true,
      data: processedLeave,
    });
  } catch (error) {
    console.error("Get leave by ID error:", error);
    res.status(500).json({ message: error.message });
  }
};

// @desc    Cancel leave request
// @route   PUT /api/leaves/:id/cancel
// @access  Private
exports.cancelLeave = async (req, res) => {
  try {
    const { reason } = req.body;
    const user = req.user;

    const leave = await Leave.findById(req.params.id);

    if (!leave) {
      return res.status(404).json({ message: "Leave request not found" });
    }

    // Check if user can cancel this leave
    const employee = await Employee.findById(user.employeeId || user.id);
    const isLeaveOwner = leave.employee.toString() === employee._id.toString();
    const isSuperAdmin = employee.role === "admin" || employee.role === "hr";

    if (!isLeaveOwner && !isSuperAdmin) {
      return res
        .status(403)
        .json({ message: "Not authorized to cancel this leave" });
    }

    if (leave.status !== "pending") {
      return res.status(400).json({
        message: `Cannot cancel a ${leave.status} leave request`,
      });
    }

    // Update leave
    leave.status = "cancelled";
    leave.cancelledBy = employee._id;
    leave.cancelledDate = new Date();
    leave.cancellationReason = reason || "Cancelled by employee";

    await leave.save();

    res.json({
      success: true,
      data: leave,
      message: "Leave request cancelled",
    });
  } catch (error) {
    console.error("Cancel leave error:", error);
    res.status(500).json({ message: error.message });
  }
};

exports.getLeaveStats = async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({
        error: "Authentication required - User not found in request",
      });
    }

    const isAdmin =
      req.user.isAdmin || req.user.role === "admin" || req.user.role === "hr";
    const userId = req.user._id || req.user.id;

    if (!isAdmin && !userId) {
      return res.status(400).json({
        error: "User ID not found",
        message: "User data is incomplete",
      });
    }

    const tenantId = req.user.owner;
    const ownedEmployees = await Employee.find({ owner: tenantId }).select("_id");
    const ownedEmployeeIds = ownedEmployees.map(e => e._id);

    const employeeFilter = isAdmin
      ? { employee: { $in: ownedEmployeeIds } }
      : { employee: userId };

    // Get leave statistics
    const totalLeaves = await Leave.countDocuments(employeeFilter);
    const pendingLeaves = await Leave.countDocuments({
      ...employeeFilter,
      status: "pending",
    });
    const approvedLeaves = await Leave.countDocuments({
      ...employeeFilter,
      status: "approved",
    });
    const rejectedLeaves = await Leave.countDocuments({
      ...employeeFilter,
      status: "rejected",
    });
    const cancelledLeaves = await Leave.countDocuments({
      ...employeeFilter,
      status: "cancelled",
    });

    // Get leaves with policy violations (for admin)
    let leavesWithViolations = 0;
    let leavesRequiringAttention = 0;

    if (isAdmin) {
      leavesWithViolations = await Leave.countDocuments({
        "policyAnalysis.violations.0": { $exists: true },
        status: "pending",
      });

      leavesRequiringAttention = await Leave.countDocuments({
        "policyAnalysis.severity": { $in: ["HIGH", "MEDIUM"] },
        status: "pending",
      });
    }

    // Get department stats for admin
    let departmentStats = [];
    let recentLeaves = [];

    if (isAdmin) {
      departmentStats = await Leave.aggregate([
        {
          $lookup: {
            from: "employees",
            localField: "employee",
            foreignField: "_id",
            as: "employeeData",
          },
        },
        { $unwind: "$employeeData" },
        {
          $group: {
            _id: "$employeeData.department",
            total: { $sum: 1 },
            pending: {
              $sum: { $cond: [{ $eq: ["$status", "pending"] }, 1, 0] },
            },
            approved: {
              $sum: { $cond: [{ $eq: ["$status", "approved"] }, 1, 0] },
            },
            rejected: {
              $sum: { $cond: [{ $eq: ["$status", "rejected"] }, 1, 0] },
            },
            cancelled: {
              $sum: { $cond: [{ $eq: ["$status", "cancelled"] }, 1, 0] },
            },
          },
        },
        { $sort: { total: -1 } },
      ]);

      recentLeaves = await Leave.find({})
        .sort({ createdAt: -1 })
        .limit(10)
        .populate("employee", "name email department photographUrl status")
        .lean();

      recentLeaves = recentLeaves.map((leave) => ({
        ...leave,
        employee: processEmployeeWithPhoto(leave.employee, req),
      }));
    }

    // Add a summary array for easier frontend mapping
    const summary = [
      { _id: "total", count: totalLeaves },
      { _id: "pending", count: pendingLeaves },
      { _id: "approved", count: approvedLeaves },
      { _id: "rejected", count: rejectedLeaves },
      { _id: "cancelled", count: cancelledLeaves },
    ];

    res.json({
      success: true,
      stats: {
        total: totalLeaves,
        pending: pendingLeaves,
        approved: approvedLeaves,
        rejected: rejectedLeaves,
        cancelled: cancelledLeaves,
        withViolations: leavesWithViolations,
        requireAttention: leavesRequiringAttention,
        summary: summary,
      },
      summary, // Add at top level for convenience
      departmentStats,
      recentLeaves,
      isAdmin,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error("❌ [getLeaveStats] Error:", err);
    res.status(500).json({
      error: err.message,
      stack: process.env.NODE_ENV === "development" ? err.stack : undefined,
    });
  }
};

// @desc    Update leave request (only pending leaves)
// @route   PUT /api/leaves/:id
// @access  Private
exports.updateLeave = async (req, res) => {
  try {
    const { dates, leaveType, customLeaveType, reason } = req.body;
    const user = req.user;

    const leave = await Leave.findById(req.params.id);

    if (!leave) {
      return res.status(404).json({ message: "Leave request not found" });
    }

    // Only pending leaves can be updated
    if (leave.status !== "pending") {
      return res.status(400).json({
        message: `Cannot update a ${leave.status} leave request`,
      });
    }

    // Check if user can update this leave
    const employee = await Employee.findById(user.employeeId || user.id);
    const isLeaveOwner = leave.employee.toString() === employee._id.toString();

    if (!isLeaveOwner && employee.role !== "admin" && employee.role !== "hr") {
      return res
        .status(403)
        .json({ message: "Not authorized to update this leave" });
    }

    // Recalculate if dates changed
    if (dates && dates.length > 0) {
      const sortedDates = [...dates].sort(
        (a, b) => new Date(a.date) - new Date(b.date),
      );
      leave.startDate = new Date(sortedDates[0].date);
      leave.endDate = new Date(sortedDates[sortedDates.length - 1].date);
      leave.dates = dates;
      leave.totalDays = dates.length;
      leave.totalHours = dates.reduce((sum, day) => sum + day.hours, 0);

      // Re-analyze policy if dates changed
      const employee = await Employee.findById(leave.employee);
      const policyAnalysis = await analyzeLeaveWithPolicy(
        employee,
        {
          dates,
          leaveType: leave.leaveType,
          totalDays: dates.length,
          startDate: leave.startDate,
          endDate: leave.endDate,
        },
        employee.owner,
      );

      leave.policyAnalysis = policyAnalysis;
      leave.isPaid = policyAnalysis.isPaid;
    }

    if (leaveType) leave.leaveType = leaveType;
    if (customLeaveType || leaveType !== "other") {
      leave.customLeaveType =
        leaveType === "other" ? customLeaveType : undefined;
    }
    if (reason) leave.reason = reason;

    // Update workflow history
    leave.workflowHistory.push({
      action: "updated",
      performedBy: employee._id,
      notes: "Leave request updated",
      timestamp: new Date(),
    });

    await leave.save();

    res.json({
      success: true,
      data: leave,
      message: "Leave request updated successfully",
    });
  } catch (error) {
    console.error("Update leave error:", error);
    res.status(500).json({ message: error.message });
  }
};

// @desc    Delete leave (soft delete)
// @route   DELETE /api/leaves/:id
// @access  Private (Admin/HR only)
exports.deleteLeave = async (req, res) => {
  try {
    const user = req.user;
    const employee = await Employee.findById(user.employeeId || user.id);

    if (employee.role !== "admin" && employee.role !== "hr") {
      return res
        .status(403)
        .json({ message: "Not authorized to delete leaves" });
    }

    const leave = await Leave.findById(req.params.id);

    if (!leave) {
      return res.status(404).json({ message: "Leave request not found" });
    }

    // Soft delete
    leave.isTrashed = true;
    leave.trashedAt = new Date();
    leave.trashedBy = employee._id;

    await leave.save();

    res.json({
      success: true,
      message: "Leave request moved to trash",
    });
  } catch (error) {
    console.error("Delete leave error:", error);
    res.status(500).json({ message: error.message });
  }
};

// @desc    Check leave against HR policy (AI Analysis)
// @route   POST /api/leaves/check-policy
// @access  Private
exports.checkLeavePolicy = async (req, res) => {
  try {
    const { dates, leaveType } = req.body;
    const employeeId = req.user.employeeId || req.user.id;

    if (!dates || dates.length === 0) {
      return res.status(400).json({
        message: "Please provide dates to check",
      });
    }

    // Get employee details
    const employee = await Employee.findById(employeeId);
    if (!employee) {
      return res.status(404).json({ message: "Employee not found" });
    }

    // Calculate dates
    const sortedDates = [...dates].sort(
      (a, b) => new Date(a.date) - new Date(b.date),
    );
    const startDate = new Date(sortedDates[0].date);
    const endDate = new Date(sortedDates[sortedDates.length - 1].date);

    // Analyze leave with policy (AI-only analysis)
    const policyAnalysis = await analyzeLeaveWithPolicy(
      employee,
      { dates, leaveType, totalDays: dates.length, startDate, endDate },
      employee.owner,
    );

    res.json({
      success: true,
      data: policyAnalysis,
      message: "AI policy analysis completed",
      suggestedAction: "MANUAL_REVIEW_REQUIRED", // Always manual review
      summary: {
        violations: policyAnalysis.violations.length,
        recommendation: policyAnalysis.recommendation,
        severity: policyAnalysis.severity,
        complianceScore: policyAnalysis.summary?.complianceScore || 0,
      },
    });
  } catch (error) {
    console.error("Check leave policy error:", error);
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get HR policy rules for leave
// @route   GET /api/leaves/policy-rules
// @access  Private
exports.getLeavePolicyRules = async (req, res) => {
  try {

    const employeeId = req.user.employeeId || req.user._id;
    let employee = null;

    if (req.user.isEmployee || req.user.employeeId) {
      employee = await Employee.findById(employeeId);
    }

    let ownerId;

    if (employee) {
      ownerId = employee.owner;
    } else {
      // Check if admin/hr
      const role = (req.user.role || "").toLowerCase();
      const isAdmin = req.user.isAdmin === true || role === 'admin' || role === 'hr';

      if (isAdmin) {
        ownerId = req.user._id; // Admin's ID is the owner ID
      } else {
        console.warn("❌ getLeavePolicyRules: User is neither employee nor admin", req.user);
        return res.status(404).json({ message: "Employee not found. Please ensure you are logged in as an Employee or Admin." });
      }
    }

    if (!ownerId) {
      console.warn("❌ getLeavePolicyRules: Could not determine ownerId");
      return res.status(404).json({ message: "Owner not identified for policy lookup." });
    }

    const hrPolicy = await HrPolicy.findOne({ owner: ownerId });

    if (!hrPolicy) {
      return res.status(404).json({
        success: false,
        message: "HR policy not found for this company",
      });
    }

    const rules = extractLeaveRules(hrPolicy.content);

    // Calculate summaries only if employee exists
    let leaveSummaryData = null;
    let employeeStatusData = null;

    if (employee) {
      const leaveSummary = await Leave.getLeaveSummary(employeeId);
      const usedAnnual = leaveSummary.annual ? leaveSummary.annual.totalDays : 0;

      leaveSummaryData = {
        usedAnnual,
        available: rules.totalPaidLeavesPerYear
          ? rules.totalPaidLeavesPerYear - usedAnnual
          : null,
        totalEntitlement: rules.totalPaidLeavesPerYear,
      };

      employeeStatusData = {
        isOnProbation: employee.joiningDate
          ? isEmployeeOnProbation(
            employee.joiningDate,
            rules.probationPeriodMonths,
          )
          : false,
        joiningDate: employee.joiningDate,
        probationMonths: rules.probationPeriodMonths,
      };
    }

    res.json({
      success: true,
      data: {
        policyTitle: hrPolicy.title,
        policyRules: rules,
        leaveSummary: leaveSummaryData,
        employeeStatus: employeeStatusData,
        analysisSettings: {
          autoDecisionEnabled: false,
          aiAnalysisEnabled: true,
          requiresManualApproval: true,
        },
      },
    });
  } catch (error) {
    console.error("Get policy rules error:", error);
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get AI analysis statistics
// @route   GET /api/leaves/analysis-stats
// @access  Private (Admin/HR only)
exports.getAnalysisStats = async (req, res) => {
  try {
    const user = req.user;
    const isAdmin = user.isAdmin || user.role === "admin" || user.role === "hr";

    if (!isAdmin) {
      return res.status(403).json({
        message: "Not authorized to view analysis statistics",
      });
    }

    const { startDate, endDate } = req.query;

    // Get leaves with policy analysis
    const match = {
      "policyAnalysis.0": { $exists: true },
    };

    if (startDate) match.appliedDate = { $gte: new Date(startDate) };
    if (endDate) match.appliedDate = { $lte: new Date(endDate) };

    const analysisStats = await Leave.aggregate([
      { $match: match },
      {
        $group: {
          _id: "$policyAnalysis.severity",
          count: { $sum: 1 },
          avgComplianceScore: {
            $avg: "$policyAnalysis.summary.complianceScore",
          },
          highRiskLeaves: {
            $sum: {
              $cond: [{ $eq: ["$policyAnalysis.severity", "HIGH"] }, 1, 0],
            },
          },
          mediumRiskLeaves: {
            $sum: {
              $cond: [{ $eq: ["$policyAnalysis.severity", "MEDIUM"] }, 1, 0],
            },
          },
          lowRiskLeaves: {
            $sum: {
              $cond: [{ $eq: ["$policyAnalysis.severity", "LOW"] }, 1, 0],
            },
          },
        },
      },
      { $sort: { count: -1 } },
    ]);

    // Get violations statistics
    const violationStats = await Leave.aggregate([
      { $match: { "policyAnalysis.violations.0": { $exists: true } } },
      { $unwind: "$policyAnalysis.violations" },
      {
        $group: {
          _id: "$policyAnalysis.violations.type",
          count: { $sum: 1 },
          highSeverity: {
            $sum: {
              $cond: [
                { $eq: ["$policyAnalysis.violations.severity", "HIGH"] },
                1,
                0,
              ],
            },
          },
          mediumSeverity: {
            $sum: {
              $cond: [
                { $eq: ["$policyAnalysis.violations.severity", "MEDIUM"] },
                1,
                0,
              ],
            },
          },
          lowSeverity: {
            $sum: {
              $cond: [
                { $eq: ["$policyAnalysis.violations.severity", "LOW"] },
                1,
                0,
              ],
            },
          },
        },
      },
      { $sort: { count: -1 } },
    ]);

    // Get recommendation statistics
    const recommendationStats = await Leave.aggregate([
      { $match: { "policyAnalysis.recommendation": { $exists: true } } },
      {
        $group: {
          _id: "$policyAnalysis.recommendation",
          count: { $sum: 1 },
          approvedCount: {
            $sum: { $cond: [{ $eq: ["$status", "approved"] }, 1, 0] },
          },
          rejectedCount: {
            $sum: { $cond: [{ $eq: ["$status", "rejected"] }, 1, 0] },
          },
          pendingCount: {
            $sum: { $cond: [{ $eq: ["$status", "pending"] }, 1, 0] },
          },
        },
      },
      { $sort: { count: -1 } },
    ]);

    res.json({
      success: true,
      data: {
        analysisStats,
        violationStats,
        recommendationStats,
        timeRange: {
          startDate: startDate || "all time",
          endDate: endDate || "all time",
        },
        settings: {
          autoDecisionEnabled: false,
          aiAnalysisEnabled: true,
          manualApprovalRequired: true,
        },
      },
    });
  } catch (error) {
    console.error("Get analysis stats error:", error);
    res.status(500).json({ message: error.message });
  }
};
// In your leaveController.js - Add this function

// @desc    Get employee's own leaves (for employee portal)
// @route   GET /api/leaves/my-leaves
// @access  Private (Employee only)
exports.getMyLeaves = async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({
        error: "Authentication required - User not found in request",
        message: "Please log in again",
      });
    }

    const {
      page = 1,
      limit = 10,
      status,
      startDate,
      endDate,
    } = req.query;

    const skip = (page - 1) * limit;

    // Get employee ID from user
    const employeeId = req.user.employeeId || req.user.id;

    if (!employeeId) {
      return res.status(400).json({
        error: "Employee ID not found",
        message: "User data is incomplete",
      });
    }

    // Build filter - employee can only see their own leaves
    const filter = {
      employee: employeeId,
      isTrashed: { $ne: true }
    };

    // Add status filter if provided
    if (status && status !== "all") {
      filter.status = status;
    }

    // Add date range filter if provided
    if (startDate || endDate) {
      filter.startDate = {};
      if (startDate) filter.startDate.$gte = new Date(startDate);
      if (endDate) filter.startDate.$lte = new Date(endDate);
    }

    const total = await Leave.countDocuments(filter);

    // Get leaves with pagination
    const leaves = await Leave.find(filter)
      .sort({ appliedDate: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .populate(
        "employee",
        "name email department designation position employeeId photographUrl",
      )
      .populate("approvedBy", "name email")
      .populate("rejectedBy", "name email")
      .populate("cancelledBy", "name email")
      .lean();

    // Process employee data to include full photo URLs
    const processedLeaves = leaves.map((leave) => ({
      ...leave,
      employee: processEmployeeWithPhoto(leave.employee, req),
    }));

    // Get leave summary for the employee
    const leaveSummary = await Leave.getLeaveSummary(employeeId);
    const usedAnnual = leaveSummary.annual ? leaveSummary.annual.totalDays : 0;

    // Get HR policy for entitlement info
    const employee = await Employee.findById(employeeId);
    const hrPolicy = await HrPolicy.findOne({ owner: employee.owner });
    let totalEntitlement = employee.leaveEntitlement?.total || 0;

    if (hrPolicy) {
      const rules = extractLeaveRules(hrPolicy.content);
      totalEntitlement = rules.totalPaidLeavesPerYear || totalEntitlement;
    }

    res.json({
      success: true,
      data: processedLeaves,
      summary: {
        totalLeaves: total,
        usedAnnual: usedAnnual,
        availableAnnual: Math.max(0, totalEntitlement - usedAnnual),
        totalEntitlement: totalEntitlement
      },
      pagination: {
        currentPage: parseInt(page),
        totalPages: Math.ceil(total / limit),
        totalItems: total,
        itemsPerPage: parseInt(limit),
      },
      filtersApplied: {
        status: status || "all",
        dateRange: startDate || endDate ? { startDate, endDate } : "all",
      },
    });
  } catch (err) {
    console.error("❌ [getMyLeaves] Error:", err);
    res.status(500).json({
      error: err.message,
      stack: process.env.NODE_ENV === "development" ? err.stack : undefined,
    });
  }
};