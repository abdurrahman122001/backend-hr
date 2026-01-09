const WarningConfig = require("../models/WarningConfig");
const EmployeeWarning = require("../models/EmployeeWarning");
const Penalty = require("../models/Penalty");

/**
 * CREATE warning configuration
 */
exports.createWarningConfig = async (req, res) => {
  try {
    const { name, description, maxWarnings, penaltyAmount, severity, isActive } = req.body;

    if (!name || !maxWarnings || !penaltyAmount) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    const warningConfig = await WarningConfig.create({
      owner: req.user._id,
      name,
      description,
      maxWarnings: Number(maxWarnings),
      penaltyAmount: Number(penaltyAmount),
      severity,
      isActive: isActive !== false,
    });

    res.status(201).json({
      success: true,
      data: warningConfig,
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ message: "Warning configuration with this name already exists" });
    }
    res.status(500).json({ message: error.message });
  }
};

/**
 * GET all warning configurations
 */
exports.getWarningConfigs = async (req, res) => {
  try {
    const configs = await WarningConfig.find({ owner: req.user._id })
      .sort({ createdAt: -1 });

    res.json({ success: true, data: configs });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

/**
 * UPDATE warning configuration
 */
exports.updateWarningConfig = async (req, res) => {
  try {
    const config = await WarningConfig.findOneAndUpdate(
      { _id: req.params.id, owner: req.user._id },
      req.body,
      { new: true }
    );

    if (!config) {
      return res.status(404).json({ message: "Warning configuration not found" });
    }

    res.json({ success: true, data: config });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

/**
 * DELETE warning configuration
 */
exports.deleteWarningConfig = async (req, res) => {
  try {
    const config = await WarningConfig.findOneAndDelete({
      _id: req.params.id,
      owner: req.user._id,
    });

    if (!config) {
      return res.status(404).json({ message: "Warning configuration not found" });
    }

    // Also delete related employee warnings
    await EmployeeWarning.deleteMany({
      owner: req.user._id,
      warning: req.params.id,
    });

    res.json({ success: true, message: "Warning configuration deleted" });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

/**
 * IMPOSE warning on employee
 */
exports.imposeWarning = async (req, res) => {
  try {
    const { employee, warning, reason, notes } = req.body;

    if (!employee || !warning || !reason) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    // Check if warning config exists and is active
    const warningConfig = await WarningConfig.findOne({
      _id: warning,
      owner: req.user._id,
      isActive: true,
    });

    if (!warningConfig) {
      return res.status(404).json({ message: "Warning configuration not found or inactive" });
    }

    // Create warning
    const employeeWarning = await EmployeeWarning.create({
      owner: req.user._id,
      employee,
      warning,
      reportedBy: req.user.employee || null,
      reason,
      notes,
      status: "active",
    });

    // Check if warning threshold reached
    const activeWarningsCount = await EmployeeWarning.countDocuments({
      owner: req.user._id,
      employee,
      warning,
      status: "active",
    });

    let penalty = null;

    // If threshold reached, create penalty
    if (activeWarningsCount >= warningConfig.maxWarnings) {
      penalty = await Penalty.create({
        owner: req.user._id,
        employee,
        reportedBy: req.user.employee || null,
        isAnonymous: false,
        severity: warningConfig.severity,
        amount: warningConfig.penaltyAmount,
        reason: `Automatic penalty for reaching ${warningConfig.maxWarnings} warnings of type: ${warningConfig.name}. Last warning reason: ${reason}`,
        status: "pending",
        warningGenerated: true,
        warningConfig: warning,
        warningCount: activeWarningsCount,
      });

      // Mark warnings as resolved
      await EmployeeWarning.updateMany(
        {
          owner: req.user._id,
          employee,
          warning,
          status: "active",
        },
        { status: "resolved" }
      );
    }

    // Populate data
    const populatedWarning = await employeeWarning.populate([
      { path: "employee", select: "name department" },
      { path: "warning", select: "name maxWarnings penaltyAmount" },
      { path: "reportedBy", select: "name" },
    ]);

    res.status(201).json({
      success: true,
      data: {
        warning: populatedWarning,
        penalty: penalty
          ? await penalty.populate([
              { path: "employee", select: "name department" },
              { path: "reportedBy", select: "name" },
            ])
          : null,
        warningsCount: activeWarningsCount,
        maxWarnings: warningConfig.maxWarnings,
        thresholdReached: activeWarningsCount >= warningConfig.maxWarnings,
      },
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

/**
 * GET warnings for employee
 */
exports.getEmployeeWarnings = async (req, res) => {
  try {
    const warnings = await EmployeeWarning.find({
      owner: req.user._id,
      employee: req.params.employeeId,
    })
      .populate("warning", "name maxWarnings penaltyAmount")
      .populate("reportedBy", "name")
      .sort({ createdAt: -1 });

    res.json({ success: true, data: warnings });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

/**
 * GET warning statistics
 */
exports.getWarningStats = async (req, res) => {
  try {
    const owner = req.user._id;

    const [totalWarnings, activeWarnings, warningConfigs] = await Promise.all([
      EmployeeWarning.countDocuments({ owner }),
      EmployeeWarning.countDocuments({ owner, status: "active" }),
      WarningConfig.find({ owner, isActive: true }),
    ]);

    // Calculate warnings per type
    const warningsByType = await EmployeeWarning.aggregate([
      { $match: { owner: owner, status: "active" } },
      { $group: { _id: "$warning", count: { $sum: 1 } } },
    ]);

    // Find employees who reached threshold
    const thresholdReached = [];
    
    for (const config of warningConfigs) {
      const warnings = await EmployeeWarning.aggregate([
        {
          $match: {
            owner: owner,
            warning: config._id,
            status: "active",
          },
        },
        {
          $group: {
            _id: "$employee",
            count: { $sum: 1 },
          },
        },
        {
          $match: {
            count: { $gte: config.maxWarnings },
          },
        },
      ]);
      
      thresholdReached.push(...warnings.map(w => ({
        warning: config.name,
        employee: w._id,
        count: w.count,
      })));
    }

    res.json({
      success: true,
      data: {
        totalWarnings,
        activeWarnings,
        warningsThresholdReached: thresholdReached.length,
        warningConfigs: warningConfigs.length,
        warningsByType,
        thresholdReached,
      },
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

/**
 * RESOLVE warning (mark as resolved without penalty)
 */
exports.resolveWarning = async (req, res) => {
  try {
    const warning = await EmployeeWarning.findOneAndUpdate(
      { _id: req.params.id, owner: req.user._id },
      { status: "resolved" },
      { new: true }
    )
      .populate("warning", "name maxWarnings penaltyAmount")
      .populate("reportedBy", "name");

    if (!warning) {
      return res.status(404).json({ message: "Warning not found" });
    }

    res.json({ success: true, data: warning });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
/**
 * GET all warnings (for admin dashboard)
 */
exports.getAllWarnings = async (req, res) => {
  try {
    const warnings = await EmployeeWarning.find({ owner: req.user._id })
      .populate("employee", "name department")
      .populate("warning", "name maxWarnings penaltyAmount")
      .populate("reportedBy", "name")
      .sort({ createdAt: -1 });

    res.json({ success: true, data: warnings });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};