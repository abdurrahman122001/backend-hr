const mongoose = require('mongoose');
const { Message } = require('./src/models/Chat');
require('dotenv').config();

async function check() {
  await mongoose.connect(process.env.MONGODB_URI);
  const lastMessages = await Message.find().sort({ createdAt: -1 }).limit(5);
  console.log('--- Last 5 Messages ---');
  lastMessages.forEach((msg, i) => {
    console.log(`[${i}] ID: ${msg._id}`);
    console.log(`    Content: "${msg.content}"`);
    console.log(`    Content length: ${msg.content.length}`);
    console.log(`    Has newlines: ${msg.content.includes('\n')}`);
    console.log(`    Has <br>: ${msg.content.includes('<br>')}`);
    console.log('------------------------');
  });
  await mongoose.disconnect();
}

check();
