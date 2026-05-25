const mongoose = require("mongoose");

const MONGODB_URI = "mongodb+srv://abdullahahmedqureshint:2zrm6dbPHMaVqwpL@cluster0.lcln8dt.mongodb.net/customLocal?retryWrites=true&w=majority&appName=Cluster0";

async function run() {
  await mongoose.connect(MONGODB_URI);
  console.log("Connected to Atlas DB!");

  const Attendance = mongoose.model("Attendance", new mongoose.Schema({}, { strict: false }), "attendances");

  const records = await Attendance.find({ date: { $in: ["2026-05-18", "2026-05-25"] } }).lean();
  console.log("Full records for 2026-05-18 and 2026-05-25:\n", JSON.stringify(records, null, 2));

  await mongoose.disconnect();
}

run().catch(console.error);

