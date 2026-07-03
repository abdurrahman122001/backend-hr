s// fix-doctemplates-indexes.js
const mongoose = require('mongoose');
require('dotenv').config();

async function fixDocTemplatesIndexes() {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/customLocal', {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });

    console.log('Connected to MongoDB');
    
    // Get the doctemplates collection
    const db = mongoose.connection.db;
    const collection = db.collection('doctemplates');
    
    // 1. Get current indexes
    console.log('Current indexes:');
    const indexes = await collection.getIndexes();
    console.log(JSON.stringify(indexes, null, 2));
    
    // 2. Check if type_1 unique index exists
    const typeIndex = indexes['type_1'];
    if (typeIndex && typeIndex.unique) {
      console.log('\n⚠️ Found unique index on "type" field. Dropping it...');
      
      // Drop the unique index
      await collection.dropIndex('type_1');
      console.log('✅ Dropped unique index on "type" field');
    } else {
      console.log('\n✅ No unique index found on "type" field');
    }
    
    // 3. Create compound indexes
    console.log('\nCreating compound indexes...');
    
    // Compound unique index: type + owner (for user templates)
    try {
      await collection.createIndex(
        { type: 1, owner: 1 },
        { 
          unique: true, 
          sparse: true,
          name: 'type_owner_unique'
        }
      );
      console.log('✅ Created compound unique index: {type: 1, owner: 1}');
    } catch (err) {
      console.log('ℹ️ Compound index {type: 1, owner: 1} already exists or error:', err.message);
    }
    
    // Index for global templates
    try {
      await collection.createIndex(
        { type: 1, isGlobal: 1 },
        { 
          name: 'type_isGlobal' 
        }
      );
      console.log('✅ Created index: {type: 1, isGlobal: 1}');
    } catch (err) {
      console.log('ℹ️ Index {type: 1, isGlobal: 1} already exists or error:', err.message);
    }
    
    // 4. Verify new indexes
    console.log('\n✅ Final indexes:');
    const finalIndexes = await collection.getIndexes();
    console.log(JSON.stringify(finalIndexes, null, 2));
    
    console.log('\n🎉 Index migration completed successfully!');
    
  } catch (error) {
    console.error('❌ Error during migration:', error);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
    console.log('Disconnected from MongoDB');
  }
}

// Run the migration
fixDocTemplatesIndexes();