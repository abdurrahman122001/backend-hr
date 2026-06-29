const axios = require("axios");

// Localhost / private-range IPs can't be geolocated.
function isLocalOrPrivate(ip) {
  if (!ip) return true;
  const v = String(ip).replace("::ffff:", "").split(",")[0].trim();
  return (
    v === "::1" ||
    v === "127.0.0.1" ||
    v === "localhost" ||
    v === "unknown" ||
    v === "" ||
    v.startsWith("10.") ||
    v.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(v)
  );
}

/**
 * Best-effort IP geolocation. Returns { city, country, location } or null.
 * Uses the free ip-api.com endpoint (HTTP only on the free tier, ~45 req/min).
 * Never throws — geo is non-critical, so failures resolve to null.
 */
async function getGeoFromIp(ip) {
  try {
    // For local/private IPs (e.g. localhost dev), query ip-api with NO IP — it
    // then returns the geo of the server's own public IP, so a location still
    // shows during development. In production the real client IP is used.
    const clean = isLocalOrPrivate(ip)
      ? ""
      : String(ip).replace("::ffff:", "").split(",")[0].trim();
    const { data } = await axios.get(
      `http://ip-api.com/json/${encodeURIComponent(
        clean
      )}?fields=status,country,city,regionName`,
      { timeout: 4000 }
    );
    if (data && data.status === "success") {
      const city = data.city || data.regionName || "";
      const country = data.country || "";
      const location = [city, country].filter(Boolean).join(", ");
      return { city, country, location: location || country || null };
    }
  } catch (e) {
    // best-effort — ignore geo failures
  }
  return null;
}

module.exports = { getGeoFromIp, isLocalOrPrivate };
