const mongoose = require("mongoose");

mongoose.connect(
  "mongodb://hrdbAdmin:StrongPassword2001@168.231.101.206:27017/hrdb?authSource=hrdb"
);

const LeaveTransaction = require("./src/models/LeaveTransaction");
const LeaveYearBalance = require("./src/models/LeaveYearBalance");

const OWNER_ID = "6838b0b708e8629ffab534ee";
const EMPLOYEE_ID = "68ac9d89a45dc85b1f1cefa9";
const YEAR = 2025;

// month index: 0 = Jan, 11 = Dec
const monthlyPaidUsage = [
  { month: 0, value: 2.5 },
  { month: 1, value: 2.5 },
  { month: 2, value: 4 },
  { month: 3, value: 1.5 },
  { month: 4, value: 0 },
  { month: 5, value: 3 },
  { month: 6, value: 0.5 },
  { month: 7, value: 3 },
  { month: 8, value: 2.5 },
  { month: 9, value: 0 },
  { month: 10, value: 0 },
  { month: 11, value: 1 },


];

async function seed2025MonthlyPaidLeaves() {
  const balance = await LeaveYearBalance.findOne({
    owner: OWNER_ID,
    employee: EMPLOYEE_ID,
    year: YEAR,
  });

  if (!balance) {
    throw new Error("❌ LeaveYearBalance not found for 2025");
  }

  const ops = monthlyPaidUsage.map(({ month, value }) => ({
    updateOne: {
      filter: {
        owner: OWNER_ID,
        employee: EMPLOYEE_ID,
        leaveYearBalance: balance._id,
        year: YEAR,
        type: "PAID_LEAVE_USED",
        date: new Date(2025, month, 26), 
      },
      update: {
        $setOnInsert: {
          owner: OWNER_ID,
          employee: EMPLOYEE_ID,
          leaveYearBalance: balance._id,
          year: YEAR,
          date: new Date(2025, month, 26),
          type: "PAID_LEAVE_USED",
          value,
          sourceModel: "HISTORICAL_IMPORT",
          sourceId: new mongoose.Types.ObjectId(),
          createdBy: null,
        },
      },
      upsert: true,
    },
  }));

  const result = await LeaveTransaction.bulkWrite(ops);

  console.log("✅ 2025 monthly PAID_LEAVE_USED transactions inserted");
  console.log("Inserted:", result.upsertedCount);
}

(async () => {
  try {
    await seed2025MonthlyPaidLeaves();
  } catch (err) {
    console.error(err);
  } finally {
    await mongoose.disconnect();
    process.exit(0);
  }
})();
