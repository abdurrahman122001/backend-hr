const mongoose = require('mongoose');
const dotenv = require('dotenv');
dotenv.config();

async function checkIndexes() {
  try {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/customLocal');
    console.log('Connected to MongoDB');
    
    const collection = mongoose.connection.db.collection('referencecounters');
    const indexes = await collection.indexes();
    console.log('Indexes for referencecounters:', JSON.stringify(indexes, null, 2));
    
    await mongoose.disconnect();
  } catch (err) {
    console.error('Error:', err);
  }
}

checkIndexes();
