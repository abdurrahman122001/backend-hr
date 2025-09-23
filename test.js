const mongoose = require("mongoose");
const Employee = require("./src/models/AssignmentMessage"); // adjust path if needed

const MONGODB_URI = "mongodb+srv://abdullahahmedqureshint:2zrm6dbPHMaVqwpL@cluster0.lcln8dt.mongodb.net/customLocal?retryWrites=true&w=majority&appName=Cluster0";

async function main() {
  try {
    await mongoose.connect(MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true });
    console.log("✅ Connected to MongoDB");

    const employees = await Employee.find({});
    console.log("📋 Employees:", employees);

    mongoose.disconnect();
  } catch (err) {
    console.error("❌ Error:", err);
  }
}

main();
