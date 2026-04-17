/**
 * Migration script to update old WhatsApp messages with new schema fields
 * Run this to ensure backwards compatibility for messages created before the schema update
 *
 * Usage: node migrateOldMessages.js
 */

const mongoose = require("mongoose");
const WhatsAppMessage = require("./src/models/WhatsAppMessage");

// MongoDB connection string - update this to match your environment
const MONGODB_URI = process.env.MONGODB_URI || "mongodb://hrdbAdmin:StrongPassword2001@168.231.101.206:27017/hrdb?authSource=hrdb&replicaSet=rs0";

async function migrateOldMessages() {
  try {
    console.log("🔌 Connecting to MongoDB...");
    await mongoose.connect(MONGODB_URI);
    console.log("✅ Connected to MongoDB");

    // Find all messages that might be missing new fields
    // We use $or to find messages where these fields don't exist or are null
    const query = {
      $or: [
        { isGroupMessage: { $exists: false } },
        { isGroupMessage: null },
        { isClientEmployeeMessage: { $exists: false } },
        { isClientEmployeeMessage: null },
        { chatType: { $exists: false } },
        { chatType: null },
        { comments: { $exists: false } },
        { comments: null },
        { commentCount: { $exists: false } },
        { commentCount: null },
      ],
    };

    console.log("🔍 Finding old messages that need migration...");
    const messagesToUpdate = await WhatsAppMessage.find(query).select("_id").lean();

    console.log(`📊 Found ${messagesToUpdate.length} messages to update`);

    if (messagesToUpdate.length === 0) {
      console.log("✨ No messages need migration. Exiting.");
      await mongoose.disconnect();
      return;
    }

    // Bulk update to add default values for new fields
    console.log("📝 Applying migration...");

    const bulkOps = messagesToUpdate.map((msg) => ({
      updateOne: {
        filter: { _id: msg._id },
        update: {
          $set: {
            // Set defaults for group chat fields
            isGroupMessage: false,
            groupId: null,
            chatType: "normal",

            // Set defaults for client employee fields
            isClientEmployeeMessage: false,
            clientEmployeeId: null,
            clientEmployeeData: null,
            parentClientId: null,

            // Set defaults for comments system
            comments: [],
            commentCount: 0,
            commenters: [],

            // Set defaults for edit tracking
            isEdited: false,

            // Set defaults for scheduling
            isScheduled: false,

            // Set defaults for deletion tracking
            deletedForEveryone: false,
            deletedForUsers: [],

            // Set defaults for reply tracking
            isReply: false,
            repliedTo: null,
            replyContent: null,
          },
        },
      },
    }));

    // Execute bulk update in batches of 500 to avoid memory issues
    const BATCH_SIZE = 500;
    let updatedCount = 0;

    for (let i = 0; i < bulkOps.length; i += BATCH_SIZE) {
      const batch = bulkOps.slice(i, i + BATCH_SIZE);
      const result = await WhatsAppMessage.bulkWrite(batch);
      updatedCount += result.modifiedCount;
      console.log(`  📦 Batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(bulkOps.length / BATCH_SIZE)}: Updated ${result.modifiedCount} messages`);
    }

    console.log(`\n✅ Migration complete! Updated ${updatedCount} messages`);
    console.log("\n📝 Summary of changes:");
    console.log("  - Added isGroupMessage: false (default)");
    console.log("  - Added chatType: 'normal' (default)");
    console.log("  - Added isClientEmployeeMessage: false (default)");
    console.log("  - Added comments: [] (empty array)");
    console.log("  - Added commentCount: 0 (default)");
    console.log("  - Added other missing fields with defaults");

    await mongoose.disconnect();
    console.log("\n👋 Done!");
  } catch (error) {
    console.error("\n❌ Migration failed:", error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

// Run migration
migrateOldMessages();
