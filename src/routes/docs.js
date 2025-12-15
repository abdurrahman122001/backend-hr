// routes/docs.js
const express = require("express");
const router = express.Router();
const puppeteer = require("puppeteer");
const { PDFDocument } = require("pdf-lib");

const Employee = require("../models/Employees");
const Salary = require("../models/Salaries");
const DocTemplate = require("../models/DocTemplate");
const ReferenceCounter = require("../models/ReferenceCounter");
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

// Format date as ddmmyyyy (19092025)
function formatDateDDMMYYYY(date = new Date()) {
  const d = new Date(date);
  if (isNaN(d.getTime())) return "";
  
  const day = String(d.getDate()).padStart(2, "0");
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const year = d.getFullYear();
  
  return `${day}${month}${year}`;
}

// Format date as Month day, year (September 19, 2025)
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
      "January", "February", "March", "April", "May", "June",
      "July", "August", "September", "October", "November", "December"
    ];
    return `${months[dt.getMonth()]} ${dt.getDate()}, ${dt.getFullYear()}`;
  }
}

// Get current year-month in MMyyyy format (092025)
function getCurrentYearMonth() {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const year = now.getFullYear();
  return `${month}${year}`;
}

// Get document type code (2-3 letters) - FIXED: Changed CR to CT
function getDocTypeCode(docType) {
  const typeCodes = {
    "experience_letter": "EL",    // Experience Letter
    "salary_certificate": "SC",   // Salary Certificate
    "nda": "NDA",                 // NDA
    "contract": "EC"              // Contract - CHANGED FROM "CR" TO "CT"
  };
  return typeCodes[docType] || "DOC";
}

// Get document full name for display
function getDocTypeName(docType) {
  const typeNames = {
    "experience_letter": "Experience Letter",
    "salary_certificate": "Salary Certificate",
    "nda": "Non-Disclosure Agreement",
    "contract": "Employment Contract"
  };
  return typeNames[docType] || "Document";
}

// Auto-incrementing reference number generator in format: MA02-EL-19092025
async function generateReferenceNumber(docType = "experience_letter") {
  try {
    const docCode = getDocTypeCode(docType);
    const yearMonth = getCurrentYearMonth(); // Format: 092025
    const currentDate = formatDateDDMMYYYY(); // Format: 19092025
    
    // Find or create counter for this document type and month
    let counter = await ReferenceCounter.findOneAndUpdate(
      { 
        docType: docType,
        yearMonth: yearMonth
      },
      { 
        $inc: { sequence: 1 },
        $set: { lastGenerated: new Date() }
      },
      { 
        upsert: true,
        new: true,
        setDefaultsOnInsert: true
      }
    );

    // Format sequence with leading zeros (01, 02, etc.)
    const sequenceStr = String(counter.sequence).padStart(2, "0");
    
    // Final format: MA02-EL-19092025
    return `MA${sequenceStr}-${docCode}-${currentDate}`;
  } catch (error) {
    console.error("Error generating reference number:", error);
    // Fallback format
    const now = new Date();
    const currentDate = formatDateDDMMYYYY(now);
    const docCode = getDocTypeCode(docType);
    return `MA01-${docCode}-${currentDate}`;
  }
}

