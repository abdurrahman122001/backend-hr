const crypto = require('crypto');

// Use EXACTLY 32 characters for AES-256
const ENCRYPTION_KEY = (process.env.ENCRYPTION_KEY || "mySecretKey12345678901234567890!").padEnd(32, '!').slice(0, 32);
const IV_LENGTH = 16;

function encrypt(text) {
  if (!text) return "";
  let iv = crypto.randomBytes(IV_LENGTH);
  let cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
  let encrypted = cipher.update(text.toString(), 'utf8', 'base64');
  encrypted += cipher.final('base64');
  return iv.toString('base64') + ':' + encrypted;
}

function decrypt(text) {
  if (!text) return "";
  let textParts = text.split(':');
  let iv = Buffer.from(textParts.shift(), 'base64');
  let encryptedText = textParts.join(':');
  let decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
  let decrypted = decipher.update(encryptedText, 'base64', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

module.exports = { encrypt, decrypt };
