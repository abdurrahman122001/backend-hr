const crypto = require("crypto");
const DecryptionKey = require("../models/DecryptionKey");
const IV_LENGTH = 16;

let _cachedAesKey;

async function loadAesKey() {
  if (_cachedAesKey) return _cachedAesKey;

  const doc = await DecryptionKey.findOne({ active: true });
  if (!doc || !doc.currentAesKey) {
    throw new Error("No active key document with a valid `currentAesKey`");
  }

  _cachedAesKey = doc.currentAesKey;
  return _cachedAesKey;
}

function clearCache() {
  _cachedAesKey = null;
}

async function encrypt(text, key = null) {
  if (text == null) return "";
  const aesKey = key || (await loadAesKey());
  if (!aesKey || aesKey.length !== 32) {
    throw new Error(`Invalid AES key length: ${aesKey.length}`);
  }
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(
    "aes-256-cbc",
    Buffer.from(aesKey, "utf8"),
    iv
  );
  let encrypted = cipher.update(text.toString(), "utf8", "base64");
  encrypted += cipher.final("base64");
  return iv.toString("base64") + ":" + encrypted;
}

async function decrypt(text, key = null) {
  if (!text) return "";
  try {
    const aesKey = key || (await loadAesKey());
    if (!aesKey || aesKey.length !== 32) {
      throw new Error(`Invalid AES key length: ${aesKey.length}`);
    }
    const parts = text.split(":");
    if (parts.length < 2) throw new Error("Invalid encrypted format");
    const iv = Buffer.from(parts.shift(), "base64");
    const encryptedText = parts.join(":");
    const decipher = crypto.createDecipheriv(
      "aes-256-cbc",
      Buffer.from(aesKey, "utf8"),
      iv
    );
    let decrypted = decipher.update(encryptedText, "base64", "utf8");
    decrypted += decipher.final("utf8");
    return decrypted;
  } catch (error) {
    console.error("Decryption error:", error.message);
    return "[Decryption Error]";
  }
}

module.exports = { encrypt, decrypt, clearCache };