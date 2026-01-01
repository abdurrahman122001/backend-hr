// backend/src/controllers/leaveYearBalanceController.js
const mongoose = require("mongoose");
const LeaveYearBalance = require("../models/LeaveYearBalance");
const { getLeaveYear } = require("../utils/leaveEntitlement");

function resolveOwnerId(user) {
  return user?.owner || user?.createdBy || user?._id;
}

function oid(id) {
  return new mongoose.Types.ObjectId(id);
}

// Get current year leave balance for an employee
exports.getCurrentYearLeaveBalance = async (req, res) => {
  try {
    const employeeId = req.params.employeeId;

    const ownerId = req.user
      ? resolveOwnerId(req.user)      // admin
      : req.employee?.owner;          // employee

    if (!ownerId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const currentYear = getLeaveYear(new Date());

    const balance = await LeaveYearBalance.findOne({
      owner: ownerId,
      employee: employeeId,
      year: currentYear,
    }).lean();

    if (!balance) {
      return res.json({
        total: 0,
        bonus: 0,
        usedPaid: 0,
        usedUnpaid: 0,
        remainingPaid: 0,
        year: currentYear,
      });
    }

    res.json({
      total: balance.total || 0,
      bonus: balance.bonus || 0,
      usedPaid: balance.usedPaid || 0,
      usedUnpaid: balance.usedUnpaid || 0,
      remainingPaid:
        (balance.total || 0) +
        (balance.bonus || 0) -
        (balance.usedPaid || 0),
      year: balance.year,
    });
  } catch (e) {
    res.status(500).json({ error: "Failed to fetch leave balance" });
  }
};

exports.getMyLeaveBalance = async (req, res) => {
  try {
    const employeeId = req.employee._id;
    const currentDate = new Date();
    const currentLeaveYear = getLeaveYear(currentDate);

    const leaveBalance = await LeaveYearBalance.findOne({
      employee: employeeId,
      year: currentLeaveYear,
    }).lean();

    if (!leaveBalance) {
      const previousLeaveYear = currentLeaveYear - 1;
      const previousBalance = await LeaveYearBalance.findOne({
        employee: employeeId,
        year: previousLeaveYear,
      }).lean();

      if (previousBalance) {
        return res.status(200).json(previousBalance);
      }

      return res.status(200).json({
        year: currentLeaveYear,
        total: 0,
        bonus: 0,
        bonusHoursAccumulated: 0,
        usedPaid: 0,
        usedUnpaid: 0,
        remainingPaid: 0,
        lastRecalculatedAt: null,
        createdAt: null,
        updatedAt: null,
      });
    }

    res.status(200).json(leaveBalance);
  } catch (error) {
    console.error("Error fetching leave balance:", error);
    res.status(500).json({
      message: "Failed to fetch leave balance",
      error: error.message,
    });
  }
};
// Get current year leave balance for multiple employees
exports.getBulkCurrentYearLeaveBalances = async (req, res) => {
  try {
    const ownerId = resolveOwnerId(req.user);
    const { employeeIds } = req.body;

    if (!Array.isArray(employeeIds) || employeeIds.length === 0) {
      return res.status(400).json({ error: "Employee IDs array is required" });
    }

    const currentDate = new Date();
    const currentYear = getLeaveYear(currentDate);

    const balances = await LeaveYearBalance.find({
      owner: ownerId,
      employee: { $in: employeeIds.map(id => oid(id)) },
      year: currentYear,
    }).lean();

    // Create a map for quick lookup
    const balanceMap = new Map();
    balances.forEach(balance => {
      balanceMap.set(balance.employee.toString(), balance);
    });

    // Prepare response
    const response = employeeIds.map(employeeId => {
      const balance = balanceMap.get(employeeId);

      if (!balance) {
        return {
          employeeId,
          total: 0,
          bonus: 0,
          usedPaid: 0,
          usedUnpaid: 0,
          remainingPaid: 0,
          year: currentYear,
        };
      }

      const remainingPaid = (balance.total || 0) + (balance.bonus || 0) - (balance.usedPaid || 0);

      return {
        employeeId,
        total: balance.total || 0,
        bonus: balance.bonus || 0,
        usedPaid: balance.usedPaid || 0,
        usedUnpaid: balance.usedUnpaid || 0,
        remainingPaid: remainingPaid,
        year: balance.year,
      };
    });

    res.json({
      balances: response,
      year: currentYear,
      count: response.length,
    });
  } catch (error) {
    console.error("Error fetching bulk leave balances:", error);
    res.status(500).json({ error: "Failed to fetch leave balances" });
  }
};

exports.updateLeaveBalanceEndpoint = async (req, res) => {
  try {
    const ownerId = resolveOwnerId(req.user);
    const { employeeId, operation, value, year, date } = req.body;

    if (!employeeId || !operation) {
      return res.status(400).json({ error: "Missing required fields: employeeId and operation" });
    }

    const result = await exports.updateLeaveBalance({
      ownerId,
      employeeId,
      operation,
      value,
      year,
      date: date ? new Date(date) : new Date()
    });

    res.json({
      success: true,
      message: `Leave balance ${operation} operation completed successfully`,
      data: result
    });

  } catch (error) {
    console.error("Error updating leave balance:", error);
    res.status(500).json({
      error: "Failed to update leave balance",
      details: error.message
    });
  }
};
exports.upsertLeaveBalance = async (req, res) => {
  try {
    const ownerId = resolveOwnerId(req.user);
    const { employeeId } = req.params;
    const { year, total, bonus, usedPaid, usedUnpaid } = req.body;

    if (!year) {
      return res.status(400).json({ error: "Year is required" });
    }

    const balance = await LeaveYearBalance.findOneAndUpdate(
      {
        owner: ownerId,
        employee: employeeId,
        year,
      },
      {
        total,
        bonus,
        usedPaid,
        usedUnpaid,
        lastRecalculatedAt: new Date(),
      },
      {
        upsert: true,
        new: true,
        setDefaultsOnInsert: true,
      }
    );

    res.json({ success: true, data: balance });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update leave balance" });
  }
};