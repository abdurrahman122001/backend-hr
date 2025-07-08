const mongoose = require('mongoose');
const { Schema } = mongoose;

const DecryptionKeySchema = new Schema({
  owner:     { type: Schema.Types.ObjectId, ref: 'User', required: true }, // The owner/admin user
  hash:      { type: String, required: true }, // Hashed key (bcrypt)
  label:     { type: String },
  active:    { type: Boolean, default: false },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' }, // Who created it (could match owner)
  createdAt: { type: Date, default: Date.now },
});

DecryptionKeySchema.index({ hash: 1 }, { unique: true });

module.exports = mongoose.model('DecryptionKey', DecryptionKeySchema);
