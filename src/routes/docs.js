const express = require("express");
const router = express.Router();
const puppeteer = require("puppeteer");
const { PDFDocument } = require("pdf-lib");

const Employee = require("../models/Employees");
const Salary = require("../models/Salaries");
const DocTemplate = require("../models/DocTemplate");
const ReferenceCounter = require("../models/ReferenceCounter");
const Settings = require("../models/Settings");
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

// Middleware to extract owner ID from request
const extractOwnerId = (req, res, next) => {
  req.ownerId =
    req.user?._id || req._id || req.body?.ownerId || req.query?.ownerId;
  if (!req.ownerId) {
    return res.status(401).json({ message: "Owner ID is required" });
  }
  next();
};

// Apply middleware to all document routes
router.use(extractOwnerId);

// Get timezone from database for a specific owner
async function getUserTimezone(ownerId) {
  try {
    if (!ownerId) return "UTC";

    const settings = await Settings.findOne({ owner: ownerId }).lean();

    if (settings) {
      if (settings.useSystemTimezone || !settings.timezone) {
        return Intl.DateTimeFormat().resolvedOptions().timeZone;
      }
      return settings.timezone || "UTC";
    }

    return "UTC";
  } catch (error) {
    console.error("Error fetching user timezone:", error);
    return "UTC";
  }
}

// Format date with specific timezone
function formatDateWithTimezone(date, timezone = "UTC", format = "en-US") {
  try {
    const d = new Date(date);
    if (isNaN(d.getTime())) return "";

    return d.toLocaleDateString(format, {
      year: "numeric",
      month: "long",
      day: "numeric",
      timeZone: timezone,
    });
  } catch (error) {
    console.error("Error formatting date with timezone:", error);
    return new Date(date).toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
      timeZone: "UTC",
    });
  }
}

// Format date as ddmmyyyy (19092025) with timezone
function formatDateDDMMYYYY(date = new Date(), timezone = "UTC") {
  try {
    const d = new Date(date);
    if (isNaN(d.getTime())) return "";

    const formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    });

    const parts = formatter.formatToParts(d);
    const day = parts.find((p) => p.type === "day").value;
    const month = parts.find((p) => p.type === "month").value;
    const year = parts.find((p) => p.type === "year").value;

    return `${day}${month}${year}`;
  } catch (error) {
    console.error("Error formatting date DDMMYYYY with timezone:", error);
    const d = new Date(date);
    if (isNaN(d.getTime())) return "";

    const day = String(d.getUTCDate()).padStart(2, "0");
    const month = String(d.getUTCMonth() + 1).padStart(2, "0");
    const year = d.getUTCFullYear();

    return `${day}${month}${year}`;
  }
}

// Format date as YYYY-MM-DD for date comparison with timezone
function formatDateYYYYMMDD(date = new Date(), timezone = "UTC") {
  try {
    const d = new Date(date);
    if (isNaN(d.getTime())) return "";

    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });

    const parts = formatter.formatToParts(d);
    const year = parts.find((p) => p.type === "year").value;
    const month = parts.find((p) => p.type === "month").value;
    const day = parts.find((p) => p.type === "day").value;

    return `${year}-${month}-${day}`;
  } catch (error) {
    console.error("Error formatting date YYYYMMDD with timezone:", error);
    const d = new Date(date);
    if (isNaN(d.getTime())) return "";

    const year = d.getUTCFullYear();
    const month = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");

    return `${year}-${month}-${day}`;
  }
}

// Format date as Month day, year (September 19, 2025) with timezone
function fmtDate(d, timezone = "UTC") {
  if (!d) return "—";

  try {
    const dt = new Date(d);
    if (isNaN(dt.getTime())) return "—";

    return dt.toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
      timeZone: timezone,
    });
  } catch (error) {
    console.error("Error in fmtDate with timezone:", error);
    const dt = new Date(d);
    if (isNaN(dt.getTime())) return "—";

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

    const offset =
      timezone === "UTC" ? 0 : new Date().getTimezoneOffset() / -60;

    const adjustedDate = new Date(dt.getTime() + offset * 60 * 60 * 1000);

    return `${
      months[adjustedDate.getMonth()]
    } ${adjustedDate.getDate()}, ${adjustedDate.getFullYear()}`;
  }
}