// Function to get current reference without incrementing (for preview)
async function getCurrentReferenceNumber(docType = "experience_letter") {
  try {
    const docCode = getDocTypeCode(docType);
    const yearMonth = getCurrentYearMonth();
    const currentDate = formatDateDDMMYYYY();
    
    const counter = await ReferenceCounter.findOne({ 
      docType: docType,
      yearMonth: yearMonth
    });

    const sequence = counter ? counter.sequence : 0;
    const sequenceStr = String(sequence + 1).padStart(2, "0");
    
    // Format: MA02-EL-19092025
    return `MA${sequenceStr}-${docCode}-${currentDate}`;
  } catch (error) {
    console.error("Error getting current reference:", error);
    const currentDate = formatDateDDMMYYYY();
    const docCode = getDocTypeCode(docType);
    return `MA01-${docCode}-${currentDate}`;
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

// Function to fetch and decrypt salary fields from Salary model
async function fetchAndDecryptSalary(employeeId) {
  if (!employeeId) return {};

  try {
    // Find the active salary record for this employee
    const salaryRecord = await Salary.findOne({
      employee: employeeId,
      isActive: true,
    }).lean();

    const decryptedSalary = {};

    // Decrypt all salary fields
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

    // Calculate total if needed (using the decrypted values)
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

function getPositionsHistory(emp) {
  const positions = [];
    
  if (emp?.experiences && Array.isArray(emp.experiences) && emp.experiences.length > 0) {    
    emp.experiences.forEach((experience, expIndex) => {
      if (experience?.positions && Array.isArray(experience.positions) && experience.positions.length > 0) {        
        experience.positions.forEach((position, posIndex) => {          
          let startDate = null;
          let endDate = null;
          
          try {
            if (position.startDate) {
              startDate = new Date(position.startDate);
              if (isNaN(startDate.getTime())) startDate = null;
            }
            if (position.endDate && position.endDate !== "Present") {
              endDate = new Date(position.endDate);
              if (isNaN(endDate.getTime())) endDate = null;
            }
          } catch (error) {
            console.error("Error parsing dates:", error);
          }
          
          positions.push({
            title: position.title || "—",
            startDate: startDate,
            endDate: endDate,
            isCurrentRole: position.isCurrentRole || false,
            description: position.description || "",
            tenure: formatTenure(startDate, endDate || new Date()),
            duration: diffToYearsMonths(startDate, endDate || new Date()),
            startDateFormatted: startDate ? fmtDate(startDate) : "—",
            endDateFormatted: position.isCurrentRole ? "Present" : (endDate ? fmtDate(endDate) : "—"),
          });
        });
      }
    });
  } else {
    if (emp?.designation) {
      const joinDate = emp?.joiningDate ? new Date(emp.joiningDate) : new Date();
      const endDate = emp?.leavingDate ? new Date(emp.leavingDate) : new Date();
      
      positions.push({
        title: emp.designation || "—",
        startDate: joinDate,
        endDate: endDate,
        isCurrentRole: true,
        description: "",
        tenure: formatTenure(joinDate, endDate),
        duration: diffToYearsMonths(joinDate, endDate),
        startDateFormatted: joinDate ? fmtDate(joinDate) : "—",
        endDateFormatted: emp.leavingDate ? fmtDate(endDate) : "Present",
      });
    }
  }
  
  positions.sort((a, b) => {
    if (!a.startDate) return 1;
    if (!b.startDate) return -1;
    return new Date(b.startDate) - new Date(a.startDate);
  });
  
  return positions;
}

// Function to generate positions timeline text
function generatePositionsTimeline(positions) {
  if (!positions || positions.length === 0) {
    return "No position history available.";
  }
  
  const timelineItems = positions.map((pos, index) => {
    const start = pos.startDateFormatted;
    const end = pos.endDateFormatted;
    const currentFlag = pos.isCurrentRole ? " (Current)" : "";
    
    return `${index + 1}. ${pos.title}${currentFlag}: From ${start} to ${end} (${pos.tenure})`;
  });
  
  return timelineItems.join("\n");
}

// Updated tokenMap function to accept docType parameter
async function tokenMap(emp, defaults = {}, docType = "experience_letter") {
  // Fetch and decrypt salary fields from Salary model
  const decryptedSalary = await fetchAndDecryptSalary(emp?._id);

  const join = emp?.joiningDate;
  const endDate = emp?.leavingDate || new Date();

  const tenureHuman = formatTenure(join, endDate);
  const { totalMonths: tenureMonthsTotal } = diffToYearsMonths(join, endDate);
  
  // Get all positions history
  const positionsHistory = getPositionsHistory(emp);
  const positionsTimeline = generatePositionsTimeline(positionsHistory);
  
  // Find current position
  const currentPosition = positionsHistory.find(pos => pos.isCurrentRole === true) || 
                          positionsHistory[0] || 
                          { title: emp?.designation || emp?.position || "—" };
  
  // Find previous positions (excluding current)
  const previousPositions = positionsHistory.filter(pos => !pos.isCurrentRole);
  
  // Generate reference numbers
  const referenceNumber = await generateReferenceNumber(docType);
  const nextReferenceNumber = await getCurrentReferenceNumber(docType);
  const currentDate = formatDateDDMMYYYY();
  const docTypeCode = getDocTypeCode(docType);
  const docTypeName = getDocTypeName(docType);
  
  // Create base tokens object
  const tokens = {
    "company.name": defaults.companyName || "Mavens Advisor Pvt. Ltd.",
    "company.address": defaults.companyAddress || "",
    "contact.phone": defaults.contactPhone || "+1 (615) 988-0800",
    "sign.name": defaults.signName || "ADEEL SHAIKH",
    "sign.title": defaults.signTitle || "CHIEF EXECUTIVE OFFICER",
    
    // Document reference numbers (auto-incrementing in format: MA02-EL-19092025)
    "doc.referenceNo": referenceNumber,
    "doc.nextReferenceNo": nextReferenceNumber, // Shows what the NEXT one will be
    "doc.typeCode": docTypeCode, // EL, SC, NDA, CT
    "doc.typeName": docTypeName, // Full document name
    "doc.qualitiesLine": defaults.qualitiesLine || "…hardworking, punctual, precise, and honest.",
    
    // Dates in different formats
    "dates.issue": fmtDate(new Date()),
    "dates.today": fmtDate(new Date()),
    "dates.currentYear": new Date().getFullYear(),
    "dates.ddmmyyyy": currentDate, // Format: 19092025
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

    // Salary fields (decrypted from Salary model)
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
    "salary.gross": formatWithCommas(
      decryptedSalary.grossSalary && decryptedSalary.grossSalary !== "0"
        ? decryptedSalary.grossSalary
        : decryptedSalary.calculatedTotal
    ),

    "salary.total": formatWithCommas(
      decryptedSalary.grossSalary && decryptedSalary.grossSalary !== "0"
        ? decryptedSalary.grossSalary
        : decryptedSalary.calculatedTotal
    ),

    // simple pronoun defaults
    "employee.pronounSubject": "he",
    "employee.pronounObject": "him",
    "employee.pronounPossessive": "his",

    // Position timeline
    "positions.timeline": positionsTimeline,
    "positions.totalCount": positionsHistory.length,
    "positions.previousCount": previousPositions.length,
  };

  // Add current position variables
  if (currentPosition.startDateFormatted) {
    tokens["positions.current"] = currentPosition.title;
    tokens["positions.current.startDate"] = currentPosition.startDateFormatted;
    tokens["positions.current.endDate"] = currentPosition.endDateFormatted || "Present";
    tokens["positions.current.tenure"] = currentPosition.tenure || "—";
    tokens["positions.current.duration"] = currentPosition.duration ? 
      `${currentPosition.duration.years} years ${currentPosition.duration.months} months` : "—";
    tokens["positions.current.description"] = currentPosition.description || "—";
  }

  // Add individual previous position variables (1-10)
  previousPositions.slice(0, 10).forEach((position, index) => {
    const positionNum = index + 1;
    
    tokens[`positions.previous${positionNum}.title`] = position.title;
    tokens[`positions.previous${positionNum}.startDate`] = position.startDateFormatted;
    tokens[`positions.previous${positionNum}.endDate`] = position.endDateFormatted;
    tokens[`positions.previous${positionNum}.tenure`] = position.tenure;
    tokens[`positions.previous${positionNum}.duration`] = `${position.duration.years} years ${position.duration.months} months`;
    tokens[`positions.previous${positionNum}.description`] = position.description || "—";
  });

  // For positions beyond 10, provide empty values
  for (let i = previousPositions.length; i < 10; i++) {
    const positionNum = i + 1;
    tokens[`positions.previous${positionNum}.title`] = "";
    tokens[`positions.previous${positionNum}.startDate`] = "";
    tokens[`positions.previous${positionNum}.endDate`] = "";
    tokens[`positions.previous${positionNum}.tenure`] = "";
    tokens[`positions.previous${positionNum}.duration`] = "";
    tokens[`positions.previous${positionNum}.description`] = "";
  }

  // Add all previous titles as separate variables
  if (previousPositions.length > 0) {
    tokens["positions.hasPrevious"] = "true";
    tokens["positions.firstPrevious"] = previousPositions[0].title;
    tokens["positions.lastPrevious"] = previousPositions[previousPositions.length - 1].title;
  } else {
    tokens["positions.hasPrevious"] = "false";
    tokens["positions.firstPrevious"] = "";
    tokens["positions.lastPrevious"] = "";
  }

  return tokens;
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

/** Extract ALL pages from canvas - FIXED VERSION */
function extractAllPages(canvas = {}) {
  const pages = [];

  // Check for new structure (pages array directly in canvas)
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

  // Fallback to old structure
  if (Array.isArray(canvas) && canvas.length > 0) {
    canvas.forEach((p, index) => {
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
        name: p?.name || `Document Page ${index + 1}`,
        pageNumber: index + 1,
        totalPages: canvas.length,
      });
    });
    return pages;
  }

  // Single page fallback
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

// routes/docs.js - Updated generateSinglePageHTML function
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
      const lineHeight = num(el.lineHeight, 1.2);
      const columns = num(el.columns, 1);
      const columnGap = num(el.columnGap, 20);
      const html = applyTokens(el.content || "", tokens);

      // CSS for multi-column layout
      const columnStyle =
        columns > 1
          ? `column-count: ${columns}; column-gap: ${columnGap}px;`
          : "";

      // FIXED: Proper justify alignment with text-justify
      const alignStyle =
        align === "justify"
          ? "text-align: justify; text-justify: inter-word;"
          : `text-align: ${align};`;

      return `<div class="el" style="
        position:absolute;left:${x}px;top:${y}px;width:${w}px;height:${h}px;
        color:${color};font-family:'${escCss(ff)}',sans-serif;font-size:${fs}px;
        font-weight:${bold};font-style:${italic};text-decoration:${deco};
        ${alignStyle}line-height:${lineHeight};${columnStyle}
        overflow:hidden;">${html}</div>`;
    })
    .join("");

  const pageNumberHTML = totalPages > 1 ? `` : "";

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>${page.name}</title>
<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;600;700&display=swap" rel="stylesheet">
<style>
  @page {
    margin: 0;
    size: ${pxToMm(page.widthPx)}mm ${pxToMm(page.heightPx)}mm;
  }
  html, body {
    margin: 0;
    padding: 0;
    width: ${page.widthPx}px;
    height: ${page.heightPx}px;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }

  /* Key fix: translate page content down by header height */
  .page {
    width: ${page.widthPx}px;
    height: ${page.heightPx - (page.header + page.footer)}px;
    position: relative;
    background: #fff;
    color: #000;
    font-family: 'Poppins', sans-serif;
    overflow: hidden;
    box-sizing: border-box;
    transform: translateY(${page.header}px);
  }

  /* Multi-column support */
  .el {
    -webkit-column-count: inherit;
    -moz-column-count: inherit;
    column-count: inherit;
    -webkit-column-gap: inherit;
    -moz-column-gap: inherit;
    column-gap: inherit;
  }

  /* Justify alignment support */
  .el[style*="text-align: justify"] {
    text-align: justify;
    text-justify: inter-word;
  }

  .el * { margin: 0; }
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

async function generateDocumentPDF(employeeId, docType, templateId = "") {
  const emp = await Employee.findById(employeeId).lean();
  if (!emp) throw new Error("Employee not found");

  const tpl = templateId
    ? await DocTemplate.findById(templateId).lean()
    : await DocTemplate.findOne({ type: normType(docType) }).lean();
  if (!tpl) throw new Error("Template not found");

  const defaults = tpl.defaultValues || {};
  // FIXED: Pass the normalized docType to tokenMap
  const normalizedDocType = normType(docType);
  const tokens = await tokenMap(emp, defaults, normalizedDocType);
  const pages = extractAllPages(tpl.canvas || {});
  if (pages.length === 0) throw new Error("No pages found in template");

  const browser = await puppeteer.launch({
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  try {
    const mergedPdf = await PDFDocument.create();

    for (const page of pages) {
      const p = await browser.newPage();
      await p.setViewport({ width: page.widthPx, height: page.heightPx });

      const html = generateSinglePageHTML(page, tokens, pages.length);
      await p.setContent(html, { waitUntil: "networkidle0" });
      await p.emulateMediaType("screen");

      // ✅ Convert header/footer px → mm (used as PDF margins)
      const headerMm = pxToMm(page.header);
      const footerMm = pxToMm(page.footer);

      const pdfBuffer = await p.pdf({
        printBackground: true,
        preferCSSPageSize: true,
        width: `${pxToMm(page.widthPx)}mm`,
        height: `${pxToMm(page.heightPx)}mm`,
        margin: {
          top: `${headerMm}mm`,
          bottom: `${footerMm}mm`,
          left: "0mm",
          right: "0mm",
        },
      });

      const tempPdf = await PDFDocument.load(pdfBuffer);
      const [copiedPage] = await mergedPdf.copyPages(tempPdf, [0]);
      mergedPdf.addPage(copiedPage);
      await p.close();
    }

    const mergedPdfBytes = await mergedPdf.save();
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

    const pdf = await generateDocumentPDF(
      employeeId,
      "experience_letter",
      templateId
    );

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="ExperienceLetter.pdf"'
    );
    res.status(200).end(pdf);
  } catch (err) {
    console.error("experience-letter pdf error:", err);
    if (!res.headersSent) {
      res
        .status(500)
        .json({ message: err.message || "Failed to generate PDF" });
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
      res
        .status(500)
        .json({ message: err.message || "Failed to generate PDF" });
    }
  }
});

// Salary Certificate
router.get("/salary-certificate/:employeeId", async (req, res) => {
  try {
    const { employeeId } = req.params;
    const templateId = String(req.query.templateId || "");

    const pdf = await generateDocumentPDF(
      employeeId,
      "salary_certificate",
      templateId
    );

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="SalaryCertificate.pdf"'
    );
    res.status(200).end(pdf);
  } catch (err) {
    console.error("salary-certificate pdf error:", err);
    if (!res.headersSent) {
      res
        .status(500)
        .json({ message: err.message || "Failed to generate PDF" });
    }
  }
});

// Salary Certificate (POST - same style as contract POST)
router.post("/salary-certificate/:employeeId", async (req, res) => {
  try {
    const { employeeId } = req.params;
    const { key } = req.body || {};
    const templateId = String(req.query.templateId || "");

    const pdf = await generateDocumentPDF(
      employeeId,
      "salary_certificate",
      templateId
    );

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="SalaryCertificate.pdf"'
    );
    res.status(200).end(pdf);
  } catch (err) {
    console.error("salary-certificate pdf error:", err);
    if (!res.headersSent) {
      res
        .status(500)
        .json({ message: err.message || "Failed to generate PDF" });
    }
  }
});

