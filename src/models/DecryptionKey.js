const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const DecryptionKeySchema = new Schema({
  owner: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  hash: { type: String, required: true }, // bcrypt hash of PIN
  currentAesKey: { type: String, required: true }, // 32 chars
  previousAesKey: { type: String }, // For rotation
  keyVersion: { type: Number, default: 1 },
  active: { type: Boolean, default: true },
}, { timestamps: true });

module.exports = mongoose.model('DecryptionKey', DecryptionKeySchema);
