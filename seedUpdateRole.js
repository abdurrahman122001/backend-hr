require("dotenv").config();
const mongoose = require("mongoose");
const User = require("./src/models/Users");

const MONGO_URI = process.env.MONGODB_URI || "mongodb://localhost:27017/hrm";
const OWNER_ID = "6838b0b708e8629ffab534ee";

async function seedUpdateOwnerRole() {
  await mongoose.connect(MONGO_URI);

  // Use 'new' keyword for ObjectId
  const result = await User.updateOne(
    { _id: new mongoose.Types.ObjectId(OWNER_ID) },
    { $set: { role: "super-admin" } }
  );

  if (result.matchedCount === 1 && result.modifiedCount === 1) {
    console.log("Role updated to super-admin.");
  } else if (result.matchedCount === 1) {
    console.log("User found, but role was already super-admin.");
  } else {
    console.log("User not found. No changes made.");
  }

  await mongoose.disconnect();
}

seedUpdateOwnerRole().catch((err) => {
  console.error("Error updating role:", err);
  mongoose.disconnect();
});
