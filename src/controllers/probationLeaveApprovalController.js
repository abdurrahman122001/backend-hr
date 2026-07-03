const ProbationLeaveApproval = require("../models/ProbationLeaveApproval");
const Employee = require("../models/Employees");
const LeaveYearBalance = require("../models/LeaveYearBalance");
const LeaveTransaction = require("../models/LeaveTransaction");
const { getLeaveYear } = require("../utils/leaveEntitlement");

// ────────────────────────────────────────────
// Helper: calculate prorated leaves
// ────────────────────────────────────────────
function calculateProratedLeaves(probationEnd, leaveYear) {
    const leaveYearEnd = new Date(leaveYear, 11, 25); // 25 Dec
    leaveYearEnd.setHours(0, 0, 0, 0);

    const leaveYearStart = new Date(leaveYear - 1, 11, 26); // 26 Dec prev year
    leaveYearStart.setHours(0, 0, 0, 0);

    const totalDaysInYear =
        (leaveYearEnd - leaveYearStart) / (1000 * 60 * 60 * 24) + 1;
    const remainingDays =
        (leaveYearEnd - probationEnd) / (1000 * 60 * 60 * 24) + 1;

    const dailyRate = 22 / totalDaysInYear;

    function customRound(value) {
        const decimal = value - Math.floor(value);
        if (decimal > 0.5) return Math.ceil(value);
        if (decimal < 0.5) return Math.floor(value);
        return value;
    }

    const rawLeaves = dailyRate * remainingDays;
    return Math.max(0, customRound(rawLeaves));
}

// ────────────────────────────────────────────
// GET  /api/probation-leave-approvals
// Get all pending approvals for the current owner
// ────────────────────────────────────────────
exports.getPendingApprovals = async (req, res) => {
    try {
        const ownerId = req.user._id;
        const { status = "pending" } = req.query;

        const filter = { owner: ownerId };
        if (status !== "all") {
            filter.status = status;
        }

        const approvals = await ProbationLeaveApproval.find(filter)
            .populate("employee", "name email department designation employeeId joiningDate photographUrl")
            .sort({ createdAt: -1 })
            .lean();

        res.json({
            status: "success",
            data: approvals,
            count: approvals.length,
        });
    } catch (err) {
        console.error("[probationLeaveApproval] getPendingApprovals error:", err);
        res.status(500).json({ status: "error", message: err.message });
    }
};

// ────────────────────────────────────────────
// GET  /api/probation-leave-approvals/:id
// Get single approval detail
// ────────────────────────────────────────────
exports.getApprovalById = async (req, res) => {
    try {
        const approval = await ProbationLeaveApproval.findOne({
            _id: req.params.id,
            owner: req.user._id,
        })
            .populate("employee", "name email department designation employeeId joiningDate photographUrl")
            .lean();

        if (!approval) {
            return res.status(404).json({ status: "error", message: "Not found" });
        }

        res.json({ status: "success", data: approval });
    } catch (err) {
        res.status(500).json({ status: "error", message: err.message });
    }
};

// ────────────────────────────────────────────
// PUT  /api/probation-leave-approvals/:id/approve
// Approve the probation leave credit
// ────────────────────────────────────────────
exports.approveLeaveCredit = async (req, res) => {
    try {
        const approval = await ProbationLeaveApproval.findOne({
            _id: req.params.id,
            owner: req.user._id,
        }).populate("employee", "name employeeId");

        if (!approval) {
            return res.status(404).json({ status: "error", message: "Not found" });
        }

        if (approval.status !== "pending") {
            return res.status(400).json({
                status: "error",
                message: `Cannot approve a ${approval.status} request`,
            });
        }

        // Recalculate leaves based on effective probation end date
        const effectiveEnd = new Date(approval.effectiveProbationEndDate);
        effectiveEnd.setHours(0, 0, 0, 0);
        const leaveYear = getLeaveYear(effectiveEnd);
        const proratedLeaves = calculateProratedLeaves(effectiveEnd, leaveYear);

        if (proratedLeaves <= 0) {
            return res.status(400).json({
                status: "error",
                message: "No leaves to credit for this period",
            });
        }

        // ✅ Credit the leave to LeaveYearBalance
        const balance = await LeaveYearBalance.findOneAndUpdate(
            {
                owner: req.user._id,
                employee: approval.employee._id || approval.employee,
                year: leaveYear,
            },
            {
                $inc: { total: proratedLeaves },
                lastRecalculatedAt: new Date(),
            },
            {
                upsert: true,
                new: true,
                setDefaultsOnInsert: true,
            }
        );

        // 🧾 Create transaction record
        await LeaveTransaction.create({
            owner: req.user._id,
            employee: approval.employee._id || approval.employee,
            leaveYearBalance: balance._id,
            year: leaveYear,
            date: effectiveEnd,
            type: "PAID_LEAVE_CREDITED",
            value: proratedLeaves,
            sourceModel: "PROBATION",
            sourceId: approval.employee._id || approval.employee,
            createdBy: req.user._id,
        });

        // Update approval record
        approval.status = "approved";
        approval.approvedBy = req.user._id;
        approval.approvedByName = req.user.employeeName || "Admin";
        approval.approvedAt = new Date();
        approval.finalCreditedLeaves = proratedLeaves;
        approval.leaveCredited = true;
        approval.calculatedLeaves = proratedLeaves;

        approval.workflowHistory.push({
            action: "approved",
            performedBy: req.user._id,
            performedByName: req.user.employeeName || "Admin",
            timestamp: new Date(),
            notes: `Approved and credited ${proratedLeaves} prorated leaves for year ${leaveYear}`,
            data: { proratedLeaves, leaveYear, effectiveEnd },
        });

        await approval.save();

        res.json({
            status: "success",
            message: `Leave credited: ${proratedLeaves} days for ${approval.employee.name || "employee"}`,
            data: approval,
        });
    } catch (err) {
        console.error("[probationLeaveApproval] approveLeaveCredit error:", err);
        res.status(500).json({ status: "error", message: err.message });
    }
};

