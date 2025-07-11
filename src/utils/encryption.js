// const crypto = require('crypto');

// // Use EXACTLY 32 characters for AES-256
// const ENCRYPTION_KEY = (process.env.ENCRYPTION_KEY || "mySecretKey12345678901234567890!").padEnd(32, '!').slice(0, 32);
// const IV_LENGTH = 16;

// function encrypt(text) {
//   if (!text) return "";
//   let iv = crypto.randomBytes(IV_LENGTH);
//   let cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
//   let encrypted = cipher.update(text.toString(), 'utf8', 'base64');
//   encrypted += cipher.final('base64');
//   return iv.toString('base64') + ':' + encrypted;
// }

// function decrypt(text) {
//   if (!text) return "";
//   let textParts = text.split(':');
//   let iv = Buffer.from(textParts.shift(), 'base64');
//   let encryptedText = textParts.join(':');
//   let decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
//   let decrypted = decipher.update(encryptedText, 'base64', 'utf8');
//   decrypted += decipher.final('utf8');
//   return decrypted;
// }

// module.exports = { encrypt, decrypt };
// utils/encryption.js
// src/utils/encryption.js
// src/utils/encryption.js
// src/utils/encryption.js
const crypto           = require('crypto');
const DecryptionKey    = require('../models/DecryptionKey');
const IV_LENGTH        = 16;

let _cachedAesKey;
async function loadAesKey() {
  if (_cachedAesKey) return _cachedAesKey;
  const doc = await DecryptionKey.findOne({ active: true });
  if (!doc || !doc.aesKey) {
    throw new Error("No active key document with a valid `aesKey`");
  }
  _cachedAesKey = doc.aesKey;
  return _cachedAesKey;
}

async function encrypt(text) {
  if (text == null) return "";
  const aesKey = await loadAesKey();                  // string, 32 chars
  const iv     = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(
    'aes-256-cbc',
    Buffer.from(aesKey, 'utf8'),
    iv
  );
  let encrypted = cipher.update(text.toString(), 'utf8', 'base64');
  encrypted += cipher.final('base64');
  return iv.toString('base64') + ':' + encrypted;
}

async function decrypt(text) {
  if (!text) return "";
  const aesKey = await loadAesKey();
  const parts  = text.split(':');
  const iv     = Buffer.from(parts.shift(), 'base64');
  const encryptedText = parts.join(':');
  const decipher = crypto.createDecipheriv(
    'aes-256-cbc',
    Buffer.from(aesKey, 'utf8'),
    iv
  );
  let decrypted = decipher.update(encryptedText, 'base64', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

module.exports = { encrypt, decrypt };
