import CryptoJS from "crypto-js";

// Helper: base64 decode (nodejs Buffer atob)
function b64decode(str) {
  // atob polyfill for node/browser
  if (typeof window !== "undefined" && window.atob) {
    const binary = window.atob(str);
    return Uint8Array.from([...binary].map(c => c.charCodeAt(0)));
  }
  // Node.js fallback
  return Uint8Array.from(Buffer.from(str, "base64"));
}

export function decryptSalary(encrypted, key) {
  if (!encrypted || !key) return "";

  try {
    // Encrypted string is "IV:CipherText"
    const [ivB64, cipherTextB64] = encrypted.split(":");
    const iv = CryptoJS.enc.Base64.parse(ivB64);
    const cipherText = CryptoJS.enc.Base64.parse(cipherTextB64);

    const bytes = CryptoJS.AES.decrypt(
      { ciphertext: cipherText },
      CryptoJS.enc.Utf8.parse(key),
      { iv }
    );
    const decrypted = bytes.toString(CryptoJS.enc.Utf8);
    return decrypted;
  } catch {
    return "[Decryption Error]";
  }
}
