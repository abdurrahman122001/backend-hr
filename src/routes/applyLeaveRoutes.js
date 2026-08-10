const express = require("express");
const router = express.Router();
const leaveController = require("../controllers/leaveController");
const UnifiedAuth = require("../middleware/unifiedAuth");
const ApplyLeave = require("../models/ApplyLeave");
const LeaveMessage = require("../models/LeaveMessage");
const Employee = require("../models/Employees");
const {
  createManyRequestNotifications,
} = require("../services/requestNotificationService");

const requireAuth = require("../middleware/auth"); // Make sure this is correct

router.post("/", UnifiedAuth, leaveController.applyLeave);

// Get all leaves (with filters)
router.get("/", UnifiedAuth, leaveController.getLeaves);

// Get leaves pending approval
router.get("/pending", UnifiedAuth, leaveController.getPendingLeaves);
router.get("/my-leaves", UnifiedAuth, leaveController.getMyLeaves); // Add this line

// Get leave statistics
router.get("/stats", UnifiedAuth, leaveController.getLeaveStats);

// NEW ROUTES FOR POLICY-BASED AUTO-DECISION
// Check leave against HR policy
router.post("/check-policy", UnifiedAuth, leaveController.checkLeavePolicy);

// Get HR policy rules for leave
router.get("/policy-rules", UnifiedAuth, leaveController.getLeavePolicyRules);

// ── Message-counts must be before /:id to avoid param-capture ──
// GET unread message counts for all leaves (used by admin dashboard badge)
router.get("/message-counts", UnifiedAuth, async (req, res) => {
  try {
    const ownerId = req.user.owner;
    const readerId = req.user.employeeId || req.user._id;

    const counts = await LeaveMessage.aggregate([
      { $match: { owner: ownerId, readBy: { $ne: readerId } } },
      { $group: { _id: "$leave", count: { $sum: 1 } } },
    ]);

    const countMap = {};
    counts.forEach((c) => { countMap[String(c._id)] = c.count; });

    return res.json({ counts: countMap });
  } catch (err) {
    console.error("[LeaveMessages] counts error:", err);
    return res.status(500).json({ error: "Failed to fetch message counts" });
  }
});

// Get single leave
router.get("/:id", UnifiedAuth, leaveController.getLeaveById);

// Update leave
router.put("/:id", UnifiedAuth, leaveController.updateLeave);

// Approve leave
router.put("/:id/approve", UnifiedAuth, leaveController.approveLeave);

// Reject leave
router.put("/:id/reject", UnifiedAuth, leaveController.rejectLeave);

// Cancel leave
router.put("/:id/cancel", UnifiedAuth, leaveController.cancelLeave);

// Delete leave (soft delete)
router.delete("/:id", UnifiedAuth, leaveController.deleteLeave);

// ──────────────────────────────────────────────────────────────────
// Leave Message / Chat Routes (message-counts moved above /:id)
// ──────────────────────────────────────────────────────────────────

// GET messages for a specific leave
router.get("/:id/messages", UnifiedAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const ownerId = req.user.owner;
    const readerId = req.user.employeeId || req.user._id;

    const leave = await ApplyLeave.findById(id);
    if (!leave) return res.status(404).json({ error: "Leave not found" });

    const messages = await LeaveMessage.find({ leave: id, owner: ownerId })
      .populate("senderEmployee", "name photographUrl")
      .sort({ createdAt: 1 })
      .lean();

    // Mark all unread messages as read for this user
    await LeaveMessage.updateMany(
      { leave: id, owner: ownerId, readBy: { $ne: readerId } },
      { $addToSet: { readBy: readerId } }
    );

    return res.json({ messages });
  } catch (err) {
    console.error("[LeaveMessages] GET error:", err);
    return res.status(500).json({ error: "Failed to fetch messages" });
  }
});

// POST a new message on a leave
router.post("/:id/messages", UnifiedAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { message } = req.body;

    if (!message?.trim()) {
      return res.status(400).json({ error: "Message cannot be empty" });
    }

    const leave = await ApplyLeave.findById(id);
    if (!leave) return res.status(404).json({ error: "Leave not found" });

    const ownerId = req.user.owner;
    const isEmployee = req.user.isEmployee;
    const senderId = req.user.employeeId || req.user._id;

    // Get sender name
    let senderName = req.user.name || req.user.email || "Unknown";

    // Determine sender role
    let senderRole = "admin";
    if (isEmployee && req.user.employeeId) {
      const empId = String(req.user.employeeId);
      const leaveEmpId = String(leave.employee);
      if (empId === leaveEmpId) {
        senderRole = "employee";
      } else {
        senderRole = "senior";
      }
      // Get name from employee record if not set
      if (!senderName || senderName === "Unknown") {
        const emp = await Employee.findById(req.user.employeeId).select("name").lean();
        if (emp) senderName = emp.name;
      }
    }

    const newMsg = await LeaveMessage.create({
      leave: id,
      owner: ownerId,
      senderEmployee: isEmployee ? req.user.employeeId : undefined,
      senderUser: !isEmployee ? req.user._id : undefined,
      senderName,
      senderRole,
      message: message.trim(),
      readBy: [senderId],
    });

    const populatedMsg = await LeaveMessage.findById(newMsg._id)
      .populate("senderEmployee", "name photographUrl")
      .lean();

    // Emit real-time to all participants
    const io = req.app.get("io");
    if (io) {
      const payload = { leaveId: id, message: populatedMsg };

      // Notify the leave's employee
      io.to(`employee_${leave.employee}`).emit("leave_message", payload);

      // Notify admin/owner dashboard
      io.to(`owner_${ownerId}`).emit("leave_message", payload);

      // Notify each approver in the approval chain
      if (Array.isArray(leave.approvalChain)) {
        leave.approvalChain.forEach((approverId) => {
          io.to(`employee_${approverId}`).emit("leave_message", payload);
        });
      }
    }

    const participantIds = [leave.employee];
    if (Array.isArray(leave.approvalChain)) {
      participantIds.push(...leave.approvalChain);
    }
    if (leave.supervisor) participantIds.push(leave.supervisor);

    await createManyRequestNotifications({
      req,
      recipients: participantIds,
      exclude: senderId,
      actor: isEmployee ? req.user.employeeId : undefined,
      requestId: leave._id,
      requestType: "leave",
      requestModel: "ApplyLeave",
      action: "message",
      title: "New message on leave request",
      message: `${senderName}: ${message.trim()}`,
      forApproval: (recipientId) => String(recipientId) !== String(leave.employee),
      metadata: { messageId: populatedMsg._id },
    });

    return res.status(201).json({ message: populatedMsg });
  } catch (err) {
    console.error("[LeaveMessages] POST error:", err);
    return res.status(500).json({ error: "Failed to send message" });
  }
});

module.exports = router;
