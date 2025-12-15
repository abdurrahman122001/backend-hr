require("dotenv").config();
const mongoose = require("mongoose");
const User = require("./src/models/Users");

async function seedOwner() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log("Connected DB:", mongoose.connection.name);

    const plainPassword = "Owner@123";

    const newOwner = {
      username: "owner2",
      email: "newowner@example.com",
      password: plainPassword, // ✅ let schema hash it
      role: "super-admin",
      createdBy: null,
    };

    const existing = await User.findOne({ email: newOwner.email });
    if (existing) {
      console.log("⚠️ Owner already exists:", existing.email);
      return;
    }

    const created = await User.create(newOwner);
    console.log("✅ New super-admin owner seeded");
    console.log("👉 Email:", created.email);
    console.log("👉 Password:", plainPassword);
  } catch (err) {
    console.error("❌ Error seeding owner:", err.message);
  } finally {
    await mongoose.connection.close();
  }
}

seedOwner();
