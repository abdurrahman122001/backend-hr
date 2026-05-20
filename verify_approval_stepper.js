const mongoose = require("mongoose");
const AssignmentMessage = require("./src/models/AssignmentMessage");
require("dotenv").config();

async function verifyApprovalStepper() {
  try {
    console.log("Connecting to database at:", process.env.MONGODB_URI);
    await mongoose.connect(process.env.MONGODB_URI);
    console.log("Connected successfully.\n");

    // 1. Check schema fields existence
    const schemaPaths = AssignmentMessage.schema.paths;
    console.log("--- Schema Fields Verification ---");
    console.log("approvedBy field exists:", !!schemaPaths.approvedBy);
    console.log("approvedBy ref:", schemaPaths.approvedBy?.options?.ref);
    console.log("disapprovedBy field exists:", !!schemaPaths.disapprovedBy);
    console.log("disapprovedBy ref:", schemaPaths.disapprovedBy?.options?.ref);
    console.log("disapprovalNote field exists:", !!schemaPaths.disapprovalNote);
    console.log("---------------------------------\n");

    // 2. Query last 5 assignment messages and attempt to populate
    console.log("--- Querying & Populating Assignment Messages ---");
    const messages = await AssignmentMessage.find()
      .sort({ createdAt: -1 })
      .limit(5)
      .populate([
        { path: "sender", select: "_id name companyEmail role" },
        { path: "receiver", select: "_id name companyEmail role" },
        { path: "approvedBy", select: "_id name companyEmail role" },
        { path: "disapprovedBy", select: "_id name companyEmail role" },
      ])
      .lean();

    console.log(`Found ${messages.length} recent messages.`);

    messages.forEach((msg, idx) => {
      console.log(`\n[Message ${idx + 1}] ID: ${msg._id}`);
      console.log(`  Sender: ${msg.sender?.name || "N/A"} (${msg.sender?.role || "N/A"})`);
      console.log(`  Approval Status: ${msg.approvalStatus}`);
      console.log(`  Approved By: ${msg.approvedBy ? `${msg.approvedBy.name} (${msg.approvedBy.role})` : "None"}`);
      console.log(`  Disapproved By: ${msg.disapprovedBy ? `${msg.disapprovedBy.name} (${msg.disapprovedBy.role})` : "None"}`);
      if (msg.disapprovalNote) {
        console.log(`  Disapproval Note: "${msg.disapprovalNote}"`);
      }
    });

    console.log("\n--- Verification Complete ---");
  } catch (error) {
    console.error("Verification failed with error:", error);
  } finally {
    await mongoose.disconnect();
    console.log("Disconnected from database.");
  }
}

verifyApprovalStepper();
