// updateManager.js
require("dotenv").config();
const mongoose = require("mongoose");
const Employee = require("./src/models/Employees"); // adjust path if needed

const TARGET_ID = new mongoose.Types.ObjectId("68b1610b482495e0314e4386");

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error("❌ MONGODB_URI is not set in environment (.env).");
    process.exit(1);
  }

  try {
    await mongoose.connect(uri);
    console.log("✅ Connected to MongoDB");

    const result = await Employee.updateOne(
      { _id: TARGET_ID },
      { $set: { role: "Team Lead" } }
    );

    if (result.matchedCount === 0) {
      console.log("⚠️ No employee found with this ID.");
    } else {
      console.log("🎉 Employee updated. Role set to Manager.");
    }
  } catch (err) {
    console.error("❌ Update error:", err);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
}

main();
