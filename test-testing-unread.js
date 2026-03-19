require("dotenv").config();
const mongoose = require("mongoose");
const AssignmentMessage = require("./src/models/AssignmentMessage");
const Employee = require("./src/models/Employees");

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  
  const allUnread = await AssignmentMessage.find({
    isTrashed: false,
    isSpam: false,
    status: "sent",
    approvalStatus: { $ne: "pending" }
  }).lean();
  
  const reallyUnreadByEmployee = {};
  
  for (const msg of allUnread) {
    if (!msg.receiver) continue;
    for (const recId of msg.receiver) {
      const recIdStr = recId.toString();
      const readByMe = msg.readBy && msg.readBy.some(read => read.employee.toString() === recIdStr);
      if (!readByMe) {
        if (!reallyUnreadByEmployee[recIdStr]) reallyUnreadByEmployee[recIdStr] = [];
        reallyUnreadByEmployee[recIdStr].push(msg);
      }
    }
  }
  
  for (const [empId, msgs] of Object.entries(reallyUnreadByEmployee)) {
    const emp = await Employee.findById(empId).lean();
    console.log(`\nEmployee: ${emp ? emp.name : empId} (${empId}) - Unread emails: ${msgs.length}`);
    for (const m of msgs) {
      console.log(`  -> ID: ${m._id}, Subject: ${m.subject}, Client: ${m.client}, isFromClient: ${m.isFromClient}, isInternal: ${!m.client && !m.isFromClient}`);
    }
  }
  
  process.exit(0);
}

run();
