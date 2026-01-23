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
      return res.status(400).json({ message: "Please select at least one date" });
    }
    
    // Calculate start and end dates
    const sortedDates = [...dates].sort((a, b) => new Date(a.date) - new Date(b.date));
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
      endDate
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
      const usedAnnual = leaveSummary.annual ? leaveSummary.annual.totalDays : 0;
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
      const superAdmin = await Employee.findOne({ role: "admin" }).sort({ createdAt: 1 });
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
      message: supervisor ? "Leave request submitted for approval" : "Leave request auto-approved",
    });
  } catch (error) {
    console.error("Apply leave error:", error);
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get all leaves (with filters)
// @route   GET /api/leaves
// @access  Private
exports.getLeaves = async (req, res) => {
  try {
    const {
      status,
      leaveType,
      startDate,
      endDate,
      employeeId,
      page = 1,
      limit = 10,
      sortBy = "appliedDate",
      sortOrder = "desc",
    } = req.query;
    
    const query = {};
    
    // Apply filters
    if (status) query.status = status;
    if (leaveType) query.leaveType = leaveType;
    if (employeeId) query.employee = employeeId;
    
    // Date range filter
    if (startDate || endDate) {
      query.appliedDate = {};
      if (startDate) query.appliedDate.$gte = new Date(startDate);
      if (endDate) query.appliedDate.$lte = new Date(endDate);
    }
    
    // Check user role
    const user = req.user;
    const employee = await Employee.findById(user.employeeId || user.id);
    
    if (employee.role !== "admin" && employee.role !== "hr") {
      // Non-admin users can only see their own leaves
      query.employee = employee._id;
    } else if (employee.role === "hr") {
      // HR can see leaves of employees in their department
      query["employee.department"] = employee.department;
    }
    
    // Pagination
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    // Sorting
    const sort = {};
    sort[sortBy] = sortOrder === "asc" ? 1 : -1;
    
    const leaves = await Leave.find(query)
      .populate("employee", "name email department designation")
      .populate("supervisor", "name email")
      .populate("approvedBy", "name email")
      .populate("rejectedBy", "name email")
      .sort(sort)
      .skip(skip)
      .limit(parseInt(limit));
    
    const total = await Leave.countDocuments(query);
    
    res.json({
      success: true,
      data: leaves,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error("Get leaves error:", error);
    res.status(500).json({ message: error.message });
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
      const subordinateIds = subordinates.map(sub => sub._id);
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
    
    if (employee.role !== "admin" && 
        employee.role !== "hr" && 
        leave.employee._id.toString() !== employee._id.toString()) {
      return res.status(403).json({ message: "Not authorized to view this leave" });
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
    const { notes } = req.body;
    const user = req.user;
    
    const leave = await Leave.findById(req.params.id)
      .populate("employee", "name email");
    
    if (!leave) {
      return res.status(404).json({ message: "Leave request not found" });
    }
    
    // Check if user can approve this leave
    const approver = await Employee.findById(user.employeeId || user.id);
    
    // Super admin or HR can approve any leave
    const isSuperAdmin = approver.role === "admin" || approver.role === "hr";
    const isSupervisor = leave.supervisor && 
      leave.supervisor.toString() === approver._id.toString();
    
    if (!isSuperAdmin && !isSupervisor) {
      return res.status(403).json({ message: "Not authorized to approve this leave" });
    }
    
    if (leave.status !== "pending") {
      return res.status(400).json({
        message: `Leave request is already ${leave.status}`,
      });
    }
    
    // Update leave
    leave.status = "approved";
    leave.approvedBy = approver._id;
    leave.approvedDate = new Date();
    
    if (notes) {
      leave.workflowHistory.push({
        action: "approved",
        performedBy: approver._id,
        notes,
      });
    }
    
    await leave.save();
    
    // Update employee's used leave balance if it's annual leave
    if (leave.leaveType === "annual") {
      await Employee.findByIdAndUpdate(
        leave.employee._id,
        { $inc: { "leaveEntitlement.usedPaid": leave.totalDays } }
      );
    }
    
    res.json({
      success: true,
      data: leave,
      message: "Leave request approved successfully",
    });
  } catch (error) {
    console.error("Approve leave error:", error);
    res.status(500).json({ message: error.message });
  }
};

// @desc    Reject leave request
// @route   PUT /api/leaves/:id/reject
// @access  Private (Supervisors/Admins)
exports.rejectLeave = async (req, res) => {
  try {
    const { reason } = req.body;
    
    if (!reason || reason.trim().length < 5) {
      return res.status(400).json({
        message: "Rejection reason is required (minimum 5 characters)",
      });
    }
    
    const user = req.user;
    
    const leave = await Leave.findById(req.params.id);
    
    if (!leave) {
      return res.status(404).json({ message: "Leave request not found" });
    }
    
    // Check if user can reject this leave
    const rejector = await Employee.findById(user.employeeId || user.id);
    
    const isSuperAdmin = rejector.role === "admin" || rejector.role === "hr";
    const isSupervisor = leave.supervisor && 
      leave.supervisor.toString() === rejector._id.toString();
    
    if (!isSuperAdmin && !isSupervisor) {
      return res.status(403).json({ message: "Not authorized to reject this leave" });
    }
    
    if (leave.status !== "pending") {
      return res.status(400).json({
        message: `Leave request is already ${leave.status}`,
      });
    }
    
    // Update leave
    leave.status = "rejected";
    leave.rejectedBy = rejector._id;
    leave.rejectedDate = new Date();
    leave.rejectionReason = reason;
    
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
      return res.status(403).json({ message: "Not authorized to cancel this leave" });
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

// @desc    Get leave statistics
// @route   GET /api/leaves/stats
// @access  Private
exports.getLeaveStats = async (req, res) => {
  try {
    const user = req.user;
    const employee = await Employee.findById(user.employeeId || user.id);
    
    const year = new Date().getFullYear();
    const startOfYear = new Date(year, 0, 1);
    const endOfYear = new Date(year, 11, 31, 23, 59, 59, 999);
    
    let matchQuery = {
      employee: employee._id,
      appliedDate: { $gte: startOfYear, $lte: endOfYear },
    };
    
    // For admins/HR, show overall stats
    if (employee.role === "admin" || employee.role === "hr") {
      delete matchQuery.employee;
      
      if (employee.role === "hr") {
        const departmentEmployees = await Employee.find({
          department: employee.department,
        }).select("_id");
        const employeeIds = departmentEmployees.map(emp => emp._id);
        matchQuery.employee = { $in: employeeIds };
      }
    }
    
    const stats = await Leave.aggregate([
      { $match: matchQuery },
      {
        $group: {
          _id: "$status",
          count: { $sum: 1 },
          totalDays: { $sum: "$totalDays" },
          totalHours: { $sum: "$totalHours" },
        },
      },
    ]);
    
    // Get monthly breakdown
    const monthlyStats = await Leave.aggregate([
      { $match: matchQuery },
      {
        $group: {
          _id: {
            month: { $month: "$appliedDate" },
            status: "$status",
          },
          count: { $sum: 1 },
          totalDays: { $sum: "$totalDays" },
        },
      },
      { $sort: { "_id.month": 1 } },
    ]);
    
    res.json({
      success: true,
      data: {
        summary: stats,
        monthly: monthlyStats,
        employee: employee.leaveEntitlement,
      },
    });
  } catch (error) {
    console.error("Get leave stats error:", error);
    res.status(500).json({ message: error.message });
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
      return res.status(403).json({ message: "Not authorized to update this leave" });
    }
    
    // Recalculate if dates changed
    if (dates && dates.length > 0) {
      const sortedDates = [...dates].sort((a, b) => new Date(a.date) - new Date(b.date));
      leave.startDate = new Date(sortedDates[0].date);
      leave.endDate = new Date(sortedDates[sortedDates.length - 1].date);
      leave.dates = dates;
      leave.totalDays = dates.length;
      leave.totalHours = dates.reduce((sum, day) => sum + day.hours, 0);
    }
    
    if (leaveType) leave.leaveType = leaveType;
    if (customLeaveType || leaveType !== "other") {
      leave.customLeaveType = leaveType === "other" ? customLeaveType : undefined;
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
      return res.status(403).json({ message: "Not authorized to delete leaves" });
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