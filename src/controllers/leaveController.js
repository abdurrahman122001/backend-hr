const Leave = require("../models/ApplyLeave");
const Employee = require("../models/Employees");
const HrPolicy = require("../models/HrPolicy");
const mongoose = require("mongoose");
const {
  extractLeaveRules,
  calculateWorkingDays,
  isEmployeeOnProbation,
} = require("../utils/policyParser");

/** ---------- utils ---------- **/
function buildPublicUrl(req, filename) {
  const base =
    process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`;
  return `${base}/uploads/${filename}`;
}

// Helper function to process employee data and add full photo URLs
function processEmployeeWithPhoto(employee, req) {
  if (!employee) return employee;

  const processedEmployee = { ...employee };

  // Add full photo URL if photographUrl exists
  if (employee.photographUrl) {
    processedEmployee.fullPhotoUrl = buildPublicUrl(
      req,
      employee.photographUrl,
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

// Helper function to analyze leave with HR policy
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
      };
    }

    // Extract rules from policy
    const rules = extractLeaveRules(hrPolicy.content);

    const analysis = {
      decision: "pending",
      isPaid: true,
      reason: "",
      isAutoDecision: false,
      violations: [],
      rulesChecked: rules,
    };

    // Check if employee is on probation
    if (rules.probationPeriodMonths && employee.joiningDate) {
      if (
        isEmployeeOnProbation(employee.joiningDate, rules.probationPeriodMonths)
      ) {
        analysis.violations.push({
          type: "PROBATION",
          message: `Employee is on probation (${rules.probationPeriodMonths} months probation period)`,
          impact: "Leave requires supervisor approval",
        });
      }
    }

    // Calculate working days notice for ALL PAID LEAVES
    // The policy says "Before taking a paid leave, employees must obtain approval at least 7 working days in advance"
    if (rules.paidLeaveAdvanceNoticeDays) {
      const today = new Date();
      today.setHours(0, 0, 0, 0); // Normalize to start of day
      const leaveStartDate = new Date(leaveData.dates[0].date);
      leaveStartDate.setHours(0, 0, 0, 0); // Normalize to start of day

      // Don't include the leave start date in the notice calculation
      const noticeEndDate = new Date(leaveStartDate);
      noticeEndDate.setDate(noticeEndDate.getDate() - 1); // Day before leave starts

      const holidays = await getCompanyHolidays(employee.owner);
      const workingDaysNotice = calculateWorkingDays(
        today,
        noticeEndDate,
        holidays,
      );

      // Check if this is a paid leave type (annual, personal, etc.)
      const paidLeaveTypes = ["annual", "personal", "sick", "emergency"];
      const isPaidLeaveType = paidLeaveTypes.includes(leaveData.leaveType);

      if (
        isPaidLeaveType &&
        workingDaysNotice < rules.paidLeaveAdvanceNoticeDays
      ) {
        analysis.isPaid = false; // Mark as unpaid due to insufficient notice

        analysis.violations.push({
          type: "ADVANCE_NOTICE",
          message: `Paid leave requires at least ${rules.paidLeaveAdvanceNoticeDays} working days advance notice. Only ${workingDaysNotice} working days notice given.`,
          impact: "Leave will be unpaid",
        });

        // For non-annual leaves with insufficient notice, auto-approve but mark as unpaid
        if (leaveData.leaveType !== "annual") {
          analysis.decision = "auto_approved";
          analysis.reason = `Leave approved but marked as unpaid due to insufficient advance notice (${workingDaysNotice} days instead of required ${rules.paidLeaveAdvanceNoticeDays} days)`;
          analysis.isAutoDecision = true;
        }
        // For annual leaves with insufficient notice, auto-reject
        else if (leaveData.leaveType === "annual") {
          analysis.decision = "auto_rejected";
          analysis.reason = `Insufficient advance notice for paid annual leave. Requires ${rules.paidLeaveAdvanceNoticeDays} working days notice.`;
          analysis.isAutoDecision = true;
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
          const gapDays = calculateWorkingDays(
            prevDate,
            new Date(currDate.getTime() - 24 * 60 * 60 * 1000),
            [],
          );
          if (gapDays > 0) {
            analysis.violations.push({
              type: "SANDWICH_POLICY",
              message:
                "Leave includes non-working days between leave dates. According to sandwich policy, these will be counted as leave.",
              impact: "Additional days may be deducted",
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

      if (usedAnnual + leaveData.dates.length > rules.totalPaidLeavesPerYear) {
        analysis.violations.push({
          type: "LEAVE_BALANCE",
          message: `Exceeds annual leave entitlement. Only ${rules.totalPaidLeavesPerYear - usedAnnual} days available out of ${leaveData.dates.length} requested.`,
          impact: "Leave may be partially paid or unpaid",
        });

        if (analysis.decision !== "auto_rejected") {
          analysis.decision = "auto_rejected";
          analysis.reason = `Exceeds annual leave entitlement. Available: ${rules.totalPaidLeavesPerYear - usedAnnual} days`;
          analysis.isAutoDecision = true;
        }
      }
    }

    // If no violations and not auto-decided yet, auto-approve
    if (
      analysis.decision !== "auto_rejected" &&
      analysis.decision !== "auto_approved"
    ) {
      if (analysis.violations.length === 0) {
        analysis.decision = "auto_approved";
        analysis.reason = "Leave complies with all HR policy rules";
        analysis.isAutoDecision = true;
      } else if (analysis.decision === "pending") {
        analysis.reason = "Requires manual review due to policy considerations";
        analysis.isAutoDecision = false;
      }
    }

    analysis.analyzedAt = new Date();
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
          type: "OTHER",
          message: error.message,
          impact: "Manual review required",
        },
      ],
      rulesChecked: {},
      analyzedAt: new Date(),
    };
  }
}

// @desc    Apply for leave with auto-decision based on HR policy
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

    // Check leave balance (for annual leaves)
    if (leaveType === "annual") {
      const leaveSummary = await Leave.getLeaveSummary(employeeId);
      const usedAnnual = leaveSummary.annual
        ? leaveSummary.annual.totalDays
        : 0;
      const totalEntitlement = employee.leaveEntitlement.total;

      if (usedAnnual + totalDays > totalEntitlement) {
        return res.status(400).json({
          message: `Insufficient annual leave balance. Available: ${totalEntitlement - usedAnnual} days`,
          available: totalEntitlement - usedAnnual,
          requested: totalDays,
        });
      }
    }

    // Analyze leave with HR policy
    const policyAnalysis = await analyzeLeaveWithPolicy(
      employee,
      { dates, leaveType, totalDays, startDate, endDate },
      employee.owner,
    );

    // Determine supervisor based on supervision mode
    let supervisor = null;
    if (employee.supervisionMode === "needs_approval") {
      supervisor = employee.supervisor;
    } else {
      // Find super admin or HR for direct supervision mode
      const superAdmin = await Employee.findOne({ role: "admin" }).sort({
        createdAt: 1,
      });
      supervisor = superAdmin || employee.owner;
    }

    // Determine status based on policy analysis
    let status = "pending";
    let isAutoDecision = false;
    let autoDecisionNotes = "";

    if (policyAnalysis.isAutoDecision) {
      if (policyAnalysis.decision === "auto_approved") {
        status = "auto_approved"; // Use "auto_approved" for auto-decisions
        isAutoDecision = true;
        autoDecisionNotes = policyAnalysis.reason;
      } else if (policyAnalysis.decision === "auto_rejected") {
        status = "auto_rejected"; // Use "auto_rejected" for auto-decisions
        isAutoDecision = true;
        autoDecisionNotes = policyAnalysis.reason;
      }
    }

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
      status: status,
      isPaid: policyAnalysis.isPaid,
      policyAnalysis: policyAnalysis,
    });

    // Handle auto-approved leaves
    if (status === "auto_approved" && isAutoDecision) {
      leave.approvedBy = null; // System approval
      leave.approvedDate = new Date();
      leave.approvalNotes = autoDecisionNotes;

      leave.workflowHistory.push({
        action: "auto_approved",
        performedBy: null,
        performedByName: "System (HR Policy)",
        notes: autoDecisionNotes,
        timestamp: new Date(),
      });

      // Update employee's used leave balance if it's annual leave AND paid
      if (leave.leaveType === "annual" && leave.isPaid) {
        await Employee.findByIdAndUpdate(employee._id, {
          $inc: { "leaveEntitlement.usedPaid": leave.totalDays },
        });
      }
    }
    // Handle auto-rejected leaves
    else if (status === "auto_rejected" && isAutoDecision) {
      leave.rejectedBy = null; // System rejection
      leave.rejectedDate = new Date();
      leave.rejectionReason = autoDecisionNotes;

      leave.workflowHistory.push({
        action: "auto_rejected",
        performedBy: null,
        performedByName: "System (HR Policy)",
        notes: autoDecisionNotes,
        timestamp: new Date(),
      });
    }
    // Handle pending leaves (needs supervisor approval)
    else {
      // If no supervisor, auto-approve as regular approval
      if (!supervisor) {
        leave.status = "approved";
        leave.approvedBy = employee.owner;
        leave.approvedDate = new Date();
        leave.approvalNotes = "Auto-approved (no supervisor assigned)";

        leave.workflowHistory.push({
          action: "approved",
          performedBy: employee.owner,
          notes: "Auto-approved (no supervisor assigned)",
          timestamp: new Date(),
        });

        // Update employee's used leave balance if it's annual leave
        if (leave.leaveType === "annual" && leave.isPaid) {
          await Employee.findByIdAndUpdate(employee._id, {
            $inc: { "leaveEntitlement.usedPaid": leave.totalDays },
          });
        }
      }
    }

    await leave.save();

    res.status(201).json({
      success: true,
      data: {
        ...leave.toObject(),
        policyAnalysis: leave.policyAnalysis,
      },
      message: isAutoDecision
        ? `Leave request ${status.replace("auto_", "")} by system: ${policyAnalysis.reason}`
        : supervisor
          ? "Leave request submitted for approval"
          : "Leave request auto-approved (no supervisor)",
      isAutoDecision: isAutoDecision,
      decision: status,
      isPaid: leave.isPaid,
    });
  } catch (error) {
    console.error("❌ Apply leave error:", error);
    res.status(500).json({ message: error.message });
  }
};

// backend/src/controllers/leaveController.js - getLeaves function
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

    // ADMIN LOGIC: If user is admin/HR, they can see ALL leaves
    const isAdmin =
      req.user.isAdmin || req.user.role === "admin" || req.user.role === "hr";

    if (isAdmin) {
      // If admin explicitly wants to see all leaves without pagination
      if (getAll === "true") {
        const allLeaves = await Leave.find(filter)
          .sort({ createdAt: -1 })
          .populate(
            "employee",
            "name email department position employeeId photographUrl",
          )
          .lean();

        // Process employee data to include full photo URLs
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

      // If employeeId is provided in query, filter by that specific employee
      if (employeeId) {
        filter.employee = employeeId;
      }
      // Otherwise, admin sees ALL leaves (no employee filter)
    } else {
      if (!req.user._id && !req.user.id) {
        return res.status(400).json({
          error: "User ID not found",
          message: "User data is incomplete",
        });
      }

      const userId = req.user._id || req.user.id;
      filter.employee = userId;

      // Employees can't filter by other employee IDs
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
        "name email department position employeeId photographUrl",
      )
      .populate("approvedBy", "name email")
      .populate("rejectedBy", "name email")
      .lean();

    // Process employee data to include full photo URLs
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
    const employee = await Employee.findById(user.employeeId || user.id);

    const query = { status: "pending" };

    // Supervisors see leaves of their subordinates
    if (employee.role !== "admin" && employee.role !== "hr") {
      const subordinates = await Employee.find({ supervisor: employee._id });
      const subordinateIds = subordinates.map((sub) => sub._id);
      query.employee = { $in: subordinateIds };
    }

    const pendingLeaves = await Leave.find(query)
      .populate("employee", "name email department designation photographUrl")
      .populate("appliedBy", "name email")
      .sort({ appliedDate: -1 });

    // Process employee data to include full photo URLs
    const processedPendingLeaves = pendingLeaves.map((leave) => ({
      ...leave.toObject(),
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
        "name email department designation phone photographUrl",
      )
      .populate("supervisor", "name email")
      .populate("approvedBy", "name email")
      .populate("rejectedBy", "name email")
      .populate("cancelledBy", "name email");

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

    // Process employee data to include full photo URLs
    const processedLeave = {
      ...leave.toObject(),
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

// @desc    Approve leave request
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

    const { notes, overridePolicy = false, markAsPaid = true } = req.body;
    const user = req.user;

    const leave = await Leave.findById(req.params.id)
      .populate(
        "employee",
        "name email role department supervisor photographUrl",
      )
      .populate("supervisor", "name email");

    if (!leave) {
      return res.status(404).json({ message: "Leave request not found" });
    }

    let approver;
    let userRole = user.role || "employee";
    let isSuperAdmin =
      user.isAdmin || userRole === "admin" || userRole === "hr";
    let isSupervisor = false;

    // Check if user can approve this leave
    if (user.isEmployee) {
      // User is an employee (not admin/HR)
      // For employees, we need to use user.employeeId (their personal ID)
      const employeeId = user.employeeId || user._id;

      // Find the employee record
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
      // For admins, user._id is the admin's ID (company ID)
      approver = {
        _id: user._id,
        role: user.role,
        name: user.name,
        email: user.email,
      };

      // Admins/HR can approve any leave
      isSuperAdmin = true;
      isSupervisor = false; // Admins don't need supervisor check
    }

    // Authorization check
    if (!isSuperAdmin && !isSupervisor) {
      console.warn("⚠️ [approveLeave] Unauthorized approval attempt:", {
        userId: user._id,
        userRole: userRole,
        userEmployeeId: user.employeeId,
        isAdmin: user.isAdmin,
        isEmployee: user.isEmployee,
        leaveId: leave._id,
        leaveSupervisor: leave.supervisor?._id,
        isSuperAdmin: isSuperAdmin,
        isSupervisor: isSupervisor,
      });

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

    // Validate leave status
    if (leave.status !== "pending") {
      return res.status(400).json({
        message: `Leave request is already ${leave.status}`,
        currentStatus: leave.status,
      });
    }

    // Check policy violations and require confirmation if needed
    if (
      leave.policyAnalysis &&
      leave.policyAnalysis.violations &&
      leave.policyAnalysis.violations.length > 0 &&
      !overridePolicy
    ) {
      const seriousViolations = leave.policyAnalysis.violations.filter(
        (v) => v.type === "ADVANCE_NOTICE" || v.type === "LEAVE_BALANCE",
      );

      if (seriousViolations.length > 0) {
        return res.status(200).json({
          success: false,
          requiresConfirmation: true,
          message: "This leave has policy violations that require confirmation",
          violations: seriousViolations,
          suggestion:
            "Add 'overridePolicy: true' in request body to approve despite violations",
        });
      }
    }

    // Determine approver ID to save in the leave record
    let approverId;
    if (user.isEmployee) {
      // For employees, use their employeeId (personal ID)
      approverId = user.employeeId || approver._id;
    } else {
      // For admins, use their user ID
      approverId = user._id;
    }

    // Update leave - change status from auto_approved to approved when supervisor approves
    const newStatus =
      leave.status === "auto_approved" ? "approved" : "approved";
    leave.status = newStatus;
    leave.approvedBy = approverId;
    leave.approvedDate = new Date();

    // Update payment status if supervisor is overriding
    if (markAsPaid && !leave.isPaid) {
      leave.isPaid = true; // Supervisor can override to paid
    }

    // Add to workflow history
    const historyEntry = {
      action: "approved",
      performedBy: approverId,
      notes: notes || "Leave approved",
      timestamp: new Date(),
    };

    if (overridePolicy) {
      historyEntry.notes += " (Policy override)";
      historyEntry.policyOverride = true;
    }

    if (!leave.isPaid) {
      historyEntry.notes += " (Unpaid leave)";
    }

    leave.workflowHistory.push(historyEntry);

    await leave.save();

    // Update employee's used leave balance if it's annual leave and paid
    if (leave.leaveType === "annual" && leave.isPaid) {
      await Employee.findByIdAndUpdate(leave.employee._id, {
        $inc: { "leaveEntitlement.usedPaid": leave.totalDays },
      });
    }

    // Get updated leave with populated fields
    const updatedLeave = await Leave.findById(leave._id)
      .populate("employee", "name email department photographUrl")
      .populate("approvedBy", "name email")
      .lean();

    // Process employee data to include full photo URLs
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
        name: approver.name,
        role: approver.role || userRole,
        isAdmin: isSuperAdmin,
      },
    });
  } catch (error) {
    console.error("❌ [approveLeave] Error:", error);
    res.status(500).json({
      message: error.message,
      stack: process.env.NODE_ENV === "development" ? error.stack : undefined,
    });
  }
};

exports.rejectLeave = async (req, res) => {
  try {
    const { reason } = req.body;
    const user = req.user;

    if (!reason || reason.trim().length < 5) {
      return res.status(400).json({
        message: "Rejection reason is required (minimum 5 characters)",
      });
    }

    // Check if user exists
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

    // Authorization check (similar to approveLeave)
    let isSuperAdmin =
      user.isAdmin || user.role === "admin" || user.role === "hr";
    let isSupervisor = false;
    let rejectorId;

    if (user.isEmployee) {
      // For employees, check if they are the supervisor
      const employeeId = user.employeeId || user._id;
      isSupervisor =
        leave.supervisor &&
        leave.supervisor._id.toString() === employeeId.toString();
      rejectorId = employeeId;
    } else if (user.isAdmin) {
      // Admins can reject any leave
      isSuperAdmin = true;
      rejectorId = user._id;
    }

    if (!isSuperAdmin && !isSupervisor) {
      return res
        .status(403)
        .json({ message: "Not authorized to reject this leave" });
    }

    if (leave.status !== "pending" && leave.status !== "auto_approved") {
      return res.status(400).json({
        message: `Cannot reject a ${leave.status} leave request`,
      });
    }

    // Update leave
    leave.status = "rejected";
    leave.rejectedBy = rejectorId;
    leave.rejectedDate = new Date();
    leave.rejectionReason = reason;

    // Add to workflow history
    leave.workflowHistory.push({
      action: "rejected",
      performedBy: rejectorId,
      notes: `Rejected: ${reason}`,
      timestamp: new Date(),
    });

    await leave.save();

    // Process employee data to include full photo URLs
    const processedLeave = {
      ...leave.toObject(),
      employee: processEmployeeWithPhoto(leave.employee, req),
    };

    res.json({
      success: true,
      data: processedLeave,
      message: "Leave request rejected",
    });
  } catch (error) {
    console.error("Reject leave error:", error);
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

    if (leave.status !== "pending" && leave.status !== "auto_approved") {
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
    // Check if user exists
    if (!req.user) {
      return res.status(401).json({
        error: "Authentication required - User not found in request",
      });
    }

    // Determine if user is admin
    const isAdmin =
      req.user.isAdmin || req.user.role === "admin" || req.user.role === "hr";
    const userId = req.user._id || req.user.id;

    // Check if user has ID (for non-admin users)
    if (!isAdmin && !userId) {
      return res.status(400).json({
        error: "User ID not found",
        message: "User data is incomplete",
      });
    }

    // For admin: get stats for all employees
    // For employee: get stats only for themselves
    const employeeFilter = isAdmin ? {} : { employee: userId };

    // Get leave statistics
    const totalLeaves = await Leave.countDocuments(employeeFilter);
    const pendingLeaves = await Leave.countDocuments({
      ...employeeFilter,
      status: "pending",
    });
    const approvedLeaves = await Leave.countDocuments({
      ...employeeFilter,
      status: { $in: ["approved", "auto_approved"] },
    });
    const rejectedLeaves = await Leave.countDocuments({
      ...employeeFilter,
      status: { $in: ["rejected", "auto_rejected"] },
    });
    const autoApprovedLeaves = await Leave.countDocuments({
      ...employeeFilter,
      status: "auto_approved",
    });
    const autoRejectedLeaves = await Leave.countDocuments({
      ...employeeFilter,
      status: "auto_rejected",
    });

    // If admin, also get breakdown by department or employee
    let departmentStats = [];
    let employeeStats = [];

    if (isAdmin) {
      // Get department-wise stats
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
              $sum: {
                $cond: [
                  { $in: ["$status", ["approved", "auto_approved"]] },
                  1,
                  0,
                ],
              },
            },
            rejected: {
              $sum: {
                $cond: [
                  { $in: ["$status", ["rejected", "auto_rejected"]] },
                  1,
                  0,
                ],
              },
            },
            auto_approved: {
              $sum: { $cond: [{ $eq: ["$status", "auto_approved"] }, 1, 0] },
            },
            auto_rejected: {
              $sum: { $cond: [{ $eq: ["$status", "auto_rejected"] }, 1, 0] },
            },
          },
        },
        { $sort: { total: -1 } },
      ]);

      // Get recent leaves for admin dashboard
      const recentLeaves = await Leave.find({})
        .sort({ createdAt: -1 })
        .limit(10)
        .populate("employee", "name email department photographUrl")
        .lean();

      // Process employee data to include full photo URLs
      employeeStats = recentLeaves.map((leave) => ({
        ...leave,
        employee: processEmployeeWithPhoto(leave.employee, req),
      }));
    }

    res.json({
      success: true,
      stats: {
        total: totalLeaves,
        pending: pendingLeaves,
        approved: approvedLeaves,
        rejected: rejectedLeaves,
        auto_approved: autoApprovedLeaves,
        auto_rejected: autoRejectedLeaves,
      },
      departmentStats: departmentStats,
      recentLeaves: employeeStats,
      isAdmin: isAdmin,
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

// NEW: Check leave against HR policy before applying
// @desc    Check leave against HR policy
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

    // Analyze leave with policy
    const policyAnalysis = await analyzeLeaveWithPolicy(
      employee,
      { dates, leaveType, totalDays: dates.length, startDate, endDate },
      employee.owner,
    );

    res.json({
      success: true,
      data: policyAnalysis,
      message: "Policy analysis completed",
      suggestedAction: policyAnalysis.isAutoDecision
        ? `Leave will be ${policyAnalysis.decision.replace("auto_", "")} automatically`
        : "Leave requires manual approval",
    });
  } catch (error) {
    console.error("Check leave policy error:", error);
    res.status(500).json({ message: error.message });
  }
};

// NEW: Get HR policy rules for leave
// @desc    Get HR policy rules for leave
// @route   GET /api/leaves/policy-rules
// @access  Private
exports.getLeavePolicyRules = async (req, res) => {
  try {
    const employeeId = req.user.employeeId || req.user.id;

    const employee = await Employee.findById(employeeId);
    if (!employee) {
      return res.status(404).json({ message: "Employee not found" });
    }

    const hrPolicy = await HrPolicy.findOne({ owner: employee.owner });

    if (!hrPolicy) {
      return res.status(404).json({
        success: false,
        message: "HR policy not found for this company",
      });
    }

    const rules = extractLeaveRules(hrPolicy.content);

    // Get employee's leave summary
    const leaveSummary = await Leave.getLeaveSummary(employeeId);
    const usedAnnual = leaveSummary.annual ? leaveSummary.annual.totalDays : 0;

    res.json({
      success: true,
      data: {
        policyTitle: hrPolicy.title,
        policyRules: rules,
        leaveSummary: {
          usedAnnual,
          available: rules.totalPaidLeavesPerYear
            ? rules.totalPaidLeavesPerYear - usedAnnual
            : null,
          totalEntitlement: rules.totalPaidLeavesPerYear,
        },
        employeeStatus: {
          isOnProbation: employee.joiningDate
            ? isEmployeeOnProbation(
                employee.joiningDate,
                rules.probationPeriodMonths,
              )
            : false,
          joiningDate: employee.joiningDate,
          probationMonths: rules.probationPeriodMonths,
        },
      },
    });
  } catch (error) {
    console.error("Get policy rules error:", error);
    res.status(500).json({ message: error.message });
  }
};

// NEW: Get auto-decision statistics
// @desc    Get auto-decision statistics
// @route   GET /api/leaves/auto-decision-stats
// @access  Private (Admin/HR only)
exports.getAutoDecisionStats = async (req, res) => {
  try {
    const user = req.user;
    const isAdmin = user.isAdmin || user.role === "admin" || user.role === "hr";

    if (!isAdmin) {
      return res.status(403).json({
        message: "Not authorized to view auto-decision statistics",
      });
    }

    const { startDate, endDate } = req.query;

    // Get total leaves with auto-decisions
    const match = {
      "policyAnalysis.isAutoDecision": true,
    };

    if (startDate) match.appliedDate = { $gte: new Date(startDate) };
    if (endDate) match.appliedDate = { $lte: new Date(endDate) };

    const autoDecisionStats = await Leave.aggregate([
      { $match: match },
      {
        $group: {
          _id: "$policyAnalysis.decision",
          count: { $sum: 1 },
          totalDays: { $sum: "$totalDays" },
          paidCount: {
            $sum: { $cond: [{ $eq: ["$isPaid", true] }, 1, 0] },
          },
          unpaidCount: {
            $sum: { $cond: [{ $eq: ["$isPaid", false] }, 1, 0] },
          },
          avgAdvanceNotice: {
            $avg: {
              $divide: [
                { $subtract: ["$startDate", "$appliedDate"] },
                1000 * 60 * 60 * 24,
              ],
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
          leavesCount: { $addToSet: "$_id" },
        },
      },
      {
        $project: {
          violationType: "$_id",
          count: 1,
          leavesAffected: { $size: "$leavesCount" },
        },
      },
      { $sort: { count: -1 } },
    ]);

    res.json({
      success: true,
      data: {
        autoDecisionStats,
        violationStats,
        timeRange: {
          startDate: startDate || "all time",
          endDate: endDate || "all time",
        },
      },
    });
  } catch (error) {
    console.error("Get auto-decision stats error:", error);
    res.status(500).json({ message: error.message });
  }
};