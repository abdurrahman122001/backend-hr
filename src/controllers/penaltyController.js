const Penalty = require("../models/Penalty");

/**
 * CREATE penalty - FIXED VERSION
 */
exports.createPenalty = async (req, res) => {
  try {
    const { employee, severity, amount, reason, isAnonymous } = req.body;

    if (!employee || !severity || !amount || !reason) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    // DETERMINE who is reporting and if it should be auto-approved
    let reportedBy = req.user.employeeId || null;
    let status = "pending";

    const adminRoles = ["admin", "super-admin", "owner"];
    const isPrivileged = adminRoles.includes(req.user.role) || req.user.permissions?.canApprovePenalties;

    if (isPrivileged) {
      status = "approved";
    }

    const penaltyData = {
      owner: req.user.owner || req.user._id,
      employee,
      severity,
      amount,
      reason,
      isAnonymous: !!isAnonymous,
      reportedBy: reportedBy,
      status: status
    };

    const penalty = await Penalty.create(penaltyData);

    const populated = await penalty.populate([
      { path: "employee", select: "name department" },
      { path: "reportedBy", select: "name" },
    ]);

    res.status(201).json({
      success: true,
      data: populated,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
/**
 * GET all penalties (admin dashboard)
 */
exports.getAllPenalties = async (req, res) => {
  try {
    const ownerId = req.user.owner || req.user._id;
    const penalties = await Penalty.find({ owner: ownerId })
      .populate("employee", "name department employeeId")
      .populate("reportedBy", "name")
      .sort({ createdAt: -1 });

    res.json({ success: true, data: penalties });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

/**
 * GET penalties for a specific employee
 */
exports.getEmployeePenalties = async (req, res) => {
  try {
    const ownerId = req.user.owner || req.user._id;
    const penalties = await Penalty.find({
      owner: ownerId,
      employee: req.params.employeeId,
    })
      .populate("reportedBy", "name")
      .sort({ createdAt: -1 });

    res.json({ success: true, data: penalties });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

/**
 * UPDATE penalty (approve / reject)
 */
exports.updatePenalty = async (req, res) => {
  try {
    const ownerId = req.user.owner || req.user._id;
    const penalty = await Penalty.findOneAndUpdate(
      { _id: req.params.id, owner: ownerId },
      req.body,
      { new: true }
    )
      .populate("employee", "name department employeeId")
      .populate("reportedBy", "name");

    if (!penalty) {
      return res.status(404).json({ message: "Penalty not found" });
    }

    res.json({ success: true, data: penalty });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

/**
 * DELETE penalty
 */
exports.deletePenalty = async (req, res) => {
  try {
    const ownerId = req.user.owner || req.user._id;

    const penalty = await Penalty.findOneAndDelete({
      _id: req.params.id,
      owner: ownerId,
    });

    if (!penalty) {
      return res.status(404).json({ message: "Penalty not found" });
    }

    // IF this was an auto-generated penalty from a warning threshold,
    // we should consider marking those warnings back as active.
    if (penalty.warningGenerated && penalty.warningConfig && penalty.employee) {
      await require("../models/EmployeeWarning").updateMany(
        {
          owner: ownerId,
          employee: penalty.employee,
          warning: penalty.warningConfig,
          status: "resolved",
          // Only revert if they were resolved around the same time or before penalty creation
          createdAt: { $lte: penalty.createdAt }
        },
        { status: "active" }
      );
    }

    res.json({ success: true, message: "Penalty deleted successfully" });
  } catch (error) {
    console.error("deletePenalty error:", error);
    res.status(500).json({ message: error.message });
  }
};

/**
 * GET penalty statistics (dashboard cards)
 */
exports.getPenaltyStats = async (req, res) => {
  try {
    const ownerId = req.user.owner || req.user._id;

    const [totalPenalties, pending, approved, employeesAffected] =
      await Promise.all([
        Penalty.countDocuments({ owner: ownerId }),
        Penalty.countDocuments({ owner: ownerId, status: "pending" }),
        Penalty.countDocuments({ owner: ownerId, status: "approved" }),
        Penalty.distinct("employee", { owner: ownerId }).then((arr) => arr.length),
      ]);

    res.json({
      success: true,
      data: {
        totalPenalties,
        pending,
        approved,
        employeesAffected,
      },
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.getMyPenalties = async (req, res) => {
  try {
    // Support both unifiedAuth (req.user with isEmployee flag) and legacy empAuth (req.employee)
    let employeeId, ownerId;

    if (req.employee && req.employee._id) {
      // Legacy empAuth middleware
      employeeId = req.employee._id;
      ownerId = req.employee.owner;
    } else if (req.user && req.user.isEmployee && req.user.employeeId) {
      // unifiedAuth middleware for employee tokens
      employeeId = req.user.employeeId;
      ownerId = req.user.owner || req.user._id;
    } else {
      return res.status(401).json({
        message: "Unauthorized: employee context missing",
      });
    }

    const penalties = await Penalty.find({
      employee: employeeId,
      owner: ownerId,
    })
      .populate("employee", "name department employeeId")
      .populate("reportedBy", "name")
      .sort({ createdAt: -1 });

    res.json({
      success: true,
      data: penalties,
    });
  } catch (error) {
    console.error("getMyPenalties error:", error);
    res.status(500).json({ message: error.message });
  }
};
