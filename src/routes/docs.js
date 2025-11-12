// routes/docs.js
const express = require("express");
const router = express.Router();
const puppeteer = require("puppeteer-core");
const { PDFDocument } = require("pdf-lib");

const Employee = require("../models/Employees");
const Salary = require("../models/Salaries");
const DocTemplate = require("../models/DocTemplate");
const { decrypt } = require("../utils/encryption");

/* ───────────────── helpers ───────────────── */

const TYPE_ALIASES = {
  "experience-letter": "experience_letter",
  "salary-certificate": "salary_certificate",
  nda: "nda",
  contract: "contract",
};
const normType = (t = "") => TYPE_ALIASES[t] || t.replace(/-/g, "_");
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const pxToMm = (px) => (Number(px || 0) * 25.4) / 96;

async function launchBrowser() {
  const fs = require("fs");
  const isProduction = process.env.NODE_ENV === "production";

  const possibleChromiumPaths = [
    "/snap/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
    "/usr/bin/google-chrome-stable",
    process.env.CHROME_PATH,
    !isProduction ? require("puppeteer").executablePath() : null,
  ].filter(Boolean);

  let executablePath;
  for (const path of possibleChromiumPaths) {
    try {
      if (fs.existsSync(path)) {
        executablePath = path;
        console.log("✅ Found Chromium at:", path);
        break;
      }
    } catch {
      continue;
    }
  }

  if (!executablePath) {
    throw new Error("❌ Chromium not found. Please verify your installation.");
  }

  const launchOptions = {
    executablePath,
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--single-process",
      "--no-zygote",
      "--disable-web-security",
      "--disable-software-rasterizer",
      "--font-render-hinting=none",
      "--force-color-profile=srgb",
      "--window-size=1280,1024",
    ],
    timeout: 30000,
  };

  try {
    const browser = await puppeteer.launch(launchOptions);
    return browser;
  } catch (error) {
    console.error("⚠️ Browser launch failed:", error);
    return await puppeteer.launch({
      executablePath,
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
      timeout: 30000,
    });
  }
}

function fmtDate(d) {
  if (!d) return "—";
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return "—";

  try {
    return dt.toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  } catch {
    const months = [
      "January", "February", "March", "April", "May", "June", "July",
      "August", "September", "October", "November", "December"
    ];
    return `${months[dt.getMonth()]} ${dt.getDate()}, ${dt.getFullYear()}`;
  }
}

function diffToYearsMonths(start, end) {
  if (!start || !end) return { years: 0, months: 0, totalMonths: 0 };
  const s = new Date(start);
  const e = new Date(end);
  if (isNaN(s.getTime()) || isNaN(e.getTime())) {
    return { years: 0, months: 0, totalMonths: 0 };
  }

  let totalMonths = (e.getFullYear() - s.getFullYear()) * 12 + (e.getMonth() - s.getMonth());
  if (e.getDate() < s.getDate()) totalMonths -= 1;
  if (totalMonths < 0) totalMonths = 0;

  const years = Math.floor(totalMonths / 12);
  const months = totalMonths % 12;
  return { years, months, totalMonths };
}

function formatTenure(start, end) {
  const { years, months, totalMonths } = diffToYearsMonths(start, end);
  if (totalMonths <= 0) return "less than 1 month";
  const parts = [];
  if (years > 0) parts.push(`${years} year${years === 1 ? "" : "s"}`);
  if (months > 0) parts.push(`${months} month${months === 1 ? "" : "s"}`);
  return parts.join(" ");
}

