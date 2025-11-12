// routes/docs.js
const express = require("express");
const router = express.Router();
const puppeteer = require("puppeteer");
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
const pxToMm = (px) => (Number(px || 0) * 25.4) / 96; // 96dpi

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
      "January",
      "February",
      "March",
      "April",
      "May",
      "June",
      "July",
      "August",
      "September",
      "October",
      "November",
      "December",
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

  let totalMonths =
    (e.getFullYear() - s.getFullYear()) * 12 + (e.getMonth() - s.getMonth());

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
      "basic",
      "dearnessAllowance",
      "houseRentAllowance",
      "conveyanceAllowance",
      "medicalAllowance",
      "utilityAllowance",
      "overtimeCompensation",
      "dislocationAllowance",
      "leaveEncashment",
      "bonus",
      "arrears",
      "autoAllowance",
      "incentive",
      "fuelAllowance",
      "othersAllowances",
      "grossSalary",
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
          basic +
          houseRent +
          utilities +
          conveyance +
          medical +
          others
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
    "doc.qualitiesLine":
      defaults.qualitiesLine || "…hardworking, punctual, precise, and honest.",
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

    "salary.basic": formatWithCommas(decryptedSalary.basic),
    "salary.dearness": formatWithCommas(decryptedSalary.dearnessAllowance),
    "salary.houseRent": formatWithCommas(decryptedSalary.houseRentAllowance),
    "salary.conveyance": formatWithCommas(decryptedSalary.conveyanceAllowance),
    "salary.medical": formatWithCommas(decryptedSalary.medicalAllowance),
    "salary.utilities": formatWithCommas(decryptedSalary.utilityAllowance),
    "salary.overtime": formatWithCommas(decryptedSalary.overtimeCompensation),
    "salary.dislocation": formatWithCommas(
      decryptedSalary.dislocationAllowance
    ),
    "salary.leaveEncashment": formatWithCommas(decryptedSalary.leaveEncashment),
    "salary.bonus": formatWithCommas(decryptedSalary.bonus),
    "salary.arrears": formatWithCommas(decryptedSalary.arrears),
    "salary.auto": formatWithCommas(decryptedSalary.autoAllowance),
    "salary.incentive": formatWithCommas(decryptedSalary.incentive),
    "salary.fuel": formatWithCommas(decryptedSalary.fuelAllowance),
    "salary.other": formatWithCommas(decryptedSalary.othersAllowances),
    "salary.gross": formatWithCommas(
      decryptedSalary.grossSalary || decryptedSalary.calculatedTotal
    ),
    "salary.total": formatWithCommas(
      decryptedSalary.grossSalary || decryptedSalary.calculatedTotal
    ),
    "employee.pronounSubject": "he",
    "employee.pronounObject": "him",
    "employee.pronounPossessive": "his",
    "roles.timeline": "",
  };
}

