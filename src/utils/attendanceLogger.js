// backend/src/utils/attendanceLogger.js
const mongoose = require("mongoose");
const AttendanceChangeLog = require("../models/AttendanceChangeLog");
const Employee = require("../models/Employees");

async function logAttendanceChange({
  ownerId,
  performerId,
  performerType, // 'User' | 'Employee' | 'System'
  performerName,
  employeeId,
  attendanceDate,
  oldStatus,
  newStatus,
  oldLeaveType,
  newLeaveType,
  outcome,
  adjustedDays,
  details
}) {
  try {
    let employeeDisplay = "Unknown";
    const employee = await Employee.findById(employeeId).select('name designation');
    if (employee) {
      employeeDisplay = `${employee.name} (${employee.designation || 'Employee'})`;
    }

    await AttendanceChangeLog.create({
      owner: ownerId,
      performedBy: performerId,
      performerType: performerType,
      performerName: performerName || "System",
      employee: employeeId,
      employeeName: employeeDisplay,
      attendanceDate: attendanceDate,
      oldStatus: oldStatus || "None",
      newStatus: newStatus || "None",
      oldLeaveType: oldLeaveType || "None",
      newLeaveType: newLeaveType || "None",
      outcome: outcome || "None",
      adjustedDays: adjustedDays || 0,
      details: details || ""
    });
  } catch (err) {
    console.error("[ATTENDANCE-LOGGER] Error logging change:", err);
  }
}

module.exports = { logAttendanceChange };
