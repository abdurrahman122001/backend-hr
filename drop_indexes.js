
const mongoose = require('mongoose');
const dotenv = require('dotenv');
dotenv.config();

async function dropBadIndexes() {
  try {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/customLocal');
    console.log('Connected to MongoDB');
    
    const collection = mongoose.connection.db.collection('referencecounters');
    const indexesToDrop = [
      'prefix_1_docType_1',
      'docType_1_yearMonth_1',
      'prefix_1'
    ];
    
    for (const indexName of indexesToDrop) {
      try {
        await collection.dropIndex(indexName);
        console.log(`Dropped index: ${indexName}`);
      } catch (err) {
        if (err.codeName === 'IndexNotFound') {
          console.log(`Index ${indexName} not found, skipping.`);
        } else {
          console.error(`Error dropping index ${indexName}:`, err.message);
        }
      }
    }
    
    await mongoose.disconnect();
    console.log('Done');
  } catch (err) {
    console.error('Error:', err);
  }
}

dropBadIndexes();
