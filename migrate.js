// migrateDepartmentOrder.js
require("dotenv").config();
const mongoose = require("mongoose");

// Adjust the path if your model filename/path differs:
const Department = require("./src/models/Departments");

async function migrate() {
  try {
    // For Mongoose v6+, the options are not required; keeping harmlessly.
    await mongoose.connect(process.env.MONGODB_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log("✅ Connected to MongoDB");

    // Get unique owners, filter out null/undefined
    let owners = await Department.distinct("owner");
    owners = owners.filter((o) => !!o);
    console.log(`Found ${owners.length} unique owners.`);

    // For each owner, order departments by createdAt (fallback to _id timestamp)
    for (const owner of owners) {
      // Try createdAt first; if your schema doesn't set timestamps, fall back to _id
      let departments = await Department.find({ owner }).sort({ createdAt: 1 }).lean();

      if (!departments.length) {
        // fallback (older docs may lack createdAt)
        departments = await Department.find({ owner }).sort({ _id: 1 }).lean();
      }

      if (departments.length === 0) continue;

      const bulkOps = departments.map((dep, idx) => ({
        updateOne: {
          filter: { _id: dep._id },
          update: { $set: { order: idx } }, // ensure your schema has "order" or allows it
        },
      }));

      if (bulkOps.length) {
        await Department.bulkWrite(bulkOps, { ordered: false });
      }

      console.log(`Updated ${departments.length} departments for owner ${owner}`);
    }

    console.log("✅ Migration complete.");
  } catch (err) {
    console.error("❌ Migration failed:", err);
  } finally {
    await mongoose.disconnect();
    console.log("🔌 Disconnected from MongoDB");
    process.exit();
  }
}

migrate();
