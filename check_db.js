const mongoose = require("mongoose");
require("dotenv").config();

const MONGODB_URI = "mongodb://hrdbAdmin:StrongPassword2001@168.231.101.206:27017/hrdb?authSource=hrdb";

async function check() {
  await mongoose.connect(MONGODB_URI);
  console.log("Connected to MongoDB!");

  const User = mongoose.model("User", new mongoose.Schema({}, { strict: false }), "users");
  const Employee = mongoose.model("Employee", new mongoose.Schema({}, { strict: false }), "employees");
  const LeaveRequest = mongoose.model("ApplyLeave", new mongoose.Schema({}, { strict: false }), "applyleaves");
  const Attendance = mongoose.model("Attendance", new mongoose.Schema({}, { strict: false }), "attendances");

  const qaziUser = await User.findOne({ email: "qaziabdurrahman12@gmail.com" });
  const adeelUser = await User.findOne({ email: "adeelshaikh96@live.com" });

  console.log("\n--- Users ---");
  if (qaziUser) {
    console.log("Qazi User:", {
      _id: qaziUser._id,
      email: qaziUser.email,
      role: qaziUser.role,
      owner: qaziUser.owner,
      createdBy: qaziUser.createdBy
    });
  } else {
    console.log("Qazi user not found!");
  }

  if (adeelUser) {
    console.log("Adeel User:", {
      _id: adeelUser._id,
      email: adeelUser.email,
      role: adeelUser.role,
      owner: adeelUser.owner,
      createdBy: adeelUser.createdBy
    });
  } else {
    console.log("Adeel user not found!");
  }

  // Count employees for each
  const totalEmployees = await Employee.countDocuments({});
  console.log(`\nTotal Employees in DB: ${totalEmployees}`);

  const qaziEmployees = await Employee.find({ owner: qaziUser?._id });
  console.log(`Employees owned directly by Qazi (${qaziUser?._id}): ${qaziEmployees.length}`);
  qaziEmployees.forEach(e => console.log(` - Name: ${e.name}, _id: ${e._id}, owner: ${JSON.stringify(e.owner)}`));

  const adeelEmployees = await Employee.find({ owner: adeelUser?._id });
  console.log(`Employees owned directly by Adeel (${adeelUser?._id}): ${adeelEmployees.length}`);
  adeelEmployees.forEach(e => console.log(` - Name: ${e.name}, _id: ${e._id}, owner: ${JSON.stringify(e.owner)}`));

  // Let's search for employees shown in screenshot:
  const targetNames = ["Syed Kashan Ali", "Muhammad Awais", "Abdullah Ahmed Qureshi", "Qazi Abdul Rahman", "Usaid Ahmed", "Muhammad Huzaifa", "Muhammad Muzammil Zaki"];
  console.log("\n--- Target Employees' Ownerships ---");
  for (const name of targetNames) {
    const emps = await Employee.find({ name: new RegExp(name, "i") });
    console.log(`Searching for "${name}": Found ${emps.length} record(s)`);
    emps.forEach(e => {
      console.log(`   - Full Name: ${e.name}`);
      console.log(`     _id: ${e._id}`);
      console.log(`     owner: ${JSON.stringify(e.owner)}`);
      console.log(`     createdBy: ${e.createdBy}`);
    });
  }

  await mongoose.disconnect();
}

check().catch(console.error);
