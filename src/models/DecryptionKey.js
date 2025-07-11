// src/models/DecryptionKey.js
const mongoose = require('mongoose');
const { Schema } = mongoose;

const DecryptionKeySchema = new Schema({
  owner:   { type: Schema.Types.ObjectId, ref: 'User', required: true },
  hash:    { type: String, required: true },   // bcrypt’d PIN
  aesKey:  { type: String, required: true },   // raw 32‐char AES key
  label:   { type: String },
  active:  { type: Boolean, default: false },
  createdBy:{ type: Schema.Types.ObjectId, ref: 'User' },
  createdAt:{ type: Date, default: Date.now }
});
DecryptionKeySchema.index({ hash: 1 }, { unique: true });

module.exports = mongoose.model('DecryptionKey', DecryptionKeySchema);
