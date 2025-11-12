// ✅ Puppeteer Safe Launch Helper (for Hostinger Ubuntu 24 VPS)
const puppeteer = require("puppeteer");
const fs = require("fs");

async function launchPuppeteer() {
  // Try multiple possible chromium locations
  const possiblePaths = [
    process.env.CHROMIUM_PATH,           // From .env if provided
    "/snap/bin/chromium",                // Snap install (most common on Ubuntu 24)
    "/usr/bin/chromium-browser",         // Legacy path
    "/usr/bin/chromium",                 // Alternate Debian path
    "/usr/lib/chromium/chrome",          // Fallback for custom installs
  ].filter(Boolean);

  let executablePath = null;

  // Pick the first existing path
  for (const path of possiblePaths) {
    if (fs.existsSync(path)) {
      executablePath = path;
      break;
    }
  }

  if (!executablePath) {
    console.warn(
      "⚠️ Chromium not found — please install it using:\n" +
      "sudo snap install chromium\n" +
      "and then set CHROMIUM_PATH=/snap/bin/chromium in your .env file"
    );
    throw new Error("Chromium executable not found");
  }

  console.log(`✅ Launching Puppeteer with Chromium at: ${executablePath}`);

  // Launch Puppeteer safely
  return await puppeteer.launch({
    headless: true,
    executablePath,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ],
  });
}

module.exports = { launchPuppeteer };
