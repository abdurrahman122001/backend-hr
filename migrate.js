// migrateDepartmentOrder.js
require("dotenv").config();
const mongoose = require("mongoose");
const Department = require('./src/models/Departments');

async function migrate() {
  try {
    await mongoose.connect(process.env.MONGODB_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log("✅ Connected to MongoDB");

    const owners = await Department.distinct('owner');
    console.log(`Found ${owners.length} unique owners.`);

    for (const owner of owners) {
      const departments = await Department.find({ owner }).sort({ createdAt: 1 });
      if (departments.length === 0) continue;

      const bulkOps = departments.map((dep, idx) => ({
        updateOne: {
          filter: { _id: dep._id },
          update: { $set: { order: idx } },
        }
      }));

      await Department.bulkWrite(bulkOps);
      console.log(`Updated ${departments.length} departments for owner ${owner}`);
    }

    console.log('✅ Migration complete.');
  } catch (err) {
    console.error("❌ Migration failed:", err);
  } finally {
    await mongoose.disconnect();
    console.log("🔌 Disconnected from MongoDB");
    process.exit();
  }
}

migrate();
