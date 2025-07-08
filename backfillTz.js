// backend/backfillTz.js
require('dotenv').config();
const mongoose = require('mongoose');
const User     = require('../src/models/Users');

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const res = await User.updateMany(
    { timeZone: null },
    { $set: { timeZone: browserTz } }
  );
  console.log('Updated', res.modifiedCount, 'users to', browserTz);
  process.exit();
}
run();