// Contract (with optional decryption key support)
router.post("/contract/:employeeId", async (req, res) => {
  try {
    const { employeeId } = req.params;
    const { key } = req.body || {};
    const templateId = String(req.query.templateId || "");

    const pdf = await generateDocumentPDF(employeeId, "contract", templateId);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'attachment; filename="Contract.pdf"');
    res.status(200).end(pdf);
  } catch (err) {
    console.error("contract pdf error:", err);
    if (!res.headersSent) {
      res
        .status(500)
        .json({ message: err.message || "Failed to generate PDF" });
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
    res.setHeader("Content-Disposition", 'attachment; filename="Contract.pdf"');
    res.status(200).end(pdf);
  } catch (err) {
    console.error("contract pdf error:", err);
    if (!res.headersSent) {
      res
        .status(500)
        .json({ message: err.message || "Failed to generate PDF" });
    }
  }
});

// New endpoint: Preview reference number without incrementing
router.get("/reference-preview/:docType", async (req, res) => {
  try {
    const docType = normType(req.params.docType);
    const referenceNumber = await getCurrentReferenceNumber(docType);
    
    res.json({
      ok: true,
      referenceNumber,
      docType,
      preview: true
    });
  } catch (err) {
    console.error("reference-preview error:", err);
    res.status(500).json({ message: "Failed to generate preview" });
  }
});

