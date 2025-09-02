require("dotenv").config();
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const User = require("./src/models/Users"); // adjust path

async function seedOwner() {
  try {
    // Connect using MONGODB_URI from .env
    await mongoose.connect(process.env.MONGODB_URI);

    // Set your actual password here
    const plainPassword = "Owner@123"; // 👈 you can change this
    const hashedPassword = await bcrypt.hash(plainPassword, 10);

    const newOwner = {
      username: "owner2",
      email: "newowner@example.com",
      password: hashedPassword,
      role: "super-admin",
      createdBy: null, // or use another admin's _id
    };

    // Prevent duplicate by email
    const existing = await User.findOne({ email: newOwner.email });
    if (existing) {
      console.log("⚠️ Owner already exists:", existing.email);
    } else {
      const created = await User.create(newOwner);
      console.log("✅ New super-admin owner seeded");
      console.log("👉 Email:", created.email);
      console.log("👉 Password:", plainPassword); // show actual password
    }

    mongoose.connection.close();
  } catch (err) {
    console.error("❌ Error seeding owner:", err);
    mongoose.connection.close();
  }
}

seedOwner();
