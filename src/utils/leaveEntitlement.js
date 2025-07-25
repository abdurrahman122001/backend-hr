const Employee = require('../models/Employees');


async function updateLeaveEntitlementForEmployee(employeeId, deductionCount = 1, type = 'absent') {
  const employee = await Employee.findById(employeeId).lean();
  if (!employee) return { paid: 0, unpaid: 0 };

  const { total = 0, usedPaid = 0, usedUnpaid = 0 } = employee.leaveEntitlement || {};
  let entitlementLeft = total - usedPaid;

  let addPaid = 0;
  let addUnpaid = 0;

  if (type === 'late') {
    // For late, use up all paid leaves, then start counting as unpaid
    if (entitlementLeft >= deductionCount) {
      addPaid = deductionCount;
      // All lates covered by paid leaves
    } else if (entitlementLeft > 0) {
      addPaid = entitlementLeft;
      addUnpaid = deductionCount - entitlementLeft; // Remaining lates now unpaid!
    } else {
      // All paid leaves finished, all lates are unpaid now
      addUnpaid = deductionCount;
    }
  } else {
    // Absent logic (already correct)
    if (entitlementLeft >= deductionCount) {
      addPaid = deductionCount;
    } else if (entitlementLeft > 0) {
      addPaid = entitlementLeft;
      addUnpaid = deductionCount - entitlementLeft;
    } else {
      addUnpaid = deductionCount;
    }
  }

  // Actually increment correct counters in DB
  await Employee.updateOne(
    { _id: employee._id },
    { $inc: { "leaveEntitlement.usedPaid": addPaid, "leaveEntitlement.usedUnpaid": addUnpaid } }
  );

  // Return real deduction info for late as well!
  return { paid: addPaid, unpaid: addUnpaid };
}


module.exports = { updateLeaveEntitlementForEmployee }; 