// Get current year-month in MMyyyy format (092025) with timezone
function getCurrentYearMonth(timezone = "UTC") {
  try {
    const now = new Date();
    const formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      month: "2-digit",
      year: "numeric",
    });

    const parts = formatter.formatToParts(now);
    const month = parts.find((p) => p.type === "month").value;
    const year = parts.find((p) => p.type === "year").value;

    return `${month}${year}`;
  } catch (error) {
    console.error("Error getting current year-month with timezone:", error);
    const now = new Date();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const year = now.getFullYear();
    return `${month}${year}`;
  }
}

// Get current date in YYYY-MM-DD format for comparison with timezone
function getCurrentDateString(timezone = "UTC") {
  return formatDateYYYYMMDD(new Date(), timezone);
}

// Get document type code (2-3 letters)
function getDocTypeCode(docType) {
  const typeCodes = {
    experience_letter: "EL",
    salary_certificate: "SC",
    nda: "NDA",
    contract: "EC",
  };
  return typeCodes[docType] || "DOC";
}

// Get document full name for display
function getDocTypeName(docType) {
  const typeNames = {
    experience_letter: "Experience Letter",
    salary_certificate: "Salary Certificate",
    nda: "Non-Disclosure Agreement",
    contract: "Employment Contract",
  };
  return typeNames[docType] || "Document";
}

// Auto-incrementing reference number generator with daily reset and timezone
async function generateReferenceNumber(docType = "experience_letter", ownerId) {
  try {
    const timezone = await getUserTimezone(ownerId);
    const docCode = getDocTypeCode(docType);
    const yearMonth = getCurrentYearMonth(timezone);
    const currentDateDDMMYYYY = formatDateDDMMYYYY(new Date(), timezone);
    const currentDate = getCurrentDateString(timezone);

    let counter = await ReferenceCounter.findOne({
      docType: docType,
      yearMonth: yearMonth,
      owner: ownerId,
    });

    let shouldReset = false;

    if (counter) {
      const lastGeneratedDate = counter.lastGenerated
        ? formatDateYYYYMMDD(counter.lastGenerated, timezone)
        : null;

      if (lastGeneratedDate && lastGeneratedDate !== currentDate) {
        shouldReset = true;
      }
    } else {
      shouldReset = true;
    }

    if (shouldReset) {
      counter = await ReferenceCounter.findOneAndUpdate(
        {
          docType: docType,
          yearMonth: yearMonth,
          owner: ownerId,
        },
        {
          $set: {
            sequence: 1,
            lastGenerated: new Date(),
            lastGeneratedDate: currentDate,
            timezone: timezone,
            owner: ownerId,
          },
        },
        {
          upsert: true,
          new: true,
          setDefaultsOnInsert: true,
        }
      );
    } else {
      counter = await ReferenceCounter.findOneAndUpdate(
        {
          docType: docType,
          yearMonth: yearMonth,
          owner: ownerId,
        },
        {
          $inc: { sequence: 1 },
          $set: {
            lastGenerated: new Date(),
            lastGeneratedDate: currentDate,
            timezone: timezone,
          },
        },
        {
          new: true,
        }
      );
    }

    const sequenceStr = String(counter.sequence).padStart(2, "0");
    return `MA${sequenceStr}-${docCode}-${currentDateDDMMYYYY}`;
  } catch (error) {
    console.error("Error generating reference number:", error);
    const now = new Date();
    const timezone = await getUserTimezone(ownerId);
    const currentDateDDMMYYYY = formatDateDDMMYYYY(now, timezone);
    const docCode = getDocTypeCode(docType);
    return `MA01-${docCode}-${currentDateDDMMYYYY}`;
  }
}

