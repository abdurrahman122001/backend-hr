const axios = require("axios");

// Cache for verified emails
const verificationCache = new Map();
const CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours

// Clean up cache periodically
setInterval(() => {
  const now = Date.now();
  for (const [email, data] of verificationCache.entries()) {
    if (now - data.timestamp > CACHE_DURATION) {
      verificationCache.delete(email);
    }
  }
}, 60 * 60 * 1000); // Every hour

async function verifyEmail(email) {
  try {
    // Check cache first
    const cached = verificationCache.get(email);
    if (cached && (Date.now() - cached.timestamp < CACHE_DURATION)) {
      return cached.isValid;
    }

    // Basic email format validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      verificationCache.set(email, { isValid: false, timestamp: Date.now() });
      return false;
    }

    // Skip disposable email domains
    const disposableDomains = [
      'mailinator.com', 'guerrillamail.com', 'tempmail.com',
      '10minutemail.com', 'throwawaymail.com', 'yopmail.com',
      'temp-mail.org', 'sharklasers.com', 'getairmail.com'
    ];

    const domain = email.split('@')[1].toLowerCase();
    if (disposableDomains.includes(domain)) {
      console.warn(`⚠️ Disposable email detected: ${email}`);
      verificationCache.set(email, { isValid: false, timestamp: Date.now() });
      return false;
    }

    // If ZeroBounce is configured, use it
    if (process.env.ZEROBOUNCE_API_KEY && process.env.ZEROBOUNCE_API_URL) {
      const response = await axios.get(process.env.ZEROBOUNCE_API_URL, {
        params: {
          api_key: process.env.ZEROBOUNCE_API_KEY,
          email: email,
          ip_address: ''
        },
        timeout: 10000, // 10 second timeout
      });

      const result = response.data;
      console.log("ZeroBounce Response for", email, ":", result.status);

      // Consider 'valid', 'catch-all', and 'unknown' as acceptable
      const isValid = ['valid', 'catch-all', 'unknown'].includes(result.status);

      verificationCache.set(email, { isValid, timestamp: Date.now() });
      return isValid;
    }

    // If no ZeroBounce, do DNS MX check
    try {
      const dns = require('dns').promises;
      await dns.resolveMx(domain);
      verificationCache.set(email, { isValid: true, timestamp: Date.now() });
      return true;
    } catch (dnsError) {
      console.warn(`No MX records found for ${domain}`);
      verificationCache.set(email, { isValid: false, timestamp: Date.now() });
      return false;
    }

  } catch (err) {
    console.error("Email verification error for", email, ":", err.message);

    // Fail-safe: allow email when verification fails
    // This prevents blocking legitimate emails due to API issues
    verificationCache.set(email, { isValid: true, timestamp: Date.now() });
    return true;
  }
}

module.exports = verifyEmail;