async function fetchAndDecryptSalary(employeeId) {
  if (!employeeId) return {};

  try {
    const salaryRecord = await Salary.findOne({
      employee: employeeId,
      isActive: true,
    }).lean();

    if (!salaryRecord) {
      console.log("No active salary record found for employee:", employeeId);
      return {};
    }

    const decryptedSalary = {};
    const salaryFields = [
      "basic", "dearnessAllowance", "houseRentAllowance", "conveyanceAllowance",
      "medicalAllowance", "utilityAllowance", "overtimeCompensation", "dislocationAllowance",
      "leaveEncashment", "bonus", "arrears", "autoAllowance", "incentive", "fuelAllowance",
      "othersAllowances", "grossSalary"
    ];

    for (const field of salaryFields) {
      if (salaryRecord[field]) {
        try {
          decryptedSalary[field] = await decrypt(salaryRecord[field]);
        } catch (error) {
          console.error(`Error decrypting ${field}:`, error.message);
          decryptedSalary[field] = "[Decryption Error]";
        }
      } else {
        decryptedSalary[field] = "—";
      }
    }

    if (decryptedSalary.basic && decryptedSalary.basic !== "—") {
      try {
        const basic = parseFloat(decryptedSalary.basic) || 0;
        const houseRent = parseFloat(decryptedSalary.houseRentAllowance) || 0;
        const utilities = parseFloat(decryptedSalary.utilityAllowance) || 0;
        const conveyance = parseFloat(decryptedSalary.conveyanceAllowance) || 0;
        const medical = parseFloat(decryptedSalary.medicalAllowance) || 0;
        const others = parseFloat(decryptedSalary.othersAllowances) || 0;

        decryptedSalary.calculatedTotal = (
          basic + houseRent + utilities + conveyance + medical + others
        ).toFixed(2);
      } catch (error) {
        console.error("Error calculating total salary:", error.message);
        decryptedSalary.calculatedTotal = "[Calculation Error]";
      }
    }

    return decryptedSalary;
  } catch (error) {
    console.error("Error fetching salary record:", error.message);
    return {};
  }
}

const formatWithCommas = (val) => {
  const numVal = parseFloat(val);
  if (isNaN(numVal)) return val || "—";
  return numVal.toLocaleString("en-PK");
};

async function tokenMap(emp, defaults = {}) {
  const decryptedSalary = await fetchAndDecryptSalary(emp?._id);
  const join = emp?.joiningDate;
  const endDate = emp?.leavingDate || new Date();

  const tenureHuman = formatTenure(join, endDate);
  const { totalMonths: tenureMonthsTotal } = diffToYearsMonths(join, endDate);

  return {
    "company.name": defaults.companyName || "Mavens Advisor Pvt. Ltd.",
    "company.address": defaults.companyAddress || "",
    "contact.phone": defaults.contactPhone || "+1 (615) 988-0800",
    "sign.name": defaults.signName || "ADEEL SHAIKH",
    "sign.title": defaults.signTitle || "CHIEF EXECUTIVE OFFICER",
    "doc.qualitiesLine": defaults.qualitiesLine || "…hardworking, punctual, precise, and honest.",
    "dates.issue": fmtDate(new Date()),
    "dates.join": fmtDate(emp?.joiningDate),
    "dates.end": emp?.leavingDate ? fmtDate(emp.leavingDate) : "present",
    "tenure.human": tenureHuman,
    "tenure.monthsTotal": tenureMonthsTotal,

    "employee.name": emp?.name || "—",
    "employee.cnic": emp?.cnic || "—",
    "employee.nationality": emp?.nationality || "—",
    "employee.designation": emp?.designation || emp?.position || "—",
    "employee.department": emp?.department || "—",
    "employee.position": emp?.position || emp?.designation || "—",
    "employee.email": emp?.email || "—",
    "employee.phone": emp?.phone || "—",
    "employee.address": emp?.presentAddress || emp?.permanentAddress || "—",

    // Salary fields
    "salary.basic": formatWithCommas(decryptedSalary.basic),
    "salary.dearness": formatWithCommas(decryptedSalary.dearnessAllowance),
    "salary.houseRent": formatWithCommas(decryptedSalary.houseRentAllowance),
    "salary.conveyance": formatWithCommas(decryptedSalary.conveyanceAllowance),
    "salary.medical": formatWithCommas(decryptedSalary.medicalAllowance),
    "salary.utilities": formatWithCommas(decryptedSalary.utilityAllowance),
    "salary.overtime": formatWithCommas(decryptedSalary.overtimeCompensation),
    "salary.dislocation": formatWithCommas(decryptedSalary.dislocationAllowance),
    "salary.leaveEncashment": formatWithCommas(decryptedSalary.leaveEncashment),
    "salary.bonus": formatWithCommas(decryptedSalary.bonus),
    "salary.arrears": formatWithCommas(decryptedSalary.arrears),
    "salary.auto": formatWithCommas(decryptedSalary.autoAllowance),
    "salary.incentive": formatWithCommas(decryptedSalary.incentive),
    "salary.fuel": formatWithCommas(decryptedSalary.fuelAllowance),
    "salary.other": formatWithCommas(decryptedSalary.othersAllowances),
    "salary.gross": formatWithCommas(decryptedSalary.grossSalary || decryptedSalary.calculatedTotal),
    "salary.total": formatWithCommas(decryptedSalary.grossSalary || decryptedSalary.calculatedTotal),
    "employee.pronounSubject": "he",
    "employee.pronounObject": "him",
    "employee.pronounPossessive": "his",
    "roles.timeline": "",
  };
}

