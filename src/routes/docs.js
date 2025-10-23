// routes/docs.js
const express = require("express");
const router = express.Router();
const puppeteer = require("puppeteer");
const { PDFDocument } = require('pdf-lib');

const Employee = require("../models/Employees");
const DocTemplate = require("../models/DocTemplate");

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

// replaces your current fmtDate()
function fmtDate(d) {
  if (!d) return "—";
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return "—";

  // Prefer reliable locale formatting
  try {
    return dt.toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  } catch {
    // Fallback without Intl
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
// Month-aware Y/M difference (no rounding up at month edges)
function diffToYearsMonths(start, end) {
  if (!start || !end) return { years: 0, months: 0, totalMonths: 0 };
  const s = new Date(start);
  const e = new Date(end);
  if (isNaN(s.getTime()) || isNaN(e.getTime())) {
    return { years: 0, months: 0, totalMonths: 0 };
  }

  // total month diff
  let totalMonths =
    (e.getFullYear() - s.getFullYear()) * 12 + (e.getMonth() - s.getMonth());

  // If end's day is before start's day, we haven't completed this month yet
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

function defaultsFromTemplate(tpl) {
  return tpl?.defaultValues || {};
}

function tokenMap(emp, defaults = {}) {
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
    "tenure.human": tenureHuman, // e.g., "1 year 4 months", "4 months"
    "tenure.monthsTotal": tenureMonthsTotal, // e.g., 16

    "employee.name": emp?.name || "—",
    "employee.cnic": emp?.cnic || "—",
    "employee.nationality": emp?.nationality || "—",
    "employee.designation": emp?.designation || emp?.position || "—",
    "employee.department": emp?.department || "—",
    "employee.position": emp?.position || emp?.designation || "—",
    "employee.email": emp?.email || "—",
    "employee.phone": emp?.phone || "—",
    "employee.address": emp?.presentAddress || emp?.permanentAddress || "—",

    // simple pronoun defaults (change if you store an actual field)
    "employee.pronounSubject": "he",
    "employee.pronounObject": "him",
    "employee.pronounPossessive": "his",

    "roles.timeline": "",
  };
}

/** supports {{ key }}, {{ key | upper }}, {{ key | lower }}, {{ key | title }}, {{ key | trim }} */
function applyTokens(html, tokens) {
  return String(html).replace(
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

/** Extract ALL pages from canvas */
function extractAllPages(canvas = {}) {
  const pages = [];
  
  console.log("Canvas structure:", JSON.stringify(canvas, null, 2));
  
  // Array form (multi-page)
  if (Array.isArray(canvas.pages) && canvas.pages.length > 0) {
    console.log(`Found ${canvas.pages.length} pages in canvas.pages array`);
    canvas.pages.forEach((p, index) => {
      const widthPx = num(p?.pageFormat?.width, 794);
      const heightPx = num(p?.pageFormat?.height, 1123);
      const header = num(p?.headerHeight ?? 0, 0);
      const footer = num(p?.footerHeight ?? 0, 0);
      const elements = Array.isArray(p?.elements) ? p.elements : [];
      
      console.log(`Page ${index + 1}: ${elements.length} elements`);
      
      pages.push({
        widthPx,
        heightPx,
        header,
        footer,
        elements,
        name: canvas?.name || `Document Page ${index + 1}`,
        pageNumber: index + 1,
        totalPages: canvas.pages.length
      });
    });
    return pages;
  }
  
  // Flat form (single page)
  console.log("Using flat canvas structure (single page)");
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
    totalPages: 1
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
      const ff = el.fontFamily || "Poppins";
      const bold = el.bold ? "600" : "400";
      const italic = el.italic ? "italic" : "normal";
      const deco = el.underline ? "underline" : "none";
      const color = el.color || "#000000";
      const align = el.align || "left";
      const html = applyTokens(el.content || "", tokens);

      return `<div class="el" style="
        position:absolute;left:${x}px;top:${y}px;width:${w}px;height:${h}px;
        color:${color};font-family:'${escCss(ff)}',sans-serif;font-size:${fs}px;
        font-weight:${bold};font-style:${italic};text-decoration:${deco};
        text-align:${align};overflow:hidden;">${html}</div>`;
    })
    .join("");

  // Add page number if multiple pages
  const pageNumberHTML = totalPages > 1 ? 
    `<div class="page-number" style="position:absolute;bottom:10px;right:20px;font-family:'Poppins',sans-serif;font-size:12px;color:#666;">
      Page ${page.pageNumber} of ${totalPages}
    </div>` : '';

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>${page.name}</title>
<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;600;700&display=swap" rel="stylesheet">
<style>
  body {
    margin: 0;
    padding: 0;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
    width: ${page.widthPx}px;
    height: ${page.heightPx}px;
    overflow: hidden;
  }
  .page {
    width: ${page.widthPx}px;
    height: ${page.heightPx}px;
    background: #fff;
    color: #000;
    font-family: 'Poppins', sans-serif;
    padding-top: ${page.header}px;
    padding-bottom: ${page.footer}px;
    position: relative;
    box-sizing: border-box;
  }
  .el * {
    margin: 0;
  }
  .page-number { 
    font-family: 'Poppins', sans-serif; 
  }
</style>
</head>
<body>
  <div class="page">
    ${elsHTML}
    ${pageNumberHTML}
  </div>
</body>
</html>`;
}

/* ──────────────────────────────────────────────────────────────────────────────
   GENERATE PDF WITH PROPER PAGE MERGING
────────────────────────────────────────────────────────────────────────────── */
async function generateDocumentPDF(employeeId, docType, templateId = "") {
  const emp = await Employee.findById(employeeId).lean();
  if (!emp) throw new Error("Employee not found");

  let tpl;
  if (templateId) {
    tpl = await DocTemplate.findById(templateId).lean();
    if (!tpl) throw new Error("Template not found");
  } else {
    tpl = await DocTemplate.findOne({ type: normType(docType) }).lean();
    if (!tpl) throw new Error(`No ${docType} template in DB`);
  }

  const defaults = defaultsFromTemplate(tpl);
  const tokens = tokenMap(emp, defaults);
  const pages = extractAllPages(tpl.canvas || {});
  
  console.log(`Total pages extracted: ${pages.length}`);
  
  if (pages.length === 0) {
    throw new Error("No pages found in template");
  }

  const browser = await puppeteer.launch({
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  
  try {
    // Create a new PDFDocument to merge all pages
    const mergedPdf = await PDFDocument.create();
    
    for (let i = 0; i < pages.length; i++) {
      const page = pages[i];
      const p = await browser.newPage();
      
      // Set viewport to exact page size
      await p.setViewport({
        width: page.widthPx,
        height: page.heightPx
      });
      
      // Generate HTML for this single page only
      const html = generateSinglePageHTML(page, tokens, pages.length);
      
      await p.setContent(html, { waitUntil: "networkidle0" });
      await p.emulateMediaType("screen");

      // Generate PDF for this single page
      const pdfBuffer = await p.pdf({
        printBackground: true,
        preferCSSPageSize: true,
        width: `${pxToMm(page.widthPx)}mm`,
        height: `${pxToMm(page.heightPx)}mm`,
      });
      
      // Load the single page PDF
      const singlePagePdf = await PDFDocument.load(pdfBuffer);
      
      // Copy all pages from the single page PDF to the merged PDF
      const [copiedPage] = await mergedPdf.copyPages(singlePagePdf, [0]);
      mergedPdf.addPage(copiedPage);
      
      await p.close();
    }
    
    // Serialize the merged PDF to bytes
    const mergedPdfBytes = await mergedPdf.save();
    
    console.log(`Generated PDF with exactly ${pages.length} pages`);
    return Buffer.from(mergedPdfBytes);
  } finally {
    await browser.close();
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
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="ExperienceLetter.pdf"'
    );
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
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="NDA.pdf"'
    );
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
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="SalaryCertificate.pdf"'
    );
    res.status(200).end(pdf);
  } catch (err) {
    console.error("salary-certificate pdf error:", err);
    if (!res.headersSent) {
      res.status(500).json({ message: err.message || "Failed to generate PDF" });
    }
  }
});

// Contract (with optional decryption key support)
router.post("/contract/:employeeId", async (req, res) => {
  try {
    const { employeeId } = req.params;
    const { key } = req.body || {};
    const templateId = String(req.query.templateId || "");

    // If you need decryption logic for contracts, add it here
    if (key) {
      console.log("Contract decryption key provided:", key);
    }

    const pdf = await generateDocumentPDF(employeeId, "contract", templateId);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="Contract.pdf"'
    );
    res.status(200).end(pdf);
  } catch (err) {
    console.error("contract pdf error:", err);
    if (!res.headersSent) {
      res.status(500).json({ message: err.message || "Failed to generate PDF" });
    }
  }
});

// Also support GET for contract without decryption
router.get("/contract/:employeeId", async (req, res) => {
  try {
    const { employeeId } = req.params;
    const templateId = String(req.query.templateId || "");

    const pdf = await generateDocumentPDF(employeeId, "contract", templateId);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="Contract.pdf"'
    );
    res.status(200).end(pdf);
  } catch (err) {
    console.error("contract pdf error:", err);
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