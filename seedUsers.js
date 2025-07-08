// backend/seedUsers.js
require('dotenv').config();
const mongoose = require('mongoose');
const User     = require('./src/models/Users');  // your User model

(async () => {
  try {
    // 1) Connect
    await mongoose.connect(process.env.MONGODB_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log('🔗 Connected to MongoDB');

    // 2) Remove old admin and old owner
    await User.deleteOne({ username: 'admin' });
    console.log('🗑️  Old admin record removed (if existed)');

    // Note the `new` keyword here:
    const ownerId = new mongoose.Types.ObjectId('6838b0b708e8629ffab534ee');
    await User.deleteOne({ _id: ownerId });
    console.log('🗑️  Old owner record removed (if existed)');

    // 3) Create new admin (password will be hashed via your pre-save hook)
    const admin = new User({
      username: 'admin',
      email:    'abdullahahmedqureshint@gmail.com',
      password: 'Admin@123',
    });
    await admin.save();
    console.log('🎉 New admin user created');

    // 4) Create new owner user with fixed _id
    const owner = new User({
      _id:      ownerId,
      username: 'owner',
      email:    'owner@example.com',
      password: 'Owner@123',
    });
    await owner.save();
    console.log(`🎉 New owner user created with _id ${owner._id}`);

  } catch (err) {
    console.error('❌ Error during seeding:', err);
  } finally {
    // 5) Disconnect
    await mongoose.disconnect();
    console.log('👋 Disconnected from MongoDB');
    process.exit(0);
  }
})();
