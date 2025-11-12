// routes/docs.js
const express = require("express");
const router = express.Router();
const puppeteer = require("puppeteer");

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

/** ALWAYS returns one page. Works with:
 * - canvas.pages[0]  (preferred)
 * - flat canvas      (canvas.elements / canvas.pageFormat)
 */
function extractSinglePage(canvas = {}) {
  // Array form
  if (Array.isArray(canvas.pages) && canvas.pages.length > 0) {
    const p = canvas.pages[0] || {};
    const widthPx = num(p?.pageFormat?.width, 794);
    const heightPx = num(p?.pageFormat?.height, 1123);
    const header = num(p?.headerHeight ?? 0, 0);
    const footer = num(p?.footerHeight ?? 0, 0);
    const elements = Array.isArray(p?.elements) ? p.elements : [];
    return {
      widthPx,
      heightPx,
      header,
      footer,
      elements,
      name: canvas?.name || "Document",
    };
  }
  // Flat form
  const widthPx = num(canvas?.pageFormat?.width, 794);
  const heightPx = num(canvas?.pageFormat?.height, 1123);
  const header = num(canvas?.headerHeight, 0);
  const footer = num(canvas?.footerHeight, 0);
  const elements = Array.isArray(canvas?.elements) ? canvas.elements : [];
  return {
    widthPx,
    heightPx,
    header,
    footer,
    elements,
    name: canvas?.name || "Document",
  };
}

function pageToHTML(page, tokens) {
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

  // Keep header/footer space + Poppins font
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>${page.name}</title>
<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;600;700&display=swap" rel="stylesheet">
<style>
  @page{
    size:${pxToMm(page.widthPx)}mm ${pxToMm(page.heightPx)}mm;
    margin:${pxToMm(page.header)}mm ${pxToMm(20)}mm ${pxToMm(
    page.footer
  )}mm ${pxToMm(20)}mm;
  }
  html,body{margin:0;padding:0;-webkit-print-color-adjust:exact;print-color-adjust:exact;}
  .page{
    position:relative;
    width:${page.widthPx}px;height:${page.heightPx}px;
    background:#fff;color:#000;font-family:'Poppins',sans-serif;
    padding-top:${page.header}px;padding-bottom:${page.footer}px;
  }
  .el *{margin:0}
</style>
</head>
<body>
  <div class="page">
    ${elsHTML}
  </div>
</body>
</html>`;
}

/* ──────────────────────────────────────────────────────────────────────────────
   PDF (always one page rendered)
────────────────────────────────────────────────────────────────────────────── */
router.get("/experience-letter/:employeeId", async (req, res) => {
  let browser;
  try {
    const { employeeId } = req.params;
    const templateId = String(req.query.templateId || "");

    const emp = await Employee.findById(employeeId).lean();
    if (!emp) return res.status(404).json({ message: "Employee not found" });

    let tpl;
    if (templateId) {
      tpl = await DocTemplate.findById(templateId).lean();
      if (!tpl) return res.status(404).json({ message: "Template not found" });
    } else {
      tpl = await DocTemplate.findOne({ type: "experience_letter" }).lean();
      if (!tpl)
        return res
          .status(404)
          .json({ message: "No experience_letter template in DB" });
    }

    const defaults = defaultsFromTemplate(tpl);
    const tokens = tokenMap(emp, defaults);
    const page = extractSinglePage(tpl.canvas || {});
    const html = pageToHTML(page, tokens);

    browser = await puppeteer.launch({
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    const p = await browser.newPage();
    await p.setContent(html, { waitUntil: "networkidle0" });
    await p.emulateMediaType("screen");

    const pdf = await p.pdf({
      printBackground: true,
      preferCSSPageSize: true,
      pageRanges: "1", // force single page output
    });

    await p.close();
    await browser.close();

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="ExperienceLetter.pdf"'
    );
    res.status(200).end(pdf);
  } catch (err) {
    try {
      if (browser) await browser.close();
    } catch {}
    console.error("experience-letter pdf error:", err);
    if (!res.headersSent) {
      res.status(500).json({ message: "Failed to generate PDF" });
    }
  }
});

/* ─────────────────────────────────────────────────────────────
   GLOBAL TEMPLATES — BY TYPE (THIS IS THE ONE YOUR FRONTEND NEEDS)
   GET /api/docs/doc-templates/:type
   POST /api/docs/doc-templates/:type
────────────────────────────────────────────────────────────── */
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
   GET /api/docs/templates              -> list all
   GET /api/docs/templates/:id          -> load by _id
   POST /api/docs/templates             -> create (optional)
   PUT /api/docs/templates/:id          -> update
   DELETE /api/docs/templates/:id       -> delete
────────────────────────────────────────────────────────────── */
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