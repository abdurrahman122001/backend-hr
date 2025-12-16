// addOwner.js
require("dotenv").config();
const mongoose = require("mongoose");
const DocTemplate = require("./src/models/DocTemplate"); // Adjust path

async function addOwner() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log("✅ Connected to MongoDB");

    const ownerId = "6838b0b708e8629ffab534ee";
    
    // Template IDs from your data
    const templateIds = [
      "68ff93aef06c90cf996188d0", // nda
      "68ffaab1f06c90cf996188ff", // contract  
      "6925fdcc7d8d06d90a837b48", // salary_certificate
      "693b0d4f7d8d06d90a837bfb"  // experience_letter
    ];

    console.log(`Adding owner ${ownerId} to templates...`);

    // Update all templates at once
    const result = await DocTemplate.updateMany(
      { _id: { $in: templateIds } },
      { 
        $set: { 
          owner: ownerId,
          isGlobal: false,
          updatedAt: new Date()
        }
      }
    );

    console.log(`✅ Updated ${result.modifiedCount} templates`);

    // Show what was updated
    const updated = await DocTemplate.find({ _id: { $in: templateIds } });
    console.log("\n📋 Updated Templates:");
    updated.forEach(t => {
      console.log(`  ${t.type.padEnd(20)} - Owner: ${t.owner}`);
    });

  } catch (err) {
    console.error("❌ Error:", err.message);
  } finally {
    await mongoose.disconnect();
    console.log("\n🔌 Disconnected");
  }
}

// Run it
addOwner();