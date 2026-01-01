const mongoose = require("mongoose");

mongoose.connect(
  "mongodb+srv://abdullahahmedqureshint:2zrm6dbPHMaVqwpL@cluster0.lcln8dt.mongodb.net/customLocal"
);

const LeaveTransaction = require("./src/models/LeaveTransaction");
const LeaveYearBalance = require("./src/models/LeaveYearBalance");

const OWNER_ID = "6838b0b708e8629ffab534ee";
const EMPLOYEE_ID = "68b1610b482495e0314e4386";
const YEAR = 2026;

// month index: 0 = Jan, 11 = Dec
const monthlyPaidUsage = [
  { month: 0, value: 3 },
  { month: 1, value: 1.5 },

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
