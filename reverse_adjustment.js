const mongoose = require("mongoose");
require("dotenv").config();

// ==================== CONFIGURATION ====================
// You can edit these IDs directly here, or pass them as command line arguments:
// Example command: node reverse_adjustment.js <transactionId> <balanceId> [newReversedValue]
const DEFAULT_TRANSACTION_ID = "6a1460c17d526ec1cd353df3";
const DEFAULT_BALANCE_ID = "6952c42b7d8d06d90a837cb2";
const DEFAULT_NEW_VALUE = 0.5;

// Load MONGODB_URI from environment variable with fallback
const MONGODB_URI = process.env.MONGODB_URI || "mongodb+srv://abdullahahmedqureshint:2zrm6dbPHMaVqwpL@cluster0.lcln8dt.mongodb.net/customLocal?retryWrites=true&w=majority&appName=Cluster0";
// ========================================================

async function run() {
  const transactionId = process.argv[2] || DEFAULT_TRANSACTION_ID;
  const balanceId = process.argv[3] || DEFAULT_BALANCE_ID;
  const newValue = Number(process.argv[4] || DEFAULT_NEW_VALUE);

  if (transactionId === "YOUR_TRANSACTION_ID" || balanceId === "YOUR_BALANCE_ID") {
    console.error("❌ Please specify valid IDs at the top of the file or pass them as arguments!");
    console.error("Usage: node reverse_adjustment.js <transactionId> <balanceId> [newReversedValue]");
    return;
  }

  if (!MONGODB_URI) {
    console.error("❌ MongoDB connection URI not found! Please define MONGODB_URI in your .env file.");
    return;
  }

  await mongoose.connect(MONGODB_URI);
  console.log("Connected to MongoDB successfully!");

  // Define models inline for simplicity
  const LeaveTransaction = mongoose.model(
    "LeaveTransaction",
    new mongoose.Schema({}, { strict: false }),
    "leavetransactions"
  );
  
  const LeaveYearBalance = mongoose.model(
    "LeaveYearBalance",
    new mongoose.Schema({}, { strict: false }),
    "leaveyearbalances"
  );

  console.log(`\n🔍 Finding LeaveTransaction with ID: ${transactionId}...`);
  const tx = await LeaveTransaction.findById(transactionId);
  if (!tx) {
    console.error("❌ LeaveTransaction not found!");
    await mongoose.disconnect();
    return;
  }
  console.log("Found LeaveTransaction:", JSON.stringify(tx, null, 2));

  console.log(`\n🔍 Finding LeaveYearBalance with ID: ${balanceId}...`);
  const balance = await LeaveYearBalance.findById(balanceId);
  if (!balance) {
    console.error("❌ LeaveYearBalance not found!");
    await mongoose.disconnect();
    return;
  }
  console.log("Found LeaveYearBalance:", JSON.stringify(balance, null, 2));

  const oldValue = tx.value;
  const diff = oldValue - newValue; 

  console.log(`\n⚙️ Preparing adjustment...`);
  console.log(`- Transaction value: ${oldValue} ➔ ${newValue}`);
  console.log(`- Balance usedPaid: ${balance.usedPaid} ➔ ${balance.usedPaid + diff}`);

  // Perform updates
  tx.value = newValue;
  balance.usedPaid = Number((balance.usedPaid + diff).toFixed(2));

  await tx.save();
  await balance.save();

  console.log("\n✅ Database updated successfully!");
  console.log("Updated Transaction:", JSON.stringify(tx, null, 2));
  console.log("Updated Balance:", JSON.stringify(balance, null, 2));

  await mongoose.disconnect();
}

run().catch(console.error);
