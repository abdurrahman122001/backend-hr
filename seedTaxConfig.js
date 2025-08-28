// scripts/seedTaxConfig.js  (run: node scripts/seedTaxConfig.js)
const mongoose = require("mongoose");
const TaxConfig = require("./src/models/TaxConfig");
require("dotenv").config();

(async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);

    const doc = {
      fiscalYear: "2025-26",
      enableMedicalExemption: true,
      slabs: [
        { from: 0,        to: 600000,  fixed: 0,      rateOver: 0   },
        { from: 600001,   to: 1200000, fixed: 0,      rateOver: 1   },
        { from: 1200001,  to: 2200000, fixed: 6000,   rateOver: 11  },
        { from: 2200001,  to: 3200000, fixed: 116000, rateOver: 23  },
        { from: 3200001,  to: 4100000, fixed: 346000, rateOver: 30  },
        { from: 4100001,               fixed: 616000, rateOver: 35  }, // open-ended
      ],
    };

    await TaxConfig.findOneAndUpdate(
      { fiscalYear: "2025-26"},
      doc,
      { upsert: true, new: true }
    );

    console.log("TaxConfig seeded for 2025-26 (PK).");
    process.exit(0);
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
})();