// Function to get current reference without incrementing (for preview)
async function getCurrentReferenceNumber(
  docType = "experience_letter",
  ownerId
) {
  try {
    const timezone = await getUserTimezone(ownerId);
    const docCode = getDocTypeCode(docType);
    const yearMonth = getCurrentYearMonth(timezone);
    const currentDateDDMMYYYY = formatDateDDMMYYYY(new Date(), timezone);
    const currentDate = getCurrentDateString(timezone);

    const counter = await ReferenceCounter.findOne({
      docType: docType,
      yearMonth: yearMonth,
      owner: ownerId,
    });

    let sequence = 1;

    if (counter) {
      const lastGeneratedDate = counter.lastGeneratedDate
        ? formatDateYYYYMMDD(counter.lastGeneratedDate, timezone)
        : null;

      if (lastGeneratedDate && lastGeneratedDate === currentDate) {
        sequence = counter.sequence + 1;
      } else {
        sequence = 1;
      }
    }

    const sequenceStr = String(sequence).padStart(2, "0");
    return `MA${sequenceStr}-${docCode}-${currentDateDDMMYYYY}`;
  } catch (error) {
    console.error("Error getting current reference:", error);
    const timezone = await getUserTimezone(ownerId);
    const currentDateDDMMYYYY = formatDateDDMMYYYY(new Date(), timezone);
    const docCode = getDocTypeCode(docType);
    return `MA01-${docCode}-${currentDateDDMMYYYY}`;
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

// Function to fetch and decrypt salary fields from Salary model
async function fetchAndDecryptSalary(employeeId) {
  if (!employeeId) return {};

  try {
    const salaryRecord = await Salary.findOne({
      employee: employeeId,
      isActive: true,
    }).lean();

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

function getPositionsHistory(emp) {
  const positions = [];

  if (
    emp?.experiences &&
    Array.isArray(emp.experiences) &&
    emp.experiences.length > 0
  ) {
    emp.experiences.forEach((experience, expIndex) => {
      if (
        experience?.positions &&
        Array.isArray(experience.positions) &&
        experience.positions.length > 0
      ) {
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
            endDateFormatted: position.isCurrentRole
              ? "Present"
              : endDate
              ? fmtDate(endDate)
              : "—",
          });
        });
      }
    });
  } else {
    if (emp?.designation) {
      const joinDate = emp?.joiningDate
        ? new Date(emp.joiningDate)
        : new Date();
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

    return `${index + 1}. ${
      pos.title
    }${currentFlag}: From ${start} to ${end} (${pos.tenure})`;
  });

  return timelineItems.join("\n");
}

