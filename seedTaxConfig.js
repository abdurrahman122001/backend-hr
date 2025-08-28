// scripts/seedTaxConfig.js
// Usage: node scripts/seedTaxConfig.js
require("dotenv").config();
const mongoose = require("mongoose");
const TaxConfig = require("./src/models/TaxConfig"); // adjust path if your models live elsewhere

(async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);

    // Cumulative slabs to match Excel math
    const cfg = {
      fiscalYear: "2025-26",
      enableMedicalExemption: true,
      slabs: [
        { from: 0,        to: 600000,  fixed: 0,      rateOver: 0  },  // 0% up to 600k
        { from: 600001,   to: 1200000, fixed: 0,      rateOver: 1  },  // 1% over 600k
        { from: 1200001,  to: 2200000, fixed: 6000,   rateOver: 11 },  // 6,000 + 11% over 1.2m
        { from: 2200001,  to: 3200000, fixed: 116000, rateOver: 23 },  // 116,000 + 23% over 2.2m
        { from: 3200001,  to: 4100000, fixed: 346000, rateOver: 30 },  // 346,000 + 30% over 3.2m
        { from: 4100001,                fixed: 616000, rateOver: 35 },  // 616,000 + 35% over 4.1m
      ],
    };

    const updated = await TaxConfig.findOneAndUpdate(
      { fiscalYear: cfg.fiscalYear },
      cfg,
      { upsert: true, new: true }
    ).lean();

    console.log("✅ TaxConfig seeded/updated:", updated);
    process.exit(0);
  } catch (e) {
    console.error("Seed error:", e);
    process.exit(1);
  }
})();
