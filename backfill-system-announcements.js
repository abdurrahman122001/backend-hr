// One-off backfill: turn the Request Center history into inbox announcements.
//
// From here on every request event writes its own announcement as it happens
// (services/requestNotificationService -> systemAnnouncementService). This
// script covers what happened BEFORE that existed, so the System Announcements
// tab isn't empty for requests people already submitted, approved or rejected.
//
// Source of truth is RequestNotification: one announcement per notification,
// addressed to the same person. Already-announced notifications are skipped by
// matching (recipient, requestId, action), so the script is safe to re-run.
//
// Run from backend/:  node backfill-system-announcements.js
//        preview it:  node backfill-system-announcements.js --dry
const mongoose = require("mongoose");
require("dotenv").config();

const RequestNotification = require("./src/models/RequestNotification");
const AssignmentMessage = require("./src/models/AssignmentMessage");
const Employee = require("./src/models/Employees");
require("./src/models/Users");
const {
  announceRequestEvent,
} = require("./src/services/systemAnnouncementService");

const DRY = process.argv.includes("--dry");

const requestTypeLabels = {
  leave: "Leave request",
  attendance: "Attendance adjustment",
  "advance-salary": "Advance salary request",
  bonus: "Bonus request",
  commission: "Commission request",
  document: "Document request",
  "leave-carry-forward": "Leave carry-forward request",
  "leave-encashment": "Leave encashment request",
  loan: "Loan request",
  overtime: "Overtime request",
  profile: "Profile revision request",
  reimbursement: "Reimbursement request",
  "salary-change": "Salary change request",
  "tax-adjustment": "Tax adjustment request",
  whistleblowing: "Whistleblowing report",
};

async function run() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  await mongoose.connect(uri);
  console.log(`Connected to MongoDB${DRY ? " (dry run — nothing is written)" : ""}`);

  // Oldest first so the tab reads in the order things actually happened.
  const notifications = await RequestNotification.find({})
    .sort({ createdAt: 1 })
    .lean();
  console.log(`Found ${notifications.length} request notification(s)`);

  let created = 0;
  let skipped = 0;
  let failed = 0;

  for (const notification of notifications) {
    const label = `${notification.action} "${notification.title}"`;
    try {
      const already = await AssignmentMessage.exists({
        isSystemAnnouncement: true,
        receiver: notification.recipient,
        "systemAnnouncement.requestId": notification.requestId,
        "systemAnnouncement.action": notification.action,
      });
      if (already) {
        skipped++;
        continue;
      }

      const recipient = await Employee.findById(notification.recipient)
        .select("_id name status")
        .lean();
      if (!recipient || String(recipient.status || "").toLowerCase() !== "active") {
        console.warn(`- ${label}: recipient missing or not active, skipped`);
        skipped++;
        continue;
      }

      if (DRY) {
        console.log(`  WOULD CREATE → ${recipient.name}: ${notification.title}`);
        created++;
        continue;
      }

      const announcement = await announceRequestEvent({
        recipientId: notification.recipient,
        actorId: notification.actor,
        title: notification.title,
        message: notification.message,
        requestId: notification.requestId,
        requestType: notification.requestType,
        requestLabel:
          requestTypeLabels[notification.requestType] || "Request",
        action: notification.action,
        target: notification.target,
        occurredAt: notification.createdAt,
      });

      if (!announcement) {
        failed++;
        console.warn(`✖ ${label}: announcement not written`);
        continue;
      }

      // Keep the announcement dated to the event it reports, not to this run,
      // or the whole history lands at the top of the mailbox as "just now".
      //
      // Through the native collection because Mongoose marks `createdAt`
      // immutable once timestamps are on: a normal updateOne drops the $set
      // silently and the row keeps today's date.
      await AssignmentMessage.collection.updateOne(
        { _id: announcement._id },
        {
          $set: {
            createdAt: notification.createdAt,
            sentAt: notification.createdAt,
          },
        }
      );

      created++;
      console.log(`✔ ${recipient.name}: ${notification.title}`);
    } catch (error) {
      failed++;
      console.error(`✖ ${label}:`, error.message);
    }
  }

  console.log(
    `\nDone. Announcements ${DRY ? "to create" : "created"}: ${created}, ` +
      `already present/skipped: ${skipped}, failed: ${failed}`
  );
  await mongoose.disconnect();
  console.log("Disconnected");
}

run().catch((error) => {
  console.error("Backfill failed:", error);
  process.exit(1);
});
