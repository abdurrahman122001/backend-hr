require("dotenv").config();
const mongoose = require("mongoose");
const Designation = require("./src/models/Designations");

const MONGO_URI = process.env.MONGODB_URI;

async function seed() {
  await mongoose.connect(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true });
  // Your User ID here (replace with a valid one)
  const owner = "664c5bfb10b2b9d353ab23b1";

  const designations = [
    { name: "CEO", owner },
    { name: "Director", owner },
    { name: "Manager", owner },
    { name: "Team Lead", owner },
    { name: "Senior Supervisor", owner },
    { name: "HR Executive", owner },
    { name: "Supervisor", owner },
    { name: "Assistant", owner },
    { name: "Software Engineer", owner },
    { name: "Finance Executive", owner },
    { name: "Accountant", owner },
  ];

  for (const desig of designations) {
    // Only add if not already present (prevent duplicates)
    const exists = await Designation.findOne({ name: desig.name, owner });
    if (!exists) {
      await Designation.create(desig);
      console.log(`Added: ${desig.name}`);
    } else {
      console.log(`Exists: ${desig.name}`);
    }
  }

  mongoose.disconnect();
}

seed();