// Updated tokenMap function
async function tokenMap(
  emp,
  defaults = {},
  docType = "experience_letter",
  ownerId
) {
  const decryptedSalary = await fetchAndDecryptSalary(emp?._id);

  const join = emp?.joiningDate;
  const endDate = emp?.leavingDate || new Date();

  const tenureHuman = formatTenure(join, endDate);
  const { totalMonths: tenureMonthsTotal } = diffToYearsMonths(join, endDate);

  const timezone = await getUserTimezone(ownerId);

  const positionsHistory = getPositionsHistory(emp);
  const positionsTimeline = generatePositionsTimeline(positionsHistory);

  const currentPosition = positionsHistory.find(
    (pos) => pos.isCurrentRole === true
  ) ||
    positionsHistory[0] || { title: emp?.designation || emp?.position || "—" };

  const previousPositions = positionsHistory.filter(
    (pos) => !pos.isCurrentRole
  );

  const referenceNumber = await generateReferenceNumber(docType, ownerId);
  const nextReferenceNumber = await getCurrentReferenceNumber(docType, ownerId);
  const currentDate = formatDateDDMMYYYY(new Date(), timezone);
  const docTypeCode = getDocTypeCode(docType);
  const docTypeName = getDocTypeName(docType);

  const tokens = {
    "company.name": defaults.companyName || "Mavens Advisor Pvt. Ltd.",
    "company.address": defaults.companyAddress || "",
    "contact.phone": defaults.contactPhone || "+1 (615) 988-0800",
    "sign.name": defaults.signName || "ADEEL SHAIKH",
    "sign.title": defaults.signTitle || "CHIEF EXECUTIVE OFFICER",

    "doc.referenceNo": referenceNumber,
    "doc.nextReferenceNo": nextReferenceNumber,
    "doc.typeCode": docTypeCode,
    "doc.typeName": docTypeName,
    "doc.qualitiesLine":
      defaults.qualitiesLine || "…hardworking, punctual, precise, and honest.",

    "dates.issue": fmtDate(new Date(), timezone),
    "dates.today": fmtDate(new Date(), timezone),
    "dates.currentYear": new Date().getFullYear(),
    "dates.ddmmyyyy": currentDate,
    "dates.join": fmtDate(emp?.joiningDate, timezone),
    "dates.end": emp?.leavingDate
      ? fmtDate(emp.leavingDate, timezone)
      : "present",
    "dates.timezone": timezone,
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
      decryptedSalary.grossSalary && decryptedSalary.grossSalary !== "0"
        ? decryptedSalary.grossSalary
        : decryptedSalary.calculatedTotal
    ),

    "salary.total": formatWithCommas(
      decryptedSalary.grossSalary && decryptedSalary.grossSalary !== "0"
        ? decryptedSalary.grossSalary
        : decryptedSalary.calculatedTotal
    ),

    "employee.pronounSubject": "he",
    "employee.pronounObject": "him",
    "employee.pronounPossessive": "his",

    "positions.timeline": positionsTimeline,
    "positions.totalCount": positionsHistory.length,
    "positions.previousCount": previousPositions.length,
  };

  if (currentPosition.startDateFormatted) {
    tokens["positions.current"] = currentPosition.title;
    tokens["positions.current.startDate"] = currentPosition.startDateFormatted;
    tokens["positions.current.endDate"] =
      currentPosition.endDateFormatted || "Present";
    tokens["positions.current.tenure"] = currentPosition.tenure || "—";
    tokens["positions.current.duration"] = currentPosition.duration
      ? `${currentPosition.duration.years} years ${currentPosition.duration.months} months`
      : "—";
    tokens["positions.current.description"] =
      currentPosition.description || "—";
  }

  previousPositions.slice(0, 10).forEach((position, index) => {
    const positionNum = index + 1;

    tokens[`positions.previous${positionNum}.title`] = position.title;
    tokens[`positions.previous${positionNum}.startDate`] =
      position.startDateFormatted;
    tokens[`positions.previous${positionNum}.endDate`] =
      position.endDateFormatted;
    tokens[`positions.previous${positionNum}.tenure`] = position.tenure;
    tokens[
      `positions.previous${positionNum}.duration`
    ] = `${position.duration.years} years ${position.duration.months} months`;
    tokens[`positions.previous${positionNum}.description`] =
      position.description || "—";
  });

  for (let i = previousPositions.length; i < 10; i++) {
    const positionNum = i + 1;
    tokens[`positions.previous${positionNum}.title`] = "";
    tokens[`positions.previous${positionNum}.startDate`] = "";
    tokens[`positions.previous${positionNum}.endDate`] = "";
    tokens[`positions.previous${positionNum}.tenure`] = "";
    tokens[`positions.previous${positionNum}.duration`] = "";
    tokens[`positions.previous${positionNum}.description`] = "";
  }

  if (previousPositions.length > 0) {
    tokens["positions.hasPrevious"] = "true";
    tokens["positions.firstPrevious"] = previousPositions[0].title;
    tokens["positions.lastPrevious"] =
      previousPositions[previousPositions.length - 1].title;
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

      const columnStyle =
        columns > 1
          ? `column-count: ${columns}; column-gap: ${columnGap}px;`
          : "";

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

  .el {
    -webkit-column-count: inherit;
    -moz-column-count: inherit;
    column-count: inherit;
    -webkit-column-gap: inherit;
    -moz-column-gap: inherit;
    column-gap: inherit;
  }

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

async function generateDocumentPDF(
  employeeId,
  docType,
  templateId = "",
  ownerId
) {
  const emp = await Employee.findById(employeeId).lean();
  if (!emp) throw new Error("Employee not found");

  // Find template - prioritize user's template, fall back to global
  let tpl;
  if (templateId) {
    tpl = await DocTemplate.findOne({
      _id: templateId,
      $or: [{ owner: ownerId }, { isGlobal: true }],
    }).lean();
  } else {
    tpl = await DocTemplate.findOne({
      type: normType(docType),
      $or: [{ owner: ownerId }, { isGlobal: true }],
    })
      .sort({ isGlobal: 1 })
      .lean(); // Prefer user templates over global
  }

  if (!tpl) throw new Error("Template not found");

  const defaults = tpl.defaultValues || {};
  const normalizedDocType = normType(docType);
  const tokens = await tokenMap(emp, defaults, normalizedDocType, ownerId);
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
   BULK DOCUMENT DOWNLOAD API
────────────────────────────────────────────────────────────────────────────── */

// Bulk document download - combines multiple employee documents into one PDF
router.post("/bulk/:docType", async (req, res) => {
  try {
    const { docType } = req.params;
    const { employeeIds, key } = req.body || {};

    if (
      !employeeIds ||
      !Array.isArray(employeeIds) ||
      employeeIds.length === 0
    ) {
      return res.status(400).json({
        message: "employeeIds array is required with at least one employee ID",
      });
    }

    // Validate document type
    const validDocTypes = [
      "nda",
      "contract",
      "salary-certificate",
      "experience-letter",
    ];
    if (!validDocTypes.includes(docType)) {
      return res.status(400).json({
        message: `Invalid document type. Valid types are: ${validDocTypes.join(
          ", "
        )}`,
      });
    }

    // For contract and salary-certificate, key is required
    if ((docType === "contract" || docType === "salary-certificate") && !key) {
      return res.status(400).json({
        message: `Decryption key is required for ${docType}`,
      });
    }

    console.log(
      `Processing bulk ${docType} download for ${employeeIds.length} employees`
    );

    // Get all employees at once
    const employees = await Employee.find({
      _id: { $in: employeeIds },
      owner: req.ownerId,
    }).lean();

    if (employees.length === 0) {
      return res.status(404).json({
        message: "No employees found with the provided IDs",
      });
    }

    // Find template
    let tpl;
    const normalizedDocType = normType(docType);
    tpl = await DocTemplate.findOne({
      type: normalizedDocType,
      $or: [{ owner: req.ownerId }, { isGlobal: true }],
    })
      .sort({ isGlobal: 1 })
      .lean();

    if (!tpl) {
      return res.status(404).json({
        message: `Template not found for ${docType}`,
      });
    }

    const defaults = tpl.defaultValues || {};
    const pages = extractAllPages(tpl.canvas || {});
    if (pages.length === 0) {
      return res.status(400).json({
        message: "No pages found in template",
      });
    }

    // Launch browser once for all employees
    const browser = await puppeteer.launch({
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    try {
      const mergedPdf = await PDFDocument.create();

      // Process each employee
      for (const emp of employees) {
        console.log(`Processing employee: ${emp.name} (${emp._id})`);

        const tokens = await tokenMap(
          emp,
          defaults,
          normalizedDocType,
          req.ownerId
        );

        // For each page in the template, generate for this employee
        for (const page of pages) {
          const p = await browser.newPage();
          await p.setViewport({ width: page.widthPx, height: page.heightPx });

          const html = generateSinglePageHTML(page, tokens, pages.length);
          await p.setContent(html, { waitUntil: "networkidle0" });
          await p.emulateMediaType("screen");

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

        // REMOVED: Blank page between employees - documents will now flow immediately
        // if (employees.indexOf(emp) < employees.length - 1) {
        //   const blankPage = mergedPdf.addPage([pages[0].widthPx, pages[0].heightPx]);
        // }
      }

      const mergedPdfBytes = await mergedPdf.save();
      const pdfBuffer = Buffer.from(mergedPdfBytes);

      // Set response headers
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="bulk-${docType}-${
          new Date().toISOString().split("T")[0]
        }.pdf"`
      );

      console.log(
        `Bulk ${docType} PDF generated successfully for ${employees.length} employees`
      );
      res.status(200).end(pdfBuffer);
    } finally {
      await browser.close();
    }
  } catch (err) {
    console.error(`Error in bulk ${req.params.docType} download:`, err);

    if (!res.headersSent) {
      res.status(500).json({
        message:
          err.message || `Failed to generate bulk ${req.params.docType} PDF`,
      });
    }
  }
});

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
      templateId,
      req.ownerId
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

    const pdf = await generateDocumentPDF(
      employeeId,
      "nda",
      templateId,
      req.ownerId
    );

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
      templateId,
      req.ownerId
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

// Salary Certificate (POST)
router.post("/salary-certificate/:employeeId", async (req, res) => {
  try {
    const { employeeId } = req.params;
    const { key } = req.body || {};
    const templateId = String(req.query.templateId || "");

    const pdf = await generateDocumentPDF(
      employeeId,
      "salary_certificate",
      templateId,
      req.ownerId
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

    const pdf = await generateDocumentPDF(
      employeeId,
      "contract",
      templateId,
      req.ownerId
    );

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

// GET for contract
router.get("/contract/:employeeId", async (req, res) => {
  try {
    const { employeeId } = req.params;
    const templateId = String(req.query.templateId || "");

    const pdf = await generateDocumentPDF(
      employeeId,
      "contract",
      templateId,
      req.ownerId
    );

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

// Preview reference number without incrementing
router.get("/reference-preview/:docType", async (req, res) => {
  try {
    const docType = normType(req.params.docType);
    const referenceNumber = await getCurrentReferenceNumber(
      docType,
      req.ownerId
    );

    res.json({
      ok: true,
      referenceNumber,
      docType,
      preview: true,
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

    const counters = await ReferenceCounter.find({
      docType: docType,
      owner: req.ownerId,
    })
      .sort({ yearMonth: -1, sequence: -1 })
      .limit(limit)
      .lean();

    const history = counters.map((counter) => {
      const sequenceStr = String(counter.sequence).padStart(2, "0");
      const docCode = getDocTypeCode(docType);
      const month = counter.yearMonth.substring(0, 2);
      const year = counter.yearMonth.substring(2);
      const date = `01${month}${year}`;

      return {
        referenceNumber: `MA${sequenceStr}-${docCode}-${date}`,
        generatedAt: counter.lastGenerated,
        sequence: counter.sequence,
        yearMonth: counter.yearMonth,
        timezone: counter.timezone || "UTC",
      };
    });

    res.json({
      ok: true,
      history,
      docType,
      docName: getDocTypeName(docType),
      ownerId: req.ownerId,
    });
  } catch (err) {
    console.error("reference-history error:", err);
    res.status(500).json({ message: "Failed to fetch reference history" });
  }
});

/* ─────────────────────────────────────────────────────────────
   OWNER-SPECIFIC TEMPLATES — BY TYPE
──────────────────────────────────────────────────────────────── */
router.get("/doc-templates/:type", async (req, res) => {
  try {
    const type = normType(req.params.type);

    // First try to get user's template
    let tpl = await DocTemplate.findOne({
      type: type,
      owner: req.ownerId,
    }).lean();

    // If user doesn't have a template, get global template
    if (!tpl) {
      tpl = await DocTemplate.findOne({
        type: type,
        isGlobal: true,
      }).lean();
    }

    if (!tpl) return res.status(200).json({ data: null });

    res.json({
      data: {
        canvas: tpl.canvas,
        defaultValues: tpl.defaultValues || {},
        type: tpl.type,
        docTypeName: getDocTypeName(tpl.type),
        docTypeCode: getDocTypeCode(tpl.type),
        owner: tpl.owner,
        isGlobal: tpl.isGlobal || false,
        name: tpl.name || "Untitled Template",
      },
    });
  } catch (err) {
    console.error("Error loading doc template:", err);
    res.status(500).json({ message: "Failed to load by type" });
  }
});

router.post("/doc-templates/:type", async (req, res) => {
  try {
    const type = normType(req.params.type);
    const { canvas, defaultValues, name, isGlobal } = req.body || {};

    if (!canvas) return res.status(400).json({ message: "canvas is required" });

    // Check if a template already exists for this user and type
    const existingTemplate = await DocTemplate.findOne({
      type: type,
      owner: req.ownerId,
    });

    let up;
    if (existingTemplate) {
      // Update existing template
      up = await DocTemplate.findOneAndUpdate(
        {
          _id: existingTemplate._id,
          owner: req.ownerId,
        },
        {
          $set: {
            canvas,
            defaultValues: defaultValues || {},
            name: name || "Untitled Template",
            isGlobal: isGlobal || false,
          },
        },
        {
          new: true,
        }
      ).lean();
    } else {
      // Create new template
      up = await DocTemplate.create({
        type: type,
        canvas,
        defaultValues: defaultValues || {},
        name: name || "Untitled Template",
        owner: req.ownerId,
        isGlobal: isGlobal || false,
      });
    }

    res.json({
      ok: true,
      data: {
        canvas: up.canvas,
        defaultValues: up.defaultValues || {},
        type: up.type,
        docTypeName: getDocTypeName(up.type),
        docTypeCode: getDocTypeCode(up.type),
        owner: up.owner,
        isGlobal: up.isGlobal || false,
        name: up.name || "Untitled Template",
      },
    });
  } catch (err) {
    console.error("Error saving doc template:", err);

    // Check for duplicate key error specifically
    if (err.code === 11000) {
      return res.status(400).json({
        message:
          "A template with this type already exists. Please update the existing template instead.",
        code: "DUPLICATE_TEMPLATE",
      });
    }

    res.status(500).json({ message: "Failed to save by type" });
  }
});

/* ─────────────────────────────────────────────────────────────
   OWNER-SPECIFIC TEMPLATES — ID-BASED CRUD
──────────────────────────────────────────────────────────────── */
router.get("/templates", async (req, res) => {
  try {
    const rows = await DocTemplate.find(
      {
        $or: [{ owner: req.ownerId }, { isGlobal: true }],
      },
      { canvas: 1, type: 1, updatedAt: 1, owner: 1, isGlobal: 1, name: 1 }
    )
      .sort({ isGlobal: 1, updatedAt: -1 })
      .lean();

    const data = rows.map((r) => ({
      _id: String(r._id),
      type: r.type,
      typeName: getDocTypeName(r.type),
      typeCode: getDocTypeCode(r.type),
      name: r.name || r.canvas?.name || "Untitled Document",
      updatedAt: r.updatedAt,
      owner: r.owner,
      isOwner: String(r.owner) === String(req.ownerId),
      isGlobal: r.isGlobal || false,
    }));

    res.json({ data });
  } catch (err) {
    console.error("Error fetching templates:", err);
    res.status(500).json({ message: "Failed to fetch templates" });
  }
});

router.get("/templates/:id", async (req, res) => {
  try {
    const tpl = await DocTemplate.findOne({
      _id: req.params.id,
      $or: [{ owner: req.ownerId }, { isGlobal: true }],
    }).lean();

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
        owner: tpl.owner,
        isOwner: String(tpl.owner) === String(req.ownerId),
        isGlobal: tpl.isGlobal || false,
        name: tpl.name || "Untitled Template",
      },
    });
  } catch (err) {
    console.error("Error loading template:", err);
    res.status(500).json({ message: "Failed to load template" });
  }
});

// Use POST /templates instead of POST /doc-templates/:type
router.post("/templates", async (req, res) => {
  try {
    const { type, canvas, defaultValues, name, isGlobal } = req.body || {};

    if (!type || !canvas) {
      return res
        .status(400)
        .json({ message: "`type` and `canvas` are required" });
    }

    // Add a suffix to make it unique per user
    const uniqueType = `${type}_${req.ownerId.substring(0, 8)}`;

    const doc = await DocTemplate.create({
      type: uniqueType, // Use unique type
      canvas,
      defaultValues: defaultValues || {},
      name: name || "Untitled Template",
      owner: req.ownerId,
      isGlobal: isGlobal || false,
    });

    res.status(201).json({
      ok: true,
      id: String(doc._id),
      typeName: getDocTypeName(type), // Return original type name for display
      typeCode: getDocTypeCode(type),
      owner: doc.owner,
      isGlobal: doc.isGlobal,
    });
  } catch (err) {
    console.error("Error creating template:", err);
    res.status(500).json({ message: "Failed to create template" });
  }
});
router.put("/templates/:id", async (req, res) => {
  try {
    const { canvas, defaultValues, type, name, isGlobal } = req.body || {};
    const set = {};

    if (type) set.type = type;
    if (canvas) set.canvas = canvas;
    if (defaultValues) set.defaultValues = defaultValues;
    if (name !== undefined) set.name = name;
    if (isGlobal !== undefined) set.isGlobal = isGlobal;

    const up = await DocTemplate.findOneAndUpdate(
      {
        _id: req.params.id,
        owner: req.ownerId, // Only owner can update their templates
      },
      { $set: set },
      { new: true }
    ).lean();

    if (!up)
      return res
        .status(404)
        .json({ message: "Template not found or not authorized" });

    res.json({
      ok: true,
      typeName: getDocTypeName(up.type),
      typeCode: getDocTypeCode(up.type),
      owner: up.owner,
      isGlobal: up.isGlobal,
    });
  } catch (err) {
    console.error("Error updating template:", err);
    res.status(500).json({ message: "Failed to update template" });
  }
});

router.delete("/templates/:id", async (req, res) => {
  try {
    const del = await DocTemplate.findOneAndDelete({
      _id: req.params.id,
      owner: req.ownerId, // Only owner can delete their templates
    }).lean();

    if (!del)
      return res
        .status(404)
        .json({ message: "Template not found or not authorized" });

    res.json({ ok: true });
  } catch (err) {
    console.error("Error deleting template:", err);
    res.status(500).json({ message: "Failed to delete template" });
  }
});

// Duplicate a template (create a copy)
router.post("/templates/:id/duplicate", async (req, res) => {
  try {
    const original = await DocTemplate.findOne({
      _id: req.params.id,
      $or: [{ owner: req.ownerId }, { isGlobal: true }],
    }).lean();

    if (!original)
      return res.status(404).json({ message: "Template not found" });

    const newTemplate = await DocTemplate.create({
      type: original.type,
      canvas: original.canvas,
      defaultValues: original.defaultValues || {},
      name: `${original.name || "Untitled Template"} (Copy)`,
      owner: req.ownerId,
      isGlobal: false, // Duplicates are always user-specific
    });

    res.status(201).json({
      ok: true,
      id: String(newTemplate._id),
      typeName: getDocTypeName(newTemplate.type),
      typeCode: getDocTypeCode(newTemplate.type),
      owner: newTemplate.owner,
      isGlobal: newTemplate.isGlobal,
    });
  } catch (err) {
    console.error("Error duplicating template:", err);
    res.status(500).json({ message: "Failed to duplicate template" });
  }
});

module.exports = router;