// ────────────────────────────────────────────
// PUT  /api/probation-leave-approvals/:id/reject
// Reject the probation leave credit
// ────────────────────────────────────────────
exports.rejectLeaveCredit = async (req, res) => {
    try {
        const { reason } = req.body;

        const approval = await ProbationLeaveApproval.findOne({
            _id: req.params.id,
            owner: req.user._id,
        }).populate("employee", "name employeeId");

        if (!approval) {
            return res.status(404).json({ status: "error", message: "Not found" });
        }

        if (approval.status !== "pending") {
            return res.status(400).json({
                status: "error",
                message: `Cannot reject a ${approval.status} request`,
            });
        }

        approval.status = "rejected";
        approval.rejectedBy = req.user._id;
        approval.rejectedByName = req.user.employeeName || "Admin";
        approval.rejectedAt = new Date();
        approval.rejectionReason = reason || "Rejected by admin";

        approval.workflowHistory.push({
            action: "rejected",
            performedBy: req.user._id,
            performedByName: req.user.employeeName || "Admin",
            timestamp: new Date(),
            notes: reason || "Rejected by admin",
        });

        await approval.save();

        res.json({
            status: "success",
            message: "Leave credit request rejected",
            data: approval,
        });
    } catch (err) {
        console.error("[probationLeaveApproval] rejectLeaveCredit error:", err);
        res.status(500).json({ status: "error", message: err.message });
    }
};

// ────────────────────────────────────────────
// PUT  /api/probation-leave-approvals/:id/extend
// Extend the probation and re-queue for approval
// ────────────────────────────────────────────
exports.extendProbation = async (req, res) => {
    try {
        const { days, extensionDays, reason } = req.body;
        const finalDays = days || extensionDays;

        if (!finalDays || finalDays < 1) {
            return res.status(400).json({
                status: "error",
                message: "Extension days must be at least 1",
            });
        }

        const approval = await ProbationLeaveApproval.findOne({
            _id: req.params.id,
            owner: req.user._id,
        }).populate("employee", "name employeeId");

        if (!approval) {
            return res.status(404).json({ status: "error", message: "Not found" });
        }

        if (approval.status !== "pending" && approval.status !== "rejected") {
            return res.status(400).json({
                status: "error",
                message: `Cannot extend a ${approval.status} request`,
            });
        }

        // Calculate new effective end date
        const currentEnd = new Date(approval.effectiveProbationEndDate);
        const newEnd = new Date(currentEnd);
        newEnd.setDate(newEnd.getDate() + Number(finalDays));
        newEnd.setHours(0, 0, 0, 0);

        // Recalculate leaves for the new end date
        const newLeaveYear = getLeaveYear(newEnd);
        const recalculatedLeaves = calculateProratedLeaves(newEnd, newLeaveYear);

        // Add extension record
        approval.extensions.push({
            extensionDays: Number(finalDays),
            extendedBy: req.user._id,
            extendedByName: req.user.employeeName || "Admin",
            extendedAt: new Date(),
            reason: reason || `Extended by ${finalDays} days`,
            newProbationEndDate: newEnd,
            recalculatedLeaves,
        });

        approval.totalExtensionDays += Number(finalDays);
        approval.effectiveProbationEndDate = newEnd;
        approval.calculatedLeaves = recalculatedLeaves;
        approval.leaveYear = newLeaveYear;

        // Check if the new end date is in the future
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const newEndStr = newEnd.toISOString().slice(0, 10);
        const todayStr = today.toISOString().slice(0, 10);

        if (newEndStr > todayStr) {
            // Extension is in the future - set status to "extended"
            // The cron job will re-check when the extended probation ends
            approval.status = "extended";
        } else {
            // Extension end date has already passed - set back to pending
            approval.status = "pending";
        }

        approval.workflowHistory.push({
            action: "extended",
            performedBy: req.user._id,
            performedByName: req.user.name || "Admin",
            timestamp: new Date(),
            notes: `Probation extended by ${extensionDays} days. New end: ${newEnd.toISOString().slice(0, 10)}. Recalculated leaves: ${recalculatedLeaves}`,
            data: {
                extensionDays: Number(extensionDays),
                previousEndDate: currentEnd,
                newEndDate: newEnd,
                recalculatedLeaves,
                newLeaveYear,
            },
        });

        await approval.save();

        res.json({
            status: "success",
            message: `Probation extended by ${extensionDays} days. New end date: ${newEnd.toISOString().slice(0, 10)}`,
            data: approval,
        });
    } catch (err) {
        console.error("[probationLeaveApproval] extendProbation error:", err);
        res.status(500).json({ status: "error", message: err.message });
    }
};

// ────────────────────────────────────────────
// GET  /api/probation-leave-approvals/stats
// Get summary stats for the dashboard
// ────────────────────────────────────────────
exports.getApprovalStats = async (req, res) => {
    try {
        const ownerId = req.user._id;

        const stats = await ProbationLeaveApproval.aggregate([
            { $match: { owner: ownerId } },
            {
                $group: {
                    _id: "$status",
                    count: { $sum: 1 },
                },
            },
        ]);

        const result = {
            pending: 0,
            approved: 0,
            rejected: 0,
            extended: 0,
            total: 0,
        };

        stats.forEach((s) => {
            result[s._id] = s.count;
            result.total += s.count;
        });

        res.json({ status: "success", data: result });
    } catch (err) {
        res.status(500).json({ status: "error", message: err.message });
    }
};
