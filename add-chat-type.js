const mongoose = require("mongoose");
require("dotenv").config();

const WhatsAppMessage = require("./src/models/WhatsAppMessage");

async function addChatTypeToExistingMessages() {
    try {
        await mongoose.connect(process.env.MONGODB_URI);
        console.log("Connected to MongoDB");

        const result = await WhatsAppMessage.updateMany(
            { chatType: { $exists: false } },
            { $set: { chatType: "normal" } }
        );

        console.log(`✅ Updated ${result.modifiedCount} messages`);
        console.log(`📊 Total matched: ${result.matchedCount}`);

        await mongoose.disconnect();
        console.log("Disconnected");
    } catch (error) {
        console.error("Error:", error);
    }
}

addChatTypeToExistingMessages();