function applyTokens(html, tokens) {
  return String(html).replace(
    /\{\{\s*([a-zA-Z0-9_.]+)(?:\s*\|\s*([a-zA-Z]+))?\s*\}\}/g,
    (_, key, filter) => {
      let v = tokens[key] ?? "";
      switch ((filter || "").toLowerCase()) {
        case "upper": v = String(v).toUpperCase(); break;
        case "lower": v = String(v).toLowerCase(); break;
        case "title": v = String(v).toLowerCase().replace(/\b\w/g, m => m.toUpperCase()); break;
        case "trim": v = String(v).trim(); break;
      }
      return v;
    }
  );
}

const escCss = (s) => String(s ?? "").replace(/"/g, '\\"');

function extractAllPages(canvas = {}) {
  const pages = [];
  if (Array.isArray(canvas.pages) && canvas.pages.length > 0) {
    canvas.pages.forEach((p, index) => {
      const widthPx = num(p?.pageFormat?.width, 794);
      const heightPx = num(p?.pageFormat?.height, 1123);
      const header = num(p?.headerHeight ?? 0, 0);
      const footer = num(p?.footerHeight ?? 0, 0);
      const elements = Array.isArray(p?.elements) ? p.elements : [];

      pages.push({
        widthPx,
        heightPx,
        header,
        footer,
        elements,
        name: canvas?.name || `Document Page ${index + 1}`,
        pageNumber: index + 1,
        totalPages: canvas.pages.length,
      });
    });
    return pages;
  }

  const widthPx = num(canvas?.pageFormat?.width, 794);
  const heightPx = num(canvas?.pageFormat?.height, 1123);
  const header = num(canvas?.headerHeight, 0);
  const footer = num(canvas?.footerHeight, 0);
  const elements = Array.isArray(canvas?.elements) ? canvas.elements : [];

  pages.push({
    widthPx,
    heightPx,
    header,
    footer,
    elements,
    name: canvas?.name || "Document",
    pageNumber: 1,
    totalPages: 1,
  });

  return pages;
}

function generateSinglePageHTML(page, tokens, totalPages) {
  const elsHTML = page.elements
    .map((el) => {
      const x = num(el.x, 0);
      const y = num(el.y, 0);
      const w = num(el.width, 600);
      const h = num(el.height, 40);
      const fs = num(el.fontSize, 14);
      const ff = "Calibri"; // Force Calibri for all elements
      const bold = el.bold ? "600" : "400";
      const italic = el.italic ? "italic" : "normal";
      const deco = el.underline ? "underline" : "none";
      const color = el.color || "#000000";
      const align = el.align || "left";
      const lineHeight = num(el.lineHeight, 1.2);
      const columns = num(el.columns, 1);
      const columnGap = num(el.columnGap, 20);
      const html = applyTokens(el.content || "", tokens);

      const columnStyle = columns > 1 
        ? `column-count: ${columns}; column-gap: ${columnGap}px; -webkit-column-count: ${columns}; -moz-column-count: ${columns}; -webkit-column-gap: ${columnGap}px; -moz-column-gap: ${columnGap}px;`
        : '';

      const alignStyle = align === "justify" 
        ? "text-align: justify; text-justify: inter-word; -webkit-text-align: justify; -moz-text-align: justify;" 
        : `text-align: ${align};`;

      return `<div class="el" style="
        position: absolute !important;
        left: ${x}px !important;
        top: ${y}px !important;
        width: ${w}px !important;
        height: ${h}px !important;
        color: ${color} !important;
        font-family: 'Calibri', 'Liberation Sans', 'Arial', sans-serif !important;
        font-size: ${fs}px !important;
        font-weight: ${bold} !important;
        font-style: ${italic} !important;
        text-decoration: ${deco} !important;
        ${alignStyle}
        line-height: ${lineHeight} !important;
        ${columnStyle}
        overflow: hidden !important;
        margin: 0 !important;
        padding: 0 !important;
        box-sizing: border-box !important;
        -webkit-print-color-adjust: exact !important;
        print-color-adjust: exact !important;">
        ${html}
      </div>`;
    })
    .join("");

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>${page.name}</title>
<style>
  @page {
    margin: 0 !important;
    size: ${pxToMm(page.widthPx)}mm ${pxToMm(page.heightPx)}mm;
  }
  
  * {
    -webkit-print-color-adjust: exact !important;
    print-color-adjust: exact !important;
    box-sizing: border-box !important;
    margin: 0 !important;
    padding: 0 !important;
  }
  
  html, body {
    margin: 0 !important;
    padding: 0 !important;
    width: ${page.widthPx}px !important;
    height: ${page.heightPx}px !important;
    -webkit-print-color-adjust: exact !important;
    print-color-adjust: exact !important;
    font-family: 'Calibri', 'Liberation Sans', 'Arial', sans-serif !important;
    background: #ffffff !important;
    overflow: hidden !important;
  }

  .page {
    width: ${page.widthPx}px !important;
    height: ${page.heightPx - (page.header + page.footer)}px !important;
    position: relative !important;
    background: #fff !important;
    color: #000 !important;
    font-family: 'Calibri', 'Liberation Sans', 'Arial', sans-serif !important;
    overflow: hidden !important;
    box-sizing: border-box !important;
    transform: translateY(${page.header}px) !important;
    margin: 0 !important;
    padding: 0 !important;
  }

  .el * {
    margin: 0 !important;
    padding: 0 !important;
    box-sizing: border-box !important;
    font-family: inherit !important;
  }

  /* Force text rendering */
  .el {
    -webkit-font-smoothing: antialiased !important;
    -moz-osx-font-smoothing: grayscale !important;
    text-rendering: optimizeLegibility !important;
  }

  /* Ensure all text elements use Calibri */
  p, div, span, h1, h2, h3, h4, h5, h6 {
    font-family: 'Calibri', 'Liberation Sans', 'Arial', sans-serif !important;
  }
</style>
</head>
<body>
  <div class="page">
    ${elsHTML}
  </div>
</body>
</html>`;
}

async function generateDocumentPDF(employeeId, docType, templateId = "") {
  const emp = await Employee.findById(employeeId).lean();
  if (!emp) throw new Error("Employee not found");

  const tpl = templateId
    ? await DocTemplate.findById(templateId).lean()
    : await DocTemplate.findOne({ type: normType(docType) }).lean();
  if (!tpl) throw new Error("Template not found");

  const defaults = tpl.defaultValues || {};
  const tokens = await tokenMap(emp, defaults);
  const pages = extractAllPages(tpl.canvas || {});
  if (pages.length === 0) throw new Error("No pages found in template");

  let browser;
  try {
    browser = await launchBrowser();
    const mergedPdf = await PDFDocument.create();

    for (const page of pages) {
      let pageInstance;
      try {
        pageInstance = await browser.newPage();

        // Set viewport to match template size exactly
        await pageInstance.setViewport({
          width: Math.round(page.widthPx),
          height: Math.round(page.heightPx),
          deviceScaleFactor: 1,
        });

        // Generate HTML with Calibri font
        const html = generateSinglePageHTML(page, tokens, pages.length);

        // Pre-inject Calibri CSS
        await pageInstance.addStyleTag({
          content: `
            @import url('https://fonts.googleapis.com/css2?family=Calibri:wght@400;600;700&display=swap');
            * {
              font-family: 'Calibri', 'Liberation Sans', 'Arial', sans-serif !important;
              -webkit-print-color-adjust: exact !important;
              print-color-adjust: exact !important;
            }
          `
        });

        // Load HTML content
        await pageInstance.setContent(html, {
          waitUntil: 'networkidle0',
          timeout: 30000,
        });

        await pageInstance.emulateMediaType('screen');

        // Force style application
        await pageInstance.evaluate(() => {
          document.body.style.zoom = "1.0";
          document.body.style.webkitPrintColorAdjust = "exact";
          document.body.style.printColorAdjust = "exact";
          document.body.style.background = "#fff";
          document.body.style.overflow = "hidden";
          window.scrollTo(0, 0);
          
          // Force font loading
          if (document.fonts && document.fonts.ready) {
            document.fonts.ready.then(() => {
              console.log('Fonts loaded successfully');
            });
          }
        });

        // Wait for fonts and styles to apply
        await pageInstance.waitForTimeout(1000);

        // Convert pixel page size to millimeters
        const widthMm = pxToMm(page.widthPx);
        const heightMm = pxToMm(page.heightPx);
        const headerMm = pxToMm(page.header);
        const footerMm = pxToMm(page.footer);

        // Generate PDF for this page
        const pdfBuffer = await pageInstance.pdf({
          printBackground: true,
          preferCSSPageSize: true,
          width: `${widthMm}mm`,
          height: `${heightMm}mm`,
          margin: {
            top: `${headerMm}mm`,
            bottom: `${footerMm}mm`,
            left: "0mm",
            right: "0mm",
          },
          scale: 1,
        });

        // Merge into main document
        const tempPdf = await PDFDocument.load(pdfBuffer);
        const [copiedPage] = await mergedPdf.copyPages(tempPdf, [0]);
        mergedPdf.addPage(copiedPage);
      } finally {
        if (pageInstance) await pageInstance.close().catch(console.error);
      }
    }

    const mergedPdfBytes = await mergedPdf.save();
    return Buffer.from(mergedPdfBytes);
  } catch (error) {
    console.error("PDF generation error:", error);
    throw new Error(`PDF generation failed: ${error.message}`);
  } finally {
    if (browser) await browser.close().catch(console.error);
  }
}

/* ──────────────────────────────────────────────────────────────────────────────
   PDF ENDPOINTS FOR ALL DOCUMENT TYPES
────────────────────────────────────────────────────────────────────────────── */

// Experience Letter
router.get("/experience-letter/:employeeId", async (req, res) => {
  try {
    const { employeeId } = req.params;
    const templateId = String(req.query.templateId || "");

    const pdf = await generateDocumentPDF(employeeId, "experience_letter", templateId);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'attachment; filename="ExperienceLetter.pdf"');
    res.status(200).end(pdf);
  } catch (err) {
    console.error("experience-letter pdf error:", err);
    if (!res.headersSent) {
      res.status(500).json({ message: err.message || "Failed to generate PDF" });
    }
  }
});

// NDA
router.get("/nda/:employeeId", async (req, res) => {
  try {
    const { employeeId } = req.params;
    const templateId = String(req.query.templateId || "");

    const pdf = await generateDocumentPDF(employeeId, "nda", templateId);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'attachment; filename="NDA.pdf"');
    res.status(200).end(pdf);
  } catch (err) {
    console.error("nda pdf error:", err);
    if (!res.headersSent) {
      res.status(500).json({ message: err.message || "Failed to generate PDF" });
    }
  }
});

// Salary Certificate
router.get("/salary-certificate/:employeeId", async (req, res) => {
  try {
    const { employeeId } = req.params;
    const templateId = String(req.query.templateId || "");

    const pdf = await generateDocumentPDF(employeeId, "salary_certificate", templateId);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'attachment; filename="SalaryCertificate.pdf"');
    res.status(200).end(pdf);
  } catch (err) {
    console.error("salary-certificate pdf error:", err);
    if (!res.headersSent) {
      res.status(500).json({ message: err.message || "Failed to generate PDF" });
    }
  }
});

// Contract
router.get("/contract/:employeeId", async (req, res) => {
  try {
    const { employeeId } = req.params;
    const templateId = String(req.query.templateId || "");

    const pdf = await generateDocumentPDF(employeeId, "contract", templateId);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'attachment; filename="Contract.pdf"');
    res.status(200).end(pdf);
  } catch (err) {
    console.error("contract pdf error:", err);
    if (!res.headersSent) {
      res.status(500).json({ message: err.message || "Failed to generate PDF" });
    }
  }
});

router.post("/contract/:employeeId", async (req, res) => {
  try {
    const { employeeId } = req.params;
    const templateId = String(req.query.templateId || "");

    const pdf = await generateDocumentPDF(employeeId, "contract", templateId);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'attachment; filename="Contract.pdf"');
    res.status(200).end(pdf);
  } catch (err) {
    console.error("contract pdf error:", err);
    if (!res.headersSent) {
      res.status(500).json({ message: err.message || "Failed to generate PDF" });
    }
  }
});

/* ─────────────────────────────────────────────────────────────
   TEMPLATE ROUTES
──────────────────────────────────────────────────────────────── */
router.get("/doc-templates/:type", async (req, res) => {
  try {
    const type = normType(req.params.type);
    const tpl = await DocTemplate.findOne({ type }).lean();
    if (!tpl) return res.status(200).json({ data: null });
    res.json({ data: { canvas: tpl.canvas, defaultValues: tpl.defaultValues || {} } });
  } catch {
    res.status(500).json({ message: "Failed to load by type" });
  }
});

router.post("/doc-templates/:type", async (req, res) => {
  try {
    const type = normType(req.params.type);
    const { canvas, defaultValues } = req.body || {};
    if (!canvas) return res.status(400).json({ message: "canvas is required" });
    const up = await DocTemplate.findOneAndUpdate(
      { type },
      { $set: { canvas, defaultValues: defaultValues || {} } },
      { upsert: true, new: true }
    ).lean();
    res.json({ ok: true, data: { canvas: up.canvas, defaultValues: up.defaultValues || {} } });
  } catch {
    res.status(500).json({ message: "Failed to save by type" });
  }
});

router.get("/templates", async (req, res) => {
  try {
    const rows = await DocTemplate.find({}, { canvas: 1, type: 1, updatedAt: 1 })
      .sort({ updatedAt: -1 }).lean();
    const data = rows.map((r) => ({
      _id: String(r._id),
      type: r.type,
      name: r.canvas?.name || "Untitled Document",
      updatedAt: r.updatedAt,
    }));
    res.json({ data });
  } catch {
    res.status(500).json({ message: "Failed to fetch templates" });
  }
});

router.get("/templates/:id", async (req, res) => {
  try {
    const tpl = await DocTemplate.findById(req.params.id).lean();
    if (!tpl) return res.status(404).json({ message: "Template not found" });
    res.json({ data: { _id: String(tpl._id), type: tpl.type, canvas: tpl.canvas, defaultValues: tpl.defaultValues || {}, updatedAt: tpl.updatedAt } });
  } catch {
    res.status(500).json({ message: "Failed to load template" });
  }
});

router.post("/templates", async (req, res) => {
  try {
    const { type, canvas, defaultValues } = req.body || {};
    if (!type || !canvas) return res.status(400).json({ message: "`type` and `canvas` are required" });
    const doc = await DocTemplate.create({ type, canvas, defaultValues: defaultValues || {} });
    res.status(201).json({ ok: true, id: String(doc._id) });
  } catch {
    res.status(500).json({ message: "Failed to create template" });
  }
});

router.put("/templates/:id", async (req, res) => {
  try {
    const { canvas, defaultValues, type } = req.body || {};
    const set = {};
    if (type) set.type = type;
    if (canvas) set.canvas = canvas;
    if (defaultValues) set.defaultValues = defaultValues;
    const up = await DocTemplate.findByIdAndUpdate(req.params.id, { $set: set }, { new: true }).lean();
    if (!up) return res.status(404).json({ message: "Template not found" });
    res.json({ ok: true });
  } catch {
    res.status(500).json({ message: "Failed to update template" });
  }
});

router.delete("/templates/:id", async (req, res) => {
  try {
    const del = await DocTemplate.findByIdAndDelete(req.params.id).lean();
    if (!del) return res.status(404).json({ message: "Template not found" });
    res.json({ ok: true });
  } catch {
    res.status(500).json({ message: "Failed to delete template" });
  }
});

module.exports = router;