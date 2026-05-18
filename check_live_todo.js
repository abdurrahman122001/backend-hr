const mongoose = require("mongoose");

const MONGODB_URI = "mongodb://hrdbAdmin:StrongPassword2001@168.231.101.206:27017/hrdb?authSource=hrdb";

async function run() {
  await mongoose.connect(MONGODB_URI);
  console.log("Connected to live DB!");

  const User = mongoose.model("User", new mongoose.Schema({}, { strict: false }), "users");
  const Employee = mongoose.model("Employee", new mongoose.Schema({}, { strict: false }), "employees");

  const qaziEmail = "qaziabdurrahman12@gmail.com";
  const user = await User.findOne({ email: qaziEmail });

  if (user) {
    const empMatched = await Employee.findOne({
      $or: [
        { userAccount: user._id },
        { email: user.email },
        { companyEmail: user.companyEmail }
      ]
    });

    console.log("\n--- Verification ---");
    const isRootAdmin = user.role === "admin" || user.role === "super-admin";
    const rawRole = isRootAdmin ? user.role : (empMatched?.role || user.role || "");
    const normalizedRole = rawRole.toLowerCase().replace("_", "-");

    let effectiveOwner;
    if (isRootAdmin) {
      effectiveOwner = user.owner || user._id;
    } else {
      effectiveOwner = user.owner || empMatched?.owner || user.createdBy || user._id;
    }

    const finalOwnerId = Array.isArray(effectiveOwner) ? effectiveOwner[0] : effectiveOwner;

    console.log("Resolved Role (must be 'super-admin'):", normalizedRole);
    console.log("Resolved Owner ID (must be Qazi's ID '6883d17799cefb33629fa03f'):", finalOwnerId.toString());
  }

  await mongoose.disconnect();
}

run().catch(console.error);
