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
      try {
        const response = await axios.get(process.env.ZEROBOUNCE_API_URL, {
          params: {
            api_key: process.env.ZEROBOUNCE_API_KEY,
            email: email,
            ip_address: ''
          },
          timeout: 10000, // 10 second timeout
        });

        const result = response.data || {};
        const status = result.status;
        console.log("ZeroBounce Response for", email, ":", status);

        const acceptable = ['valid', 'catch-all', 'unknown'];
        const rejectable = ['invalid', 'spamtrap', 'abuse', 'do_not_mail'];

        if (acceptable.includes(status)) {
          verificationCache.set(email, { isValid: true, timestamp: Date.now() });
          return true;
        }
        if (rejectable.includes(status)) {
          verificationCache.set(email, { isValid: false, timestamp: Date.now() });
          return false;
        }

        // status is undefined/unexpected — this usually means an API key/credit/
        // config problem (ZeroBounce returns an error object, not a verdict).
        // Don't block a possibly-valid email; fall through to the MX check below.
        console.warn(
          `ZeroBounce returned no usable status for ${email} (${JSON.stringify(result.error || status)}); falling back to MX check`
        );
      } catch (zbErr) {
        console.warn(`ZeroBounce check failed for ${email}: ${zbErr.message}; falling back to MX check`);
      }
    }

    // DNS MX check — used when ZeroBounce is not configured OR returned an
    // inconclusive/error response above.
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