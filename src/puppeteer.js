// ✅ Puppeteer safe launch helper (for Hostinger VPS)
const puppeteer = require("puppeteer");

async function launchPuppeteer() {
  return await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
    executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium-browser",
  });
}

module.exports.launchPuppeteer = launchPuppeteer;
