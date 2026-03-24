require("dotenv").config();
const mongoose = require("mongoose");
const AssignmentMessage = require("./src/models/AssignmentMessage");

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log("Connected to MongoDB.");
  
  // Find any unread emails that match the getUnreadCount logic
  const unreadMsgs = await AssignmentMessage.find({
      "readBy.employee": { $exists: true },
      isTrashed: false,
      isSpam: false,
      status: "sent",
      approvalStatus: { $ne: "pending" }
  }).limit(5);
  
  // Just find ALL unread messages matching the condition
  const allUnread = await AssignmentMessage.find({
      isTrashed: false,
      isSpam: false,
      status: "sent",
      approvalStatus: { $ne: "pending" }
  });
  
  const reallyUnread = allUnread.filter(msg => {
    // Check if there's any receiver who hasn't read it
    return msg.receiver.some(recId => {
      const readByMe = msg.readBy && msg.readBy.some(read => read.employee.toString() === recId.toString());
      return !readByMe;
    });
  });
  
  console.log("Total really unread:", reallyUnread.length);
  if (reallyUnread.length > 0) {
    const msg = reallyUnread[0];
    console.log("One Unread:", msg.subject, msg.sender, msg.receiver, msg.client, msg.isFromClient, msg.approvalStatus, msg.status);
    console.log("ReadBy:", msg.readBy);
    console.log("IsTrashed:", msg.isTrashed, "IsSpam:", msg.isSpam);
  }
  
  process.exit(0);
}

run();
