require("dotenv").config();
const mongoose = require("mongoose");

// IMPORTANT: must be the MODEL, not schema
const Bug = require("./src/models/Bug");

// ===== CONFIG =====
const MONGODB_URI =
  process.env.MONGODB_URI || "mongodb://localhost:27017/your_db";

async function backfillBugRewards() {
  /**
   * This filter ensures:
   * - Only bugs where rewardAdded does NOT exist OR is false
   * - rewardAmount missing or zero
   * So existing valid rewards are NOT overwritten
   */
  const filter = {
    $or: [
      { rewardAdded: { $exists: false } },
      { rewardAdded: false },
      { rewardAmount: { $exists: false } },
      { rewardAmount: 0 },
    ],
  };

  const update = {
    $set: {
      rewardAdded: true,
      rewardAmount: 100,
    },
  };

  const result = await Bug.updateMany(filter, update);

  console.log(`✔ Updated ${result.modifiedCount} bug(s).`);
}

(async () => {
  try {
    console.log("Connecting to MongoDB...");
    await mongoose.connect(MONGODB_URI);
    console.log("✔ Connected.");

    await backfillBugRewards();

    console.log("🎉 Bug reward migration complete.");
    await mongoose.disconnect();
    process.exit(0);
  } catch (error) {
    console.error("❌ Migration failed:", error);
    process.exit(1);
  }
})();
