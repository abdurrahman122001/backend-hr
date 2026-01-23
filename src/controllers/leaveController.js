const Leave = require("../models/ApplyLeave");
const Employee = require("../models/Employees");
const mongoose = require("mongoose");

// @desc    Apply for leave
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
      status: supervisor ? "pending" : "approved", // Auto-approve if no supervisor
    });

    if (!supervisor) {
      leave.status = "approved";
      leave.approvedBy = employee.owner;
      leave.approvedDate = new Date();
    }

    await leave.save();

    res.status(201).json({
      success: true,
      data: leave,
      message: supervisor
        ? "Leave request submitted for approval"
        : "Leave request auto-approved",
    });
  } catch (error) {
    console.error("Apply leave error:", error);
    res.status(500).json({ message: error.message });
  }
};

// backend/src/controllers/leaveController.js - getLeaves function
exports.getLeaves = async (req, res) => {
  try {
    console.log("🔍 [getLeaves] User from request:", req.user);
    console.log("🔍 [getLeaves] User role:", req.user?.role);
    console.log("🔍 [getLeaves] Is admin:", req.user?.isAdmin);
    console.log("🔍 [getLeaves] Query params:", req.query);

    // Check if user exists
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
      console.log("👑 [getLeaves] Admin/HR access detected");

      // If admin explicitly wants to see all leaves without pagination
      if (getAll === "true") {
        const allLeaves = await Leave.find(filter)
          .sort({ createdAt: -1 })
          .populate("employee", "name email department position employeeId")
          .lean();

        return res.json({
          success: true,
          data: allLeaves,
          total: allLeaves.length,
          isAdmin: true,
        });
      }

      // If employeeId is provided in query, filter by that specific employee
      if (employeeId) {
        console.log(
          `👑 [getLeaves] Admin filtering by employeeId: ${employeeId}`,
        );
        filter.employee = employeeId;
      }
      // Otherwise, admin sees ALL leaves (no employee filter)
    } else {
      // REGULAR EMPLOYEE: Only show their own leaves
      console.log("👤 [getLeaves] Employee access detected");

      // Check if user has ID
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
      filter.date = {};
      if (startDate) filter.date.$gte = new Date(startDate);
      if (endDate) filter.date.$lte = new Date(endDate);
    }

    // Add filter for not deleted leaves
    filter.isDeleted = { $ne: true };

    console.log(
      "🔍 [getLeaves] Final filter:",
      JSON.stringify(filter, null, 2),
    );

    // Get total count for pagination
    const total = await Leave.countDocuments(filter);

    // Get leaves with pagination and population
    const leaves = await Leave.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .populate("employee", "name email department position employeeId")
      .lean();

    res.json({
      success: true,
      data: leaves,
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
      .populate("employee", "name email department designation")
      .populate("appliedBy", "name email")
      .sort({ appliedDate: -1 });

    res.json({
      success: true,
      data: pendingLeaves,
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
      .populate("employee", "name email department designation phone")
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

    res.json({
      success: true,
      data: leave,
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
    console.log("🔍 [approveLeave] Starting approval process");
    console.log("🔍 [approveLeave] User from request:", req.user);
    
    // Check if user exists
    if (!req.user) {
      console.error("❌ [approveLeave] req.user is null!");
      return res.status(401).json({ 
        message: "Authentication required - User not found in request",
        error: "Please log in again"
      });
    }
    
    const { notes } = req.body;
    const user = req.user;

    const leave = await Leave.findById(req.params.id)
      .populate("employee", "name email role department supervisor")
      .populate("supervisor", "name email");

    if (!leave) {
      return res.status(404).json({ message: "Leave request not found" });
    }

    console.log("🔍 [approveLeave] Leave details:", {
      leaveId: leave._id,
      employeeId: leave.employee?._id,
      employeeName: leave.employee?.name,
      supervisorId: leave.supervisor?._id,
      status: leave.status,
      userInfo: {
        userId: user._id,
        employeeId: user.employeeId,
        role: user.role,
        isAdmin: user.isAdmin,
        isEmployee: user.isEmployee
      }
    });

    // IMPORTANT: Your middleware sets req.user._id differently:
    // - For employees: req.user._id = company owner ID (employee.owner)
    // - For employees: req.user.employeeId = employee's personal ID
    // - For admins: req.user._id = admin's ID (company ID)
    
    let approver;
    let userRole = user.role || 'employee';
    let isSuperAdmin = user.isAdmin || userRole === "admin" || userRole === "hr";
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
          message: "Employee record not found for approver"
        });
      }
      
      // Check if this employee is the supervisor for this leave
      isSupervisor = leave.supervisor && 
        leave.supervisor._id.toString() === employeeId.toString();
      
      console.log("🔍 [approveLeave] Employee approver check:", {
        employeeId: employeeId,
        leaveSupervisor: leave.supervisor?._id,
        isSupervisor: isSupervisor,
        approverRole: approver.role
      });
      
    } else if (user.isAdmin) {
      // User is an admin/HR
      // For admins, user._id is the admin's ID (company ID)
      approver = {
        _id: user._id,
        role: user.role,
        name: user.name,
        email: user.email
      };
      
      // Admins/HR can approve any leave
      isSuperAdmin = true;
      isSupervisor = false; // Admins don't need supervisor check
      
      console.log("🔍 [approveLeave] Admin approver:", approver);
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
        isSupervisor: isSupervisor
      });
      
      return res
        .status(403)
        .json({ 
          message: "Not authorized to approve this leave",
          details: {
            userRole: userRole,
            isAdmin: isSuperAdmin,
            isSupervisor: isSupervisor,
            required: "Must be admin/HR or the assigned supervisor"
          }
        });
    }

    // Validate leave status
    if (leave.status !== "pending") {
      return res.status(400).json({
        message: `Leave request is already ${leave.status}`,
        currentStatus: leave.status
      });
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

    // Update leave
    leave.status = "approved";
    leave.approvedBy = approverId;
    leave.approvedDate = new Date();

    if (notes) {
      leave.workflowHistory.push({
        action: "approved",
        performedBy: approverId,
        notes: notes,
        timestamp: new Date()
      });
    }

    await leave.save();

    // Update employee's used leave balance if it's annual leave
    if (leave.leaveType === "annual") {
      await Employee.findByIdAndUpdate(leave.employee._id, {
        $inc: { "leaveEntitlement.usedPaid": leave.totalDays },
      });
    }

    // If needed, update attendance records for the leave period
    if (leave.dates && leave.dates.length > 0) {
      try {
        // Here you can add logic to update attendance records
        // For example, mark these dates as "On Leave" in attendance
        console.log(`📅 [approveLeave] Leave approved for ${leave.totalDays} days`);
      } catch (attendanceError) {
        console.warn("⚠️ [approveLeave] Could not update attendance:", attendanceError.message);
        // Don't fail the approval if attendance update fails
      }
    }

    console.log("✅ [approveLeave] Leave approved successfully:", {
      leaveId: leave._id,
      approvedBy: approverId,
      approverName: approver.name,
      status: leave.status
    });
    
    // Get updated leave with populated fields
    const updatedLeave = await Leave.findById(leave._id)
      .populate("employee", "name email department")
      .populate("approvedBy", "name email")
      .lean();

    res.json({
      success: true,
      data: updatedLeave,
      message: "Leave request approved successfully",
      approvedBy: {
        id: approverId,
        name: approver.name,
        role: approver.role || userRole,
        isAdmin: isSuperAdmin
      }
    });
  } catch (error) {
    console.error("❌ [approveLeave] Error:", error);
    res.status(500).json({ 
      message: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
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
        message: "Authentication required - User not found in request"
      });
    }

    const leave = await Leave.findById(req.params.id)
      .populate("employee", "name email")
      .populate("supervisor", "name email");

    if (!leave) {
      return res.status(404).json({ message: "Leave request not found" });
    }

    // Authorization check (similar to approveLeave)
    let isSuperAdmin = user.isAdmin || user.role === "admin" || user.role === "hr";
    let isSupervisor = false;
    let rejectorId;

    if (user.isEmployee) {
      // For employees, check if they are the supervisor
      const employeeId = user.employeeId || user._id;
      isSupervisor = leave.supervisor && 
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

    if (leave.status !== "pending") {
      return res.status(400).json({
        message: `Leave request is already ${leave.status}`,
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
      timestamp: new Date()
    });

    await leave.save();

    res.json({
      success: true,
      data: leave,
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
    console.log("🔍 [getLeaveStats] User from request:", req.user);

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
      status: "Pending",
    });
    const approvedLeaves = await Leave.countDocuments({
      ...employeeFilter,
      status: "Approved",
    });
    const rejectedLeaves = await Leave.countDocuments({
      ...employeeFilter,
      status: "Rejected",
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
              $sum: { $cond: [{ $eq: ["$status", "Pending"] }, 1, 0] },
            },
            approved: {
              $sum: { $cond: [{ $eq: ["$status", "Approved"] }, 1, 0] },
            },
            rejected: {
              $sum: { $cond: [{ $eq: ["$status", "Rejected"] }, 1, 0] },
            },
          },
        },
        { $sort: { total: -1 } },
      ]);

      // Get recent leaves for admin dashboard
      const recentLeaves = await Leave.find({})
        .sort({ createdAt: -1 })
        .limit(10)
        .populate("employee", "name email department")
        .lean();

      employeeStats = recentLeaves;
    }

    res.json({
      success: true,
      stats: {
        total: totalLeaves,
        pending: pendingLeaves,
        approved: approvedLeaves,
        rejected: rejectedLeaves,
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
