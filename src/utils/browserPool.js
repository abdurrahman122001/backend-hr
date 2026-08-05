// backend/src/utils/browserPool.js
//
// One shared headless Chrome for the whole process.
//
// Every PDF route used to call puppeteer.launch() per request (~1-3s of blocked
// event loop + ~200MB RSS each). The bulk-document route was worse: it launched
// one browser, then called generateDocumentPDF() inside its per-employee loop,
// which launched another browser per employee. That is what pushed those
// requests past nginx's proxy_read_timeout (504) and OOM-killed the process.
const puppeteer = require("puppeteer");

const LAUNCH_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage", // /dev/shm is tiny on the VPS; without this Chrome crashes mid-render
  "--disable-gpu",
];

let browserPromise = null;

function isAlive(browser) {
  // puppeteer >= 22 exposes .connected; keep the old call as a fallback
  return typeof browser.connected === "boolean"
    ? browser.connected
    : browser.isConnected();
}

/**
 * Returns the shared browser, launching (or relaunching) it if needed.
 * Callers must close their pages but must NOT close the browser.
 */
async function getBrowser() {
  if (browserPromise) {
    try {
      const existing = await browserPromise;
      if (isAlive(existing)) return existing;
    } catch {
      // previous launch failed — fall through and retry
    }
    browserPromise = null;
  }

  browserPromise = puppeteer
    .launch({ headless: true, args: LAUNCH_ARGS })
    .then((browser) => {
      browser.on("disconnected", () => {
        browserPromise = null;
      });
      return browser;
    })
    .catch((err) => {
      browserPromise = null;
      throw err;
    });

  return browserPromise;
}

/**
 * Runs `fn` with a fresh page and always closes it, so a throw mid-render
 * cannot leak a tab into the long-lived browser.
 */
async function withPage(fn) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    return await fn(page);
  } finally {
    await page.close().catch(() => {});
  }
}

async function closeBrowser() {
  if (!browserPromise) return;
  const pending = browserPromise;
  browserPromise = null;
  try {
    const browser = await pending;
    await browser.close();
  } catch {
    // already gone
  }
}

module.exports = { getBrowser, withPage, closeBrowser };
