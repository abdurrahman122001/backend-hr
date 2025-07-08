// migrate.js
require("dotenv").config();
const mongoose = require("mongoose");

async function migrate() {
  try {
    await mongoose.connect(process.env.MONGODB_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log("✅ Connected to MongoDB");

    // delete any in‐memory models so require() can re-register them
    Object.keys(mongoose.models).forEach((modelName) => {
      mongoose.deleteModel(modelName);
    });

    require("./src/models/SalarySlip");
    // require("./src/models/Leaves");

    // sync indexes
    for (let modelName of Object.keys(mongoose.models)) {
      const model = mongoose.models[modelName];
      await model.syncIndexes();
      console.log(`– synced indexes for ${modelName}`);
    }

    console.log("🎉 Migration complete!");
    process.exit(0);
  } catch (err) {
    console.error("❌ Migration failed:", err);
    process.exit(1);
  }
}

migrate();
