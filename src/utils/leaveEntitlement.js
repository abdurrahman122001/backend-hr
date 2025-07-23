// src/utils/leaveEntitlement.js or at top of attendanceController.js

const Employee = require('../models/Employees');
const Attendance = require('../models/Attendance');
const PayrollPeriod = require('../models/PayrollPeriod');

async function updateLeaveEntitlementForEmployee(employeeId) {
  const employee = await Employee.findById(employeeId).lean();
  if (!employee) return;

  const { total = 0, usedPaid = 0, usedUnpaid = 0 } = employee.leaveEntitlement || {};
  const entitlementLeft = total - usedPaid;

  let update = {};

  if (entitlementLeft > 0) {
    update['leaveEntitlement.usedPaid'] = usedPaid + 1;
  } else {
    update['leaveEntitlement.usedUnpaid'] = usedUnpaid + 1;
  }

  await Employee.updateOne(
    { _id: employee._id },
    { $set: update }
  );
}

module.exports = { updateLeaveEntitlementForEmployee };