function applyTokens(text, tokens) {
  if (!text || typeof text !== 'string') return '';
  
  return text.replace(
    /\{\{\s*([a-zA-Z0-9_.]+)(?:\s*\|\s*([a-zA-Z]+))?\s*\}\}/g,
    (_, key, filter) => {
      let v = tokens[key] ?? "";
      switch ((filter || "").toLowerCase()) {
        case "upper":
          v = String(v).toUpperCase();
          break;
        case "lower":
          v = String(v).toLowerCase();
          break;
        case "title":
          v = String(v)
            .toLowerCase()
            .replace(/\b\w/g, (m) => m.toUpperCase());
          break;
        case "trim":
          v = String(v).trim();
          break;
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
// FIXED: Production-ready HTML generation with Calibri as default
function generateSinglePageHTML(page, tokens, totalPages) {
  const elsHTML = page.elements
    .map((el) => {
      const x = num(el.x, 0);
      const y = num(el.y, 0);
      const w = num(el.width, 600);
      const h = num(el.height, 40);
      const fs = num(el.fontSize, 14);
      // Use Calibri as default with proper fallbacks
      const ff = el.fontFamily ? `'${escCss(el.fontFamily)}', Calibri, 'Liberation Sans', sans-serif` : "Calibri, 'Liberation Sans', Arial, sans-serif";
      const bold = el.bold ? "bold" : "normal";
      const italic = el.italic ? "italic" : "normal";
      const deco = el.underline ? "underline" : "none";
      const color = el.color || "#000000";
      const align = el.align || "left";
      const lineHeight = num(el.lineHeight, 1.2);
      
      const content = applyTokens(el.content || "", tokens);

      // Handle text alignment properly
      const alignStyle = align === "justify" 
        ? "text-align: justify; text-justify: inter-word;" 
        : `text-align: ${align};`;

      return `<div class="element" style="
        position: absolute;
        left: ${x}px;
        top: ${y}px;
        width: ${w}px;
        height: ${h}px;
        color: ${color};
        font-family: ${ff};
        font-size: ${fs}px;
        font-weight: ${bold};
        font-style: ${italic};
        text-decoration: ${deco};
        ${alignStyle}
        line-height: ${lineHeight};
        margin: 0;
        padding: 0;
        overflow: hidden;
        white-space: pre-wrap;
        word-wrap: break-word;
        box-sizing: border-box;">
        ${content}
      </div>`;
    })
    .join("");

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${page.name}</title>
  <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    @page {
      margin: 0;
      size: ${pxToMm(page.widthPx)}mm ${pxToMm(page.heightPx)}mm;
    }
    
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    
    body {
      margin: 0;
      padding: 0;
      width: ${page.widthPx}px;
      height: ${page.heightPx}px;
      background: white;
      font-family: Calibri, 'Liberation Sans', Arial, sans-serif;
      position: relative;
      overflow: hidden;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    
    .page-container {
      position: absolute;
      top: 0;
      left: 0;
      width: ${page.widthPx}px;
      height: ${page.heightPx}px;
      background: white;
    }
    
    .content-area {
      position: absolute;
      top: 0;
      left: 0;
      width: ${page.widthPx}px;
      height: ${page.heightPx}px;
      background: white;
    }
    
    .element {
      position: absolute;
    }

    /* Ensure Calibri is used consistently */
    @font-face {
      font-family: 'Calibri';
      font-style: normal;
      font-weight: normal;
      src: local('Calibri'), local('Calibri Regular');
    }
    
    @font-face {
      font-family: 'Calibri';
      font-style: normal;
      font-weight: bold;
      src: local('Calibri Bold'), local('Calibri-Bold');
    }
    
    @font-face {
      font-family: 'Calibri';
      font-style: italic;
      font-weight: normal;
      src: local('Calibri Italic'), local('Calibri-Italic');
    }
    
    @font-face {
      font-family: 'Calibri';
      font-style: italic;
      font-weight: bold;
      src: local('Calibri Bold Italic'), local('Calibri-BoldItalic');
    }
  </style>
</head>
<body>
  <div class="page-container">
    <div class="content-area">
      ${elsHTML}
    </div>
  </div>
</body>
</html>`;
}
// FIXED: Production-ready PDF generation
async function generateDocumentPDF(employeeId, docType, templateId = "") {
  let browser;
  try {
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

    // Production-ready browser configuration
    const launchOptions = {
      headless: "new",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--no-first-run",
        "--no-zygote",
        "--disable-gpu",
        "--single-process"
      ],
      timeout: 30000
    };

    // Try to use system Chrome in production if available
    if (process.env.NODE_ENV === 'production') {
      launchOptions.executablePath = process.env.CHROME_BIN || '/usr/bin/google-chrome';
    }

    browser = await puppeteer.launch(launchOptions);
    const mergedPdf = await PDFDocument.create();

    for (const page of pages) {
      const p = await browser.newPage();
      
      try {
        // Set exact viewport to match page dimensions
        await p.setViewport({ 
          width: Math.round(page.widthPx), 
          height: Math.round(page.heightPx),
          deviceScaleFactor: 1
        });

        const html = generateSinglePageHTML(page, tokens, pages.length);
        
        // Set content with proper waiting
        await p.setContent(html, { 
          waitUntil: ["networkidle0"],
          timeout: 30000
        });
        
        // Wait for fonts to load
        await p.evaluateHandle('document.fonts.ready');
        
        // Additional rendering wait
        await new Promise(resolve => setTimeout(resolve, 500));

        // Generate PDF with exact dimensions and no margins
        const pdfBuffer = await p.pdf({
          width: `${pxToMm(page.widthPx)}mm`,
          height: `${pxToMm(page.heightPx)}mm`,
          printBackground: true,
          preferCSSPageSize: true,
          margin: {
            top: "0mm",
            bottom: "0mm",
            left: "0mm",
            right: "0mm",
          },
          scale: 1,
        });

        const tempPdf = await PDFDocument.load(pdfBuffer);
        const [copiedPage] = await mergedPdf.copyPages(tempPdf, [0]);
        mergedPdf.addPage(copiedPage);
        
      } catch (pageError) {
        console.error(`Error processing page:`, pageError);
        throw pageError;
      } finally {
        await p.close();
      }
    }

    const mergedPdfBytes = await mergedPdf.save();
    return Buffer.from(mergedPdfBytes);
    
  } catch (error) {
    console.error("PDF generation error:", error);
    throw error;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

/* ──────────────────────────────────────────────────────────────────────────────
   PDF ENDPOINTS WITH PRODUCTION ERROR HANDLING
────────────────────────────────────────────────────────────────────────────── */

// Health check endpoint for PDF generation
router.get("/pdf-health", async (req, res) => {
  try {
    const browser = await puppeteer.launch({
      headless: "new",
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    
    const page = await browser.newPage();
    await page.setContent('<html><body><h1>PDF Health Check</h1><p>Working correctly</p></body></html>');
    const pdf = await page.pdf({ format: 'A4' });
    
    await browser.close();
    
    res.json({ 
      status: 'healthy',
      puppeteer: 'working',
      pdfSize: pdf.length,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error("PDF health check failed:", error);
    res.status(500).json({ 
      status: 'error',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Experience Letter
router.get("/experience-letter/:employeeId", async (req, res) => {
  try {
    const { employeeId } = req.params;
    const templateId = String(req.query.templateId || "");

    console.log(`Generating experience letter for employee: ${employeeId}`);
    const pdf = await generateDocumentPDF(employeeId, "experience_letter", templateId);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'attachment; filename="ExperienceLetter.pdf"');
    res.setHeader("Content-Length", pdf.length);
    res.status(200).end(pdf);
  } catch (err) {
    console.error("Experience letter PDF error:", err);
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
    res.setHeader("Content-Length", pdf.length);
    res.status(200).end(pdf);
  } catch (err) {
    console.error("NDA PDF error:", err);
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
    res.setHeader("Content-Length", pdf.length);
    res.status(200).end(pdf);
  } catch (err) {
    console.error("Salary certificate PDF error:", err);
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
    res.setHeader("Content-Length", pdf.length);
    res.status(200).end(pdf);
  } catch (err) {
    console.error("Contract PDF error:", err);
    if (!res.headersSent) {
      res.status(500).json({ message: err.message || "Failed to generate PDF" });
    }
  }
});


/* ─────────────────────────────────────────────────────────────
   GLOBAL TEMPLATES — BY TYPE
──────────────────────────────────────────────────────────────── */
router.get("/doc-templates/:type", async (req, res) => {
  try {
    const type = normType(req.params.type);
    const tpl = await DocTemplate.findOne({ type }).lean();
    if (!tpl) return res.status(200).json({ data: null });
    res.json({
      data: { canvas: tpl.canvas, defaultValues: tpl.defaultValues || {} },
    });
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

    res.json({
      ok: true,
      data: { canvas: up.canvas, defaultValues: up.defaultValues || {} },
    });
  } catch {
    res.status(500).json({ message: "Failed to save by type" });
  }
});

/* ─────────────────────────────────────────────────────────────
   RECENT TEMPLATES — ID-BASED CRUD
──────────────────────────────────────────────────────────────── */
router.get("/templates", async (req, res) => {
  try {
    const rows = await DocTemplate.find(
      {},
      { canvas: 1, type: 1, updatedAt: 1 }
    )
      .sort({ updatedAt: -1 })
      .lean();

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
    res.json({
      data: {
        _id: String(tpl._id),
        type: tpl.type,
        canvas: tpl.canvas,
        defaultValues: tpl.defaultValues || {},
        updatedAt: tpl.updatedAt,
      },
    });
  } catch {
    res.status(500).json({ message: "Failed to load template" });
  }
});

router.post("/templates", async (req, res) => {
  try {
    const { type, canvas, defaultValues } = req.body || {};
    if (!type || !canvas) {
      return res
        .status(400)
        .json({ message: "`type` and `canvas` are required" });
    }
    const doc = await DocTemplate.create({
      type,
      canvas,
      defaultValues: defaultValues || {},
    });
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

    const up = await DocTemplate.findByIdAndUpdate(
      req.params.id,
      { $set: set },
      { new: true }
    ).lean();
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