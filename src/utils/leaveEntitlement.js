const mongoose = require("mongoose");
const LeaveYearBalance = require("../models/LeaveYearBalance");
const LeaveTransaction = require("../models/LeaveTransaction");

function getLeaveYear(attendanceDate) {
  const d = new Date(attendanceDate);
  const year = d.getFullYear();
  const month = d.getMonth(); // 0 = Jan
  const day = d.getDate();

  // If date is on or after 26 Dec → belongs to next leave year
  if (month === 11 && day >= 26) {
    return year + 1;
  }

  return year;
}

async function updateLeaveEntitlementForEmployee(
  ownerId,
  employeeId,
  attendanceDate,
  deductionCount = 1,
  type = "absent",
  forceUnpaid = false,
  performedBy = null
) {
  const leaveYear = getLeaveYear(attendanceDate);

  let balance = await LeaveYearBalance.findOne({
    owner: ownerId,
    employee: employeeId,
    year: leaveYear,
  });

  // Create balance record if it doesn't exist
  if (!balance) {
    balance = await LeaveYearBalance.create({
      owner: ownerId,
      employee: employeeId,
      year: leaveYear,
      total: 0,
      bonus: 0,
      bonusHoursAccumulated: 0,
      usedPaid: 0,
      usedUnpaid: 0,
      remainingPaid: 0,
      lastRecalculatedAt: new Date(),
    });
  }

  const totalEntitled = Number(balance.total || 0) + Number(balance.bonus || 0);
  const usedPaid = Number(balance.usedPaid || 0);
  const entitlementLeft = totalEntitled - usedPaid;

  let addPaid = 0;
  let addUnpaid = 0;

  // ===== Decision Logic =====
  if (type === "late") {
    if (entitlementLeft >= deductionCount) {
      addPaid = deductionCount;
    } else if (entitlementLeft > 0) {
      addPaid = entitlementLeft;
      addUnpaid = deductionCount - entitlementLeft;
    } else {
      addUnpaid = deductionCount;
    }
  } else if (type === "leave") {
    // Explicit leave request → always attempt paid first
    addPaid = deductionCount;
  } else if (type === "absent" && forceUnpaid) {
    addUnpaid = deductionCount;
  } else {
    // Default absent logic
    if (entitlementLeft >= deductionCount) {
      addPaid = deductionCount;
    } else if (entitlementLeft > 0) {
      addPaid = entitlementLeft;
      addUnpaid = deductionCount - entitlementLeft;
    } else {
      addUnpaid = deductionCount;
    }
  }

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    if (addPaid > 0) {
      await LeaveTransaction.create(
        [
          {
            owner: ownerId,
            employee: employeeId,
            leaveYearBalance: balance._id,
            year: leaveYear,
            date: new Date(attendanceDate),
            type: "PAID_LEAVE_USED",
            value: addPaid,
            sourceId: new mongoose.Types.ObjectId(),
            createdBy: performedBy || ownerId,
          },
        ],
        { session }
      );

      balance.usedPaid = Number(balance.usedPaid || 0) + addPaid;
    }

    if (addUnpaid > 0) {
      await LeaveTransaction.create(
        [
          {
            owner: ownerId,
            employee: employeeId,
            leaveYearBalance: balance._id,
            year: leaveYear,
            date: new Date(attendanceDate),
            type: "UNPAID_LEAVE_USED",
            value: addUnpaid,
            sourceId: new mongoose.Types.ObjectId(),
            createdBy: performedBy || ownerId,
          },
        ],
        { session }
      );

      balance.usedUnpaid = Number(balance.usedUnpaid || 0) + addUnpaid;
    }

    await balance.save({ session });

    await session.commitTransaction();
    session.endSession();

    return { paid: addPaid, unpaid: addUnpaid };
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    throw err;
  }
}

async function reverseLeaveEntitlementForEmployee(
  ownerId,
  employeeId,
  attendanceDate,
  reversalCount = 1,
  type = "paid", // "paid" or "unpaid"
  performedBy = null
) {
  const leaveYear = getLeaveYear(attendanceDate);

  let balance = await LeaveYearBalance.findOne({
    owner: ownerId,
    employee: employeeId,
    year: leaveYear,
  });

  if (!balance) return { Success: false, message: "No balance record found" };

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    if (type === "paid") {
      const oldUsed = balance.usedPaid || 0;
      await LeaveTransaction.create(
        [
          {
            owner: ownerId,
            employee: employeeId,
            leaveYearBalance: balance._id,
            year: leaveYear,
            date: new Date(),
            type: "PAID_LEAVE_REVERSED",
            value: reversalCount,
            sourceId: new mongoose.Types.ObjectId(),
            createdBy: performedBy || ownerId,
          },
        ],
        { session }
      );

      balance.usedPaid = Math.max(0, Number((oldUsed - reversalCount).toFixed(2)));
      console.log(`📑 [LEAVE-BAL-DEBUG] Reversed ${reversalCount} PAID days. usedPaid: ${oldUsed} -> ${balance.usedPaid}`);
    } else {
      const oldUsed = balance.usedUnpaid || 0;
      await LeaveTransaction.create(
        [
          {
            owner: ownerId,
            employee: employeeId,
            leaveYearBalance: balance._id,
            year: leaveYear,
            date: new Date(),
            type: "UNPAID_LEAVE_REVERSED",
            value: reversalCount,
            sourceId: new mongoose.Types.ObjectId(),
            createdBy: performedBy || ownerId,
          },
        ],
        { session }
      );

      balance.usedUnpaid = Math.max(0, Number((oldUsed - reversalCount).toFixed(2)));
      console.log(`📑 [LEAVE-BAL-DEBUG] Reversed ${reversalCount} UNPAID days. usedUnpaid: ${oldUsed} -> ${balance.usedUnpaid}`);
    }

    await balance.save({ session });
    await session.commitTransaction();
    session.endSession();

    return { success: true };
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    throw err;
  }
}

module.exports = {
  updateLeaveEntitlementForEmployee,
  reverseLeaveEntitlementForEmployee,
  getLeaveYear, // exported for reuse elsewhere
};
