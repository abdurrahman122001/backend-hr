const Penalty = require("../models/Penalty");

/**
 * CREATE penalty
 */
exports.createPenalty = async (req, res) => {
  try {
    const { employee, severity, amount, reason, isAnonymous } = req.body;

    if (!employee || !severity || !amount || !reason) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    const penalty = await Penalty.create({
      owner: req.user._id,
      employee,
      severity,
      amount,
      reason,
      isAnonymous: !!isAnonymous,
      reportedBy: isAnonymous ? null : req.user.employee || null,
    });

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
    const penalties = await Penalty.find({ owner: req.user._id })
      .populate("employee", "name department")
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
    const penalties = await Penalty.find({
      owner: req.user._id,
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
    const penalty = await Penalty.findOneAndUpdate(
      { _id: req.params.id, owner: req.user._id },
      req.body,
      { new: true }
    )
      .populate("employee", "name department")
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
    const penalty = await Penalty.findOneAndDelete({
      _id: req.params.id,
      owner: req.user._id,
    });

    if (!penalty) {
      return res.status(404).json({ message: "Penalty not found" });
    }

    res.json({ success: true, message: "Penalty deleted" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

/**
 * GET penalty statistics (dashboard cards)
 */
exports.getPenaltyStats = async (req, res) => {
  try {
    const owner = req.user._id;

    const [
      totalPenalties,
      pending,
      approved,
      employeesAffected,
    ] = await Promise.all([
      Penalty.countDocuments({ owner }),
      Penalty.countDocuments({ owner, status: "pending" }),
      Penalty.countDocuments({ owner, status: "approved" }),
      Penalty.distinct("employee", { owner }).then(arr => arr.length),
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