// Get recent reference numbers for a document type
router.get("/reference-history/:docType", async (req, res) => {
  try {
    const docType = normType(req.params.docType);
    const limit = parseInt(req.query.limit) || 10;
    
    const counters = await ReferenceCounter.find({ docType: docType })
      .sort({ yearMonth: -1, sequence: -1 })
      .limit(limit)
      .lean();

    const history = counters.map(counter => {
      const sequenceStr = String(counter.sequence).padStart(2, "0");
      const docCode = getDocTypeCode(docType);
      // Convert yearMonth (092025) to date format
      const month = counter.yearMonth.substring(0, 2);
      const year = counter.yearMonth.substring(2);
      const date = `01${month}${year}`; // Using 01 as day since we only track month
      
      return {
        referenceNumber: `MA${sequenceStr}-${docCode}-${date}`,
        generatedAt: counter.lastGenerated,
        sequence: counter.sequence,
        yearMonth: counter.yearMonth
      };
    });

    res.json({
      ok: true,
      history,
      docType,
      docName: getDocTypeName(docType)
    });
  } catch (err) {
    console.error("reference-history error:", err);
    res.status(500).json({ message: "Failed to fetch reference history" });
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
      data: { 
        canvas: tpl.canvas, 
        defaultValues: tpl.defaultValues || {},
        type: tpl.type,
        docTypeName: getDocTypeName(tpl.type),
        docTypeCode: getDocTypeCode(tpl.type)
      },
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
      data: { 
        canvas: up.canvas, 
        defaultValues: up.defaultValues || {},
        type: up.type,
        docTypeName: getDocTypeName(up.type),
        docTypeCode: getDocTypeCode(up.type)
      },
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
      typeName: getDocTypeName(r.type),
      typeCode: getDocTypeCode(r.type),
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
        typeName: getDocTypeName(tpl.type),
        typeCode: getDocTypeCode(tpl.type),
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
    res.status(201).json({ 
      ok: true, 
      id: String(doc._id),
      typeName: getDocTypeName(doc.type),
      typeCode: getDocTypeCode(doc.type)
    });
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
    res.json({ 
      ok: true,
      typeName: getDocTypeName(up.type),
      typeCode: getDocTypeCode(up.type)
    });
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