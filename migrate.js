// migrateLoanDetailSchema.js
require("dotenv").config();
const mongoose = require("mongoose");

async function migrate() {
  try {
    await mongoose.connect(process.env.MONGODB_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log("✅ Connected to MongoDB");

    // Remove cached models
    Object.keys(mongoose.models).forEach((modelName) => {
      mongoose.deleteModel(modelName);
    });

    require("./src/models/Salaries");
    require("./src/models/SalarySlip")
    require("./src/models/DecryptionKey");
    // require("./src/models/Leaves");

    // Sync indexes
    for (let modelName of Object.keys(mongoose.models)) {
      const model = mongoose.models[modelName];
      await model.syncIndexes();
      console.log(`– synced indexes for ${modelName}`);
    }

    console.log("🎉 Schema migration complete!");
    process.exit(0);
  } catch (err) {
    console.error("❌ Migration failed:", err);
    process.exit(1);
  }
}

migrate();
