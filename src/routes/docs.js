const express = require("express");
const router = express.Router();
const { withPage } = require("../utils/browserPool");
const { PDFDocument } = require("pdf-lib");
const path = require("path");
const fs = require("fs");

const Employee = require("../models/Employees");
const User = require("../models/Users");
const Salary = require("../models/Salaries");
const SalarySlip = require("../models/SalarySlip");
const DocTemplate = require("../models/DocTemplate");
const ReferenceCounter = require("../models/ReferenceCounter");
const Settings = require("../models/Settings");
const Certificate = require("../models/Certificate");
const { decrypt, encrypt } = require("../utils/encryption");

/* ───────────────── helpers ───────────────── */

const TYPE_ALIASES = {
  "experience-letter": "experience_letter",
  "salary-certificate": "salary_certificate",
  "salary-slip": "salary_slip",
  nda: "nda",
  contract: "contract",
  "employee-cover-page": "employee_cover_page",
};

const normType = (t = "") => TYPE_ALIASES[t] || t.replace(/-/g, "_");
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const pxToMm = (px) => (Number(px || 0) * 25.4) / 96; // 96dpi

// Ensure uploads directory exists
const UPLOAD_DIR = path.join(process.cwd(), "uploads");
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// Ensure documents subdirectory exists
const DOCUMENTS_DIR = path.join(UPLOAD_DIR, "documents");
if (!fs.existsSync(DOCUMENTS_DIR)) {
  fs.mkdirSync(DOCUMENTS_DIR, { recursive: true });
}

// Function to save document to uploads folder
const saveDocumentToFile = async (
  pdfBuffer,
  employeeId,
  docType,
  ownerId,
  referenceNumber
) => {
  try {
    // Create owner-specific directory
    const ownerDir = path.join(DOCUMENTS_DIR, String(ownerId));
    if (!fs.existsSync(ownerDir)) {
      fs.mkdirSync(ownerDir, { recursive: true });
    }

    // Create document type directory
    const typeDir = path.join(ownerDir, docType);
    if (!fs.existsSync(typeDir)) {
      fs.mkdirSync(typeDir, { recursive: true });
    }

    // Generate filename
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const safeEmployeeId = String(employeeId).replace(/[^a-zA-Z0-9]/g, "_");
    const safeReference = (referenceNumber || "").replace(
      /[^a-zA-Z0-9-_]/g,
      "_"
    );

    const filename = `${safeReference || timestamp}_${safeEmployeeId}.pdf`;
    const filepath = path.join(typeDir, filename);

    // Save the file
    await fs.promises.writeFile(filepath, pdfBuffer);

    // Return the relative path for database storage
    const relativePath = path.relative(process.cwd(), filepath);

    return {
      success: true,
      filepath: relativePath,
      filename: filename,
      fullPath: filepath,
      url: `/uploads/documents/${ownerId}/${docType}/${filename}`,
    };
  } catch (error) {
    console.error("Error saving document to file:", error);
    return {
      success: false,
      error: error.message,
    };
  }
};

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
    employee_cover_page: "ECP",
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
    employee_cover_page: "Employee Cover Page",
  };
  return typeNames[docType] || "Document";
}

// Auto-incrementing reference number generator with daily reset and timezone
async function generateReferenceNumber(docType = "experience_letter", ownerId) {
  try {
    const timezone = await getUserTimezone(ownerId);
    const SHARED_DOC_TYPES = [
      "experience_letter",
      "salary_certificate",
      "nda",
      "contract",
      "employee_cover_page",
    ];

    const counterDocType = SHARED_DOC_TYPES.includes(docType)
      ? "employment_document"
      : docType;

    const docCode = getDocTypeCode(docType);
    const yearMonth = getCurrentYearMonth(timezone);
    const currentDateDDMMYYYY = formatDateDDMMYYYY(new Date(), timezone);
    const currentDate = getCurrentDateString(timezone);

    let counter = await ReferenceCounter.findOne({
      docType: counterDocType,
      yearMonth: yearMonth,
      owner: ownerId,
    });

    let shouldReset = false;

    if (counter) {
      const lastGeneratedDate = counter.lastGeneratedDate || (counter.lastGenerated
        ? formatDateYYYYMMDD(counter.lastGenerated, timezone)
        : null);

      if (lastGeneratedDate && lastGeneratedDate !== currentDate) {
        shouldReset = true;
      }
    } else {
      shouldReset = true;
    }

    if (shouldReset) {
      counter = await ReferenceCounter.findOneAndUpdate(
        {
          docType: counterDocType,
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
          docType: counterDocType,
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
    const SHARED_DOC_TYPES = [
      "experience_letter",
      "salary_certificate",
      "nda",
      "contract",
      "employee_cover_page",
    ];

    const counterDocType = SHARED_DOC_TYPES.includes(docType)
      ? "employment_document"
      : docType;

    const docCode = getDocTypeCode(docType);
    const yearMonth = getCurrentYearMonth(timezone);
    const currentDateDDMMYYYY = formatDateDDMMYYYY(new Date(), timezone);
    const currentDate = getCurrentDateString(timezone);

    const counter = await ReferenceCounter.findOne({
      docType: counterDocType,
      yearMonth: yearMonth,
      owner: ownerId,
    });

    let sequence = 1;

    if (counter) {
      const lastGeneratedDate = counter.lastGeneratedDate || (counter.lastGenerated
        ? formatDateYYYYMMDD(counter.lastGenerated, timezone)
        : null);

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

// Fetch certificates for an employee and return by type with url and filename
async function fetchEmployeeCertificates(employeeId) {
  const empty = { url: "", name: "" };
  if (!employeeId) return { matric: { ...empty }, inter: { ...empty }, graduate: { ...empty }, masters: { ...empty } };

  try {
    const rows = await Certificate.find({ employee: employeeId }).lean();
    const map = { matric: { ...empty }, inter: { ...empty }, graduate: { ...empty }, masters: { ...empty } };
    for (const r of rows) {
      if (r && r.type) {
        const url = r.fileUrl || "";
        const name = url ? path.basename(url) : "";
        if (map[r.type]) map[r.type] = { url, name };
      }
    }
    return map;
  } catch (err) {
    console.error("Error fetching certificates:", err);
    return { matric: { ...empty }, inter: { ...empty }, graduate: { ...empty }, masters: { ...empty } };
  }
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
async function resolveSignerContext(ownerId, authUser = null) {
  const fromAuth = {
    _id: authUser?.employeeId || authUser?._id || "",
    name: authUser?.employeeName || authUser?.name || authUser?.username || "",
    email: authUser?.email || authUser?.companyEmail || "",
    designation: authUser?.designation || authUser?.employeeRole || authUser?.role || "",
    department: authUser?.department || "",
    role: authUser?.role || authUser?.userRole || "",
  };

  if (fromAuth.name || fromAuth.designation) return fromAuth;

  try {
    const ownerUser = await User.findById(ownerId)
      .select("username name email role")
      .lean();
    if (ownerUser) {
      return {
        _id: ownerUser._id,
        name: ownerUser.name || ownerUser.username || "",
        email: ownerUser.email || "",
        designation: ownerUser.role || "",
        department: "",
        role: ownerUser.role || "",
      };
    }
  } catch (err) {
    console.error("Error resolving document signer:", err.message);
  }

  return {};
}
async function tokenMap(
  emp,
  defaults = {},
  docType = "experience_letter",
  ownerId,
  options = {}
) {
  const decryptedSalary = await fetchAndDecryptSalary(emp?._id);
  const signer = options.signer || (await resolveSignerContext(ownerId));
  const signerName = signer.name || signer.username || defaults.signName || "ADEEL SHAIKH";
  const signerTitle = signer.designation || signer.title || signer.role || defaults.signTitle || "CHIEF EXECUTIVE OFFICER";

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

  const referenceNumber = options.referenceNumber || (await generateReferenceNumber(docType, ownerId));
  const nextReferenceNumber = options.nextReferenceNumber || (await getCurrentReferenceNumber(docType, ownerId));
  const currentDate = formatDateDDMMYYYY(new Date(), timezone);
  const docTypeCode = getDocTypeCode(docType);
  const docTypeName = getDocTypeName(docType);

  const tokens = {
    "company.name": defaults.companyName || "Mavens Advisor Pvt. Ltd.",
    "company.address": defaults.companyAddress || "",
    "contact.phone": defaults.contactPhone || "+1 (615) 988-0800",
    "sign.name": signerName,
    "sign.title": signerTitle,
    "signature.name": signerName,
    "signature.designation": signerTitle,
    "signature.title": signerTitle,
    "signature.department": signer.department || "",
    "signature.email": signer.email || "",
    "signature.role": signer.role || "",

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
    // Employment period phrase: past employees get an explicit range, current
    // employees just get "since <joining date>".
    "dates.period": emp?.leavingDate
      ? `from ${fmtDate(emp.joiningDate, timezone)} till ${fmtDate(
          emp.leavingDate,
          timezone
        )}`
      : `since ${fmtDate(emp?.joiningDate, timezone)}`,
    "dates.timezone": timezone,
    "tenure.human": tenureHuman,
    "tenure.monthsTotal": tenureMonthsTotal,

    "employee.name": emp?.name || "—",
    // System-generated, human-readable employee ID (e.g. "EMP001"). Falls back
    // to the Mongo _id only for legacy records that never got an employeeId.
    "employee.id": emp?.employeeId || (emp?._id ? String(emp._id) : ""),
    "employee.employeeId": emp?.employeeId || (emp?._id ? String(emp._id) : ""),
    "employee.cnic": emp?.cnic || "—",
    "employee.nationality": emp?.nationality || "—",
    "employee.designation": emp?.designation || emp?.position || "—",
    "employee.department": emp?.department || "—",
    "employee.position": emp?.position || emp?.designation || "—",
    "employee.email": emp?.email || "—",
    "employee.phone": emp?.phone || "—",
    "employee.address": emp?.presentAddress || emp?.permanentAddress || "—",
    // certificate file names and urls (may be relative paths like "/uploads/...")
    "employee.cert.matric": "",
    "employee.cert.matricUrl": "",
    "employee.cert.inter": "",
    "employee.cert.interUrl": "",
    "employee.cert.graduate": "",
    "employee.cert.graduateUrl": "",
    "employee.cert.masters": "",
    "employee.cert.mastersUrl": "",
    "employee.cert.list": "",
    "employee.cert.listArray": "",

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

  // Populate certificate tokens
  try {
    const certs = await fetchEmployeeCertificates(emp?._id);
    tokens["employee.cert.matric"] = certs.matric?.name || "";
    tokens["employee.cert.matricUrl"] = certs.matric?.url || "";
    tokens["employee.cert.inter"] = certs.inter?.name || "";
    tokens["employee.cert.interUrl"] = certs.inter?.url || "";
    tokens["employee.cert.graduate"] = certs.graduate?.name || "";
    tokens["employee.cert.graduateUrl"] = certs.graduate?.url || "";
    tokens["employee.cert.masters"] = certs.masters?.name || "";
    tokens["employee.cert.mastersUrl"] = certs.masters?.url || "";
    // build comma-separated list and array of submitted certificate types (friendly names)
    const submitted = [];
    if (certs.matric?.name) submitted.push("matric");
    if (certs.inter?.name) submitted.push("inter");
    if (certs.graduate?.name) submitted.push("graduate");
    if (certs.masters?.name) submitted.push("masters");

    tokens["employee.cert.list"] = submitted.join(", ");
    tokens["employee.cert.listArray"] = JSON.stringify(submitted);
  } catch (err) {
    console.error("Error populating certificate tokens:", err);
  }

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
  // The rich-text builder can split a token across tags (e.g.
  // "{{</span><span>dates.end}}") and insert &nbsp; inside it, which the
  // token regex below can't match. Strip tags/entities found inside {{ }}.
  const normalized = String(html).replace(/\{\{[^{}]*\}\}/g, (m) =>
    m.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ")
  );
  return normalized.replace(
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

      // Render table elements specially
      if (String(el.type).toLowerCase() === "table") {
        const data = Array.isArray(el.data) ? el.data : [];
        const colWidths = Array.isArray(el.columnWidths) ? el.columnWidths : [];
        const rowHeights = Array.isArray(el.rowHeights) ? el.rowHeights : [];
        const cellAlignments = (el.cellAlignments && typeof el.cellAlignments === "object") ? el.cellAlignments : {};
        // Fixed column count so every row (including intentionally empty
        // header rows) reserves the full width — otherwise an empty row
        // collapses to zero height and overlaid title text overlaps the
        // first data row.
        const colCount =
          num(el.cols, 0) ||
          data.reduce((m, r) => Math.max(m, Array.isArray(r) ? r.length : 0), 0) ||
          colWidths.length ||
          1;

        const colgroup = colWidths.length
          ? `<colgroup>${colWidths
              .map((cw) => `<col style="width:${num(cw)}px;" />`)
              .join("")}</colgroup>`
          : "";

        const rowsHtml = data
          .map((row, rIndex) => {
            const cells = Array.isArray(row) ? row : [];
            // Keep empty/short rows at their designed height so overlaid
            // elements line up (matches the builder canvas).
            const rowH = num(rowHeights[rIndex], 0) || 32;

            let tds;
            if (cells.length === 0) {
              // Intentionally empty row (e.g. a spanning title header). Render a
              // single cell spanning every column so there is NO internal
              // vertical divider, and reserve its height so it doesn't collapse.
              const align = cellAlignments[`${rIndex}-0`] || el.align || "left";
              tds = `<td colspan="${colCount}" style="padding:6px 8px;border:1px solid #000;vertical-align:top;text-align:${align};">&nbsp;</td>`;
            } else {
              tds = cells
                .map((cell, cIndex) => {
                  // If a row has fewer cells than the table's column count, let
                  // the last cell span the remaining columns (no stray divider).
                  const isLast = cIndex === cells.length - 1;
                  const span =
                    isLast && cells.length < colCount
                      ? ` colspan="${colCount - cells.length + 1}"`
                      : "";
                  const align =
                    cellAlignments[`${rIndex}-${cIndex}`] || el.align || "left";
                  const cellHtml = applyTokens(cell ?? "", tokens);
                  return `<td${span} style="padding:6px 8px;border:1px solid #000;vertical-align:top;text-align:${align};">${cellHtml}</td>`;
                })
                .join("");
            }
            return `<tr style="height:${rowH}px;">${tds}</tr>`;
          })
          .join("");

        return `<div class="el" style="position:absolute;left:${x}px;top:${y}px;width:${w}px;height:${h}px;overflow:visible;">
            <table style="width:100%;table-layout:fixed;border-collapse:collapse;border-spacing:0;border:2px solid #000;color:${color};font-family:'${escCss(ff)}',sans-serif;font-size:${fs}px;line-height:${lineHeight};">
              ${colgroup}
              ${rowsHtml}
            </table>
          </div>`;
      }

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
  ownerId,
  precomputedTokens = null,
  referenceNumber = null,
  signerContext = null
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
  const tokens =
    precomputedTokens ||
    (await tokenMap(emp, defaults, normalizedDocType, ownerId, {
      referenceNumber,
      signer: signerContext,
    }));
  const pages = extractAllPages(tpl.canvas || {});
  if (pages.length === 0) throw new Error("No pages found in template");

  const mergedPdf = await PDFDocument.create();

  for (const page of pages) {
    const pdfBuffer = await withPage(async (p) => {
      await p.setViewport({ width: page.widthPx, height: page.heightPx });

      const html = generateSinglePageHTML(page, tokens, pages.length);
      await p.setContent(html, { waitUntil: "networkidle0" });
      await p.emulateMediaType("screen");

      const headerMm = pxToMm(page.header);
      const footerMm = pxToMm(page.footer);

      return p.pdf({
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
    });

    const tempPdf = await PDFDocument.load(pdfBuffer);
    const [copiedPage] = await mergedPdf.copyPages(tempPdf, [0]);
    mergedPdf.addPage(copiedPage);
  }

  const mergedPdfBytes = await mergedPdf.save();
  return Buffer.from(mergedPdfBytes);
}

/* ──────────────────────────────────────────────────────────────────────────────
   PDF ENDPOINTS FOR ALL DOCUMENT TYPES WITH FILE SAVING
────────────────────────────────────────────────────────────────────────────── */

// Helper function to handle document generation and saving
const generateAndSaveDocument = async (req, res, docType) => {
  try {
    const { employeeId } = req.params;
    const templateId = String(req.query.templateId || "");
    const { key } = req.body || {};

    const normalizedDocType = normType(docType);

    // 1. Generate reference number FIRST to avoid double increment
    const referenceNumber = await generateReferenceNumber(
      normalizedDocType,
      req.ownerId
    );

    const signerContext = await resolveSignerContext(req.ownerId, req.user);

    // 2. Generate the PDF using this reference number
    const pdfBuffer = await generateDocumentPDF(
      employeeId,
      docType,
      templateId,
      req.ownerId,
      null, // precomputedTokens
      referenceNumber, // Pass the reference number here
      signerContext
    );

    // Save to file system
    const saveResult = await saveDocumentToFile(
      pdfBuffer,
      employeeId,
      normalizedDocType,
      req.ownerId,
      referenceNumber
    );

    if (!saveResult.success) {
      console.error("Failed to save document:", saveResult.error);
      // Still send the PDF even if saving fails
    } else {
      console.log(`Document saved to: ${saveResult.filepath}`);
      console.log(`Document URL: ${saveResult.url}`);

      // TODO: Optionally save document info to database
      // You could create a DocumentLog model to track generated documents
    }

    // Set response headers
    const docTypeName = getDocTypeName(normalizedDocType);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${docTypeName}_${referenceNumber}.pdf"`
    );

    // Send the PDF
    res.status(200).end(pdfBuffer);
  } catch (err) {
    console.error(`${docType} pdf error:`, err);
    if (!res.headersSent) {
      res.status(500).json({
        message: err.message || `Failed to generate ${docType} PDF`,
      });
    }
  }
};

// Experience Letter
router.get("/experience-letter/:employeeId", async (req, res) => {
  await generateAndSaveDocument(req, res, "experience_letter");
});

// NDA
router.get("/nda/:employeeId", async (req, res) => {
  await generateAndSaveDocument(req, res, "nda");
});

// Salary Certificate
router.get("/salary-certificate/:employeeId", async (req, res) => {
  await generateAndSaveDocument(req, res, "salary_certificate");
});

// Salary Certificate (POST)
router.post("/salary-certificate/:employeeId", async (req, res) => {
  await generateAndSaveDocument(req, res, "salary_certificate");
});

// Contract (POST)
router.post("/contract/:employeeId", async (req, res) => {
  await generateAndSaveDocument(req, res, "contract");
});

// Contract (GET)
router.get("/contract/:employeeId", async (req, res) => {
  await generateAndSaveDocument(req, res, "contract");
});

// Employee Cover Page (GET)
router.get("/employee-cover-page/:employeeId", async (req, res) => {
  await generateAndSaveDocument(req, res, "employee_cover_page");
});

// Employee Cover Page (POST)
router.post("/employee-cover-page/:employeeId", async (req, res) => {
  await generateAndSaveDocument(req, res, "employee_cover_page");
});

/* ──────────────────────────────────────────────────────────────────────────────
   BULK DOCUMENT DOWNLOAD API WITH FILE SAVING
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
      "employee-cover-page",
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

    // Generate bulk reference numbers for all employees
    const timezone = await getUserTimezone(req.ownerId);
    const docCode = getDocTypeCode(normalizedDocType);
    const yearMonth = getCurrentYearMonth(timezone);
    const currentDateDDMMYYYY = formatDateDDMMYYYY(new Date(), timezone);
    const currentDate = getCurrentDateString(timezone);

    const SHARED_DOC_TYPES = [
      "experience_letter",
      "salary_certificate",
      "nda",
      "contract",
      "employee_cover_page",
    ];

    const counterDocType = SHARED_DOC_TYPES.includes(normalizedDocType)
      ? "employment_document"
      : normalizedDocType;

    // Get or create counter for bulk generation
    let counter = await ReferenceCounter.findOne({
      docType: counterDocType,
      yearMonth: yearMonth,
      owner: req.ownerId,
    });

    let shouldReset = false;

    if (counter) {
      const lastGeneratedDate = counter.lastGeneratedDate || (counter.lastGenerated
        ? formatDateYYYYMMDD(counter.lastGenerated, timezone)
        : null);

      if (lastGeneratedDate && lastGeneratedDate !== currentDate) {
        shouldReset = true;
      }
    } else {
      shouldReset = true;
    }

    // Start sequence for bulk generation
    let startSequence = 1;

    if (shouldReset) {
      counter = await ReferenceCounter.findOneAndUpdate(
        {
          docType: counterDocType,
          yearMonth: yearMonth,
          owner: req.ownerId,
        },
        {
          $set: {
            sequence: employees.length, // Set to total employees count
            lastGenerated: new Date(),
            lastGeneratedDate: currentDate,
            timezone: timezone,
            owner: req.ownerId,
          },
        },
        {
          upsert: true,
          new: true,
          setDefaultsOnInsert: true,
        }
      );
      startSequence = 1;
    } else {
      // Get current sequence and update for all employees
      const currentSequence = counter.sequence || 0;
      startSequence = currentSequence + 1;

      counter = await ReferenceCounter.findOneAndUpdate(
        {
          docType: counterDocType,
          yearMonth: yearMonth,
          owner: req.ownerId,
        },
        {
          $inc: { sequence: employees.length },
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

    {
      const mergedPdf = await PDFDocument.create();
      const allReferenceNumbers = [];
      const signerContext = await resolveSignerContext(req.ownerId, req.user);

      // Process each employee with sequential reference numbers
      for (let i = 0; i < employees.length; i++) {
        const emp = employees[i];
        const sequenceNumber = startSequence + i;
        const sequenceStr = String(sequenceNumber).padStart(2, "0");
        const referenceNumber = `MA${sequenceStr}-${docCode}-${currentDateDDMMYYYY}`;
        allReferenceNumbers.push(referenceNumber);

        console.log(
          `Processing employee ${i + 1}/${employees.length}: ${
            emp.name
          } (Reference: ${referenceNumber})`
        );

        const nextReferenceNumber = `MA${String(
          sequenceNumber + 1
        ).padStart(2, "0")}-${docCode}-${currentDateDDMMYYYY}`;

        // Create custom tokens for this employee with proper reference number
        const tokens = await tokenMap(
          emp,
          defaults,
          normalizedDocType,
          req.ownerId,
          { referenceNumber, nextReferenceNumber, signer: signerContext }
        );

        // For each page in the template, generate for this employee
        for (const page of pages) {
          const pdfBuffer = await withPage(async (p) => {
            await p.setViewport({ width: page.widthPx, height: page.heightPx });

            const html = generateSinglePageHTML(page, tokens, pages.length);
            await p.setContent(html, { waitUntil: "networkidle0" });
            await p.emulateMediaType("screen");

            const headerMm = pxToMm(page.header);
            const footerMm = pxToMm(page.footer);

            return p.pdf({
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
          });

          const tempPdf = await PDFDocument.load(pdfBuffer);
          const [copiedPage] = await mergedPdf.copyPages(tempPdf, [0]);
          mergedPdf.addPage(copiedPage);
        }

        // Save individual document for each employee
        const individualPdf = await generateDocumentPDF(
          emp._id,
          normalizedDocType,
          tpl._id,
          req.ownerId,
          tokens
        );

        const saveResult = await saveDocumentToFile(
          individualPdf,
          emp._id,
          normalizedDocType,
          req.ownerId,
          referenceNumber
        );

        if (saveResult.success) {
          console.log(
            `Individual document saved for ${emp.name}: ${saveResult.filepath}`
          );
        }
      }

      const mergedPdfBytes = await mergedPdf.save();
      const pdfBuffer = Buffer.from(mergedPdfBytes);

      // Save bulk document as well
      const bulkReference = `BULK_${docCode}_${currentDateDDMMYYYY}`;
      const bulkSaveResult = await saveDocumentToFile(
        pdfBuffer,
        "bulk",
        normalizedDocType,
        req.ownerId,
        bulkReference
      );

      if (bulkSaveResult.success) {
        console.log(`Bulk document saved: ${bulkSaveResult.filepath}`);
      }

      // Set response headers
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="bulk-${docType}-${
          new Date().toISOString().split("T")[0]
        }.pdf"`
      );

      console.log(
        `Bulk ${docType} PDF generated successfully for ${
          employees.length
        } employees with reference numbers MA${String(startSequence).padStart(
          2,
          "0"
        )} to MA${String(startSequence + employees.length - 1).padStart(
          2,
          "0"
        )}`
      );
      res.status(200).end(pdfBuffer);
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

/* ─────────────────────────────────────────────────────────────
   ADDITIONAL ENDPOINTS (KEEPING ORIGINAL)
──────────────────────────────────────────────────────────────── */

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

// List saved documents for an owner
router.get("/saved-documents", async (req, res) => {
  try {
    const ownerDir = path.join(DOCUMENTS_DIR, String(req.ownerId));
    if (!fs.existsSync(ownerDir)) {
      return res.json({ documents: [] });
    }

    const documents = [];
    const docTypes = fs.readdirSync(ownerDir);

    for (const docType of docTypes) {
      const typeDir = path.join(ownerDir, docType);
      if (fs.statSync(typeDir).isDirectory()) {
        const files = fs.readdirSync(typeDir);

        for (const file of files) {
          const filepath = path.join(typeDir, file);
          const stats = fs.statSync(filepath);

          documents.push({
            filename: file,
            docType: docType,
            filepath: path.relative(process.cwd(), filepath),
            url: `/uploads/documents/${req.ownerId}/${docType}/${file}`,
            size: stats.size,
            createdAt: stats.birthtime || stats.ctime,
            modifiedAt: stats.mtime,
          });
        }
      }
    }

    // Sort by creation date, newest first
    documents.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    res.json({
      ok: true,
      documents,
      count: documents.length,
      ownerId: req.ownerId,
    });
  } catch (error) {
    console.error("Error listing saved documents:", error);
    res.status(500).json({ message: "Failed to list saved documents" });
  }
});

// Get document by filename
router.get("/document/:filename", async (req, res) => {
  try {
    const { filename } = req.params;
    const { docType } = req.query;

    if (!docType) {
      return res
        .status(400)
        .json({ message: "docType query parameter is required" });
    }

    const filepath = path.join(
      DOCUMENTS_DIR,
      String(req.ownerId),
      docType,
      filename
    );

    if (!fs.existsSync(filepath)) {
      return res.status(404).json({ message: "Document not found" });
    }

    res.sendFile(filepath);
  } catch (error) {
    console.error("Error retrieving document:", error);
    res.status(500).json({ message: "Failed to retrieve document" });
  }
});

// Delete a saved document
router.delete("/document/:filename", async (req, res) => {
  try {
    const { filename } = req.params;
    const { docType } = req.query;

    if (!docType) {
      return res
        .status(400)
        .json({ message: "docType query parameter is required" });
    }

    const filepath = path.join(
      DOCUMENTS_DIR,
      String(req.ownerId),
      docType,
      filename
    );

    if (!fs.existsSync(filepath)) {
      return res.status(404).json({ message: "Document not found" });
    }

    fs.unlinkSync(filepath);

    res.json({
      ok: true,
      message: "Document deleted successfully",
    });
  } catch (error) {
    console.error("Error deleting document:", error);
    res.status(500).json({ message: "Failed to delete document" });
  }
});

module.exports = router;

/**
 * Programmatic certificate generator — called by the document-request approval flow.
 * Returns { saveResult, referenceNumber } so the controller can store the URL.
 */
module.exports.generateSalaryCertificateForEmployee = async (employeeId, ownerId) => {
  const referenceNumber = await generateReferenceNumber("salary_certificate", ownerId);
  const pdfBuffer = await generateDocumentPDF(
    employeeId,
    "salary_certificate",
    "",       // no specific templateId — uses owner's saved template
    ownerId,
    null,     // no precomputedTokens
    referenceNumber
  );
  const saveResult = await saveDocumentToFile(
    pdfBuffer,
    employeeId,
    "salary_certificate",
    ownerId,
    referenceNumber
  );
  return { pdfBuffer, saveResult, referenceNumber };
};

/**
 * Salary slip generator — generates salary slip PDF(s) for requested month(s)
 * Returns { saveResult, referenceNumber } so the controller can store the URL.
 */
module.exports.generateSalarySlipForEmployee = async (employeeId, ownerId, monthMode, month, fromMonth, toMonth) => {
  // Generate reference number
  const referenceNumber = await generateReferenceNumber("salary_slip", ownerId);

  // Helper to convert YYYY-MM to month name
  const getMonthName = (monthStr) => {
    const [year, monthNum] = monthStr.split("-");
    const date = new Date(year, parseInt(monthNum) - 1, 1);
    return date.toLocaleString("en-US", { month: "long" });
  };

  // Determine which months/years to fetch
  const monthYearPairs = [];
  console.log(`[generateSalarySlipForEmployee] monthMode=${monthMode}, month=${month}, fromMonth=${fromMonth}, toMonth=${toMonth}`);

  if (monthMode === "single" && month) {
    const [year, monthNum] = month.split("-");
    const monthName = getMonthName(month);
    console.log(`[generateSalarySlipForEmployee] Single month: ${monthName} ${year}`);
    monthYearPairs.push({ month: monthName, year });
  } else if (monthMode === "multiple" && fromMonth && toMonth) {
    const from = new Date(fromMonth + "-01");
    const to = new Date(toMonth + "-01");
    const current = new Date(from);

    while (current <= to) {
      const year = current.getFullYear().toString();
      const monthName = current.toLocaleString("en-US", { month: "long" });
      console.log(`[generateSalarySlipForEmployee] Range month: ${monthName} ${year}`);
      monthYearPairs.push({ month: monthName, year });
      current.setMonth(current.getMonth() + 1);
    }
  }

  if (monthYearPairs.length === 0) {
    throw new Error("No valid months specified for salary slip generation");
  }

  // Fetch salary slips and employee data
  const emp = await Employee.findById(employeeId).lean();
  if (!emp) throw new Error("Employee not found");

  // Build query for finding salary slips by month and year combinations
  const monthYearQueries = monthYearPairs.map(pair => ({ month: pair.month, year: pair.year }));
  console.log(`[generateSalarySlipForEmployee] Looking for slips with query:`, { employee: employeeId, monthYearQueries });

  const slips = await SalarySlip.find({
    employee: employeeId,
    $or: monthYearQueries
  }).lean();

  console.log(`[generateSalarySlipForEmployee] Found ${slips.length} salary slip(s)`);
  if (slips.length === 0) {
    const monthList = monthYearPairs.map(p => `${p.month} ${p.year}`).join(", ");
    const errorMsg = `No salary slips found for employee ${employeeId} for month(s): ${monthList}. Please ensure salary slips exist in the database for the requested period.`;
    console.error(`[generateSalarySlipForEmployee] ${errorMsg}`);
    throw new Error(errorMsg);
  }

  // Get company settings
  const settings = await Settings.findOne({ owner: ownerId }).lean();
  const timezone = settings?.timezone || "UTC";

  // Get company profile for logo and info
  const CompanyProfile = require("../models/CompanyProfile");
  const companyProfile = await CompanyProfile.findOne({ owner: ownerId }).lean();
  const companyName = companyProfile?.companyName || "Company Name";
  const companyAddress = companyProfile?.address || "";
  const companyLogo = companyProfile?.logo || null;

  // Get salary field configuration (which fields are enabled)
  const SalarySlipFields = require("../models/SalarySlipFields");
  const salaryFields = await SalarySlipFields.findOne({ owner: ownerId }).lean();

  console.log(`[generateSalarySlipForEmployee] Using company: ${companyName}`);

  // Generate PDFs for each slip
  {
    const mergedPdf = await PDFDocument.create();

    for (const slip of slips) {
      const html = generateSalarySlipHTML(slip, emp, settings, companyName, companyAddress, companyLogo, salaryFields);

      const pdfBuffer = await withPage(async (page) => {
        await page.setViewport({ width: 1200, height: 1600 });
        await page.setContent(html, { waitUntil: "networkidle0" });
        await page.emulateMediaType("print");

        return page.pdf({
          format: "A4",
          printBackground: true,
          margin: { top: "0.5cm", bottom: "0.5cm", left: "0.5cm", right: "0.5cm" }
        });
      });

      const tempPdf = await PDFDocument.load(pdfBuffer);
      const pageCount = tempPdf.getPageCount();

      for (let i = 0; i < pageCount; i++) {
        const [copiedPage] = await mergedPdf.copyPages(tempPdf, [i]);
        mergedPdf.addPage(copiedPage);
      }
    }

    const mergedPdfBytes = await mergedPdf.save();
    const pdfBuffer = Buffer.from(mergedPdfBytes);

    // Save the merged PDF
    const saveResult = await saveDocumentToFile(
      pdfBuffer,
      employeeId,
      "salary_slip",
      ownerId,
      referenceNumber
    );

    return { pdfBuffer, saveResult, referenceNumber };
  }
};

/**
 * Helper: Generate HTML for a single salary slip - Uses actual admin dashboard configuration
 */
function generateSalarySlipHTML(slip, emp, settings, companyName, companyAddress, companyLogo, salaryFields) {
  const encryptionKey = settings?.encryptionKey;

  // Helper to decrypt value if needed
  const getValue = (val) => {
    if (val === undefined || val === null) return 0;
    if (!encryptionKey) return Number(val) || 0;
    if (typeof val === "string" && val.includes(":")) {
      try {
        return Number(decrypt(val, encryptionKey)) || 0;
      } catch (e) {
        return Number(val) || 0;
      }
    }
    return Number(val) || 0;
  };

  const formatCurrency = (val) => {
    const num = Number(val);
    if (val === null || val === undefined || val === "" || isNaN(num) || num === 0) return "-";
    return Math.round(num).toLocaleString();
  };

  // All available compensation fields (from admin dashboard)
  const allCompFields = [
    ["Basic Pay", "basic"],
    ["Dearness Allowance", "dearnessAllowance"],
    ["House Rent Allowance", "houseRentAllowance"],
    ["Conveyance Allowance", "conveyanceAllowance"],
    ["Medical Allowance", "medicalAllowance"],
    ["Utility Allowance", "utilityAllowance"],
    ["Overtime Compensation", "overtimeCompensation"],
    ["Dislocation Allowance", "dislocationAllowance"],
    ["Leave Encashment", "leaveEncashment"],
    ["Bonus", "bonus"],
    ["Arrears", "arrears"],
    ["Auto Allowance", "autoAllowance"],
    ["Incentive", "incentive"],
    ["Fuel Allowance", "fuelAllowance"],
    ["Other Allowances", "othersAllowances"],
  ];

  // All available deduction fields (from admin dashboard)
  const allDedFields = [
    ["Leave Deduction", "leaveDeductions"],
    ["Late Deduction", "lateDeductions"],
    ["EOBI Deduction", "eobiDeduction"],
    ["SESSI Deduction", "sessiDeduction"],
    ["Provident Fund Deduction", "providentFundDeduction"],
    ["Gratuity Fund Deduction", "gratuityFundDeduction"],
    ["Vehicle Loan Deduction", "vehicleLoanDeduction"],
    ["Other Loan Deduction", "otherLoanDeductions"],
    ["Advance Salary Deduction", "advanceSalaryDeductions"],
    ["Medical Insurance", "medicalInsurance"],
    ["Life Insurance", "lifeInsurance"],
    ["Penalties", "penalties"],
    ["Other Deduction", "otherDeductions"],
    ["Tax Deduction", "taxDeduction"],
  ];

  // Filter to only enabled fields (matching admin dashboard logic)
  const enabledSalaryFields = salaryFields?.enabledSalaryFields || [];
  const enabledDeductionFields = salaryFields?.enabledDeductionFields || [];

  const earningFields = allCompFields.filter(
    ([, key]) => enabledSalaryFields.includes(key) || key === "loanBenefits"
  );

  const deductionFields = allDedFields.filter(
    ([, key]) => enabledDeductionFields.includes(key)
  );

  // Calculate totals
  const totalAddition = earningFields.reduce((sum, [, key]) => sum + getValue(slip[key]), 0);
  const totalDeduction = deductionFields.reduce((sum, [, key]) => sum + getValue(slip[key]), 0);
  const netSalary = totalAddition - totalDeduction;

  // Format date
  const createdDate = slip.createdAt ? new Date(slip.createdAt) : new Date();
  const formattedDate = createdDate.toLocaleDateString("en-GB") + ", " + createdDate.toLocaleTimeString("en-GB", { hour12: true });

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        html, body {
          width: 100%;
          height: 100%;
          margin: 0;
          padding: 0;
          font-family: 'Inter', 'Arial', sans-serif;
          font-size: 12px;
          line-height: 1.5;
          color: #1f2937;
          background: white;
        }
        .a4-salary-slip {
          width: 100%;
          max-width: 100%;
          background: #fff;
          font-family: 'Inter', 'Arial', sans-serif;
          font-size: 12px;
          padding: 0;
          box-sizing: border-box;
          position: relative;
          page-break-inside: auto;
          overflow: visible;
          line-height: 1.5;
        }

        .header-section {
          margin-bottom: 12px;
          border-bottom: 1.5px solid #dbeafe;
          padding-bottom: 8px;
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
        }

        .header-left {
          display: flex;
          flex-direction: row;
          align-items: flex-start;
          flex: 1;
          gap: 16px;
        }

        .company-logo {
          width: 80px;
          height: auto;
          max-height: 100px;
          object-fit: contain;
          border-radius: 8px;
        }

        .company-info {
          display: flex;
          flex-direction: column;
          align-items: flex-start;
        }

        .company-name {
          font-weight: 700;
          font-size: 16px;
          line-height: 1.3;
          color: #0f172a;
          margin-bottom: 2px;
        }

        .company-address {
          color: #64748b;
          font-size: 12px;
          margin-top: 2px;
          line-height: 1.4;
        }

        .header-right {
          text-align: right;
          margin-left: 24px;
        }

        .slip-title {
          font-weight: 600;
          font-size: 13px;
          color: #334155;
          line-height: 1.3;
          margin-bottom: 4px;
        }

        .slip-generated {
          font-size: 11px;
          color: #64748b;
          line-height: 1.4;
        }

        .profile-section {
          background: #fff;
          border-radius: 12px;
          box-shadow: 0 1px 4px rgba(224, 231, 239, 0.1);
          border: 1.5px solid #dbeafe;
          padding: 10px 14px;
          margin-bottom: 12px;
        }

        .profile-table {
          width: 100%;
          border-collapse: collapse;
        }

        .profile-row { }

        .profile-cell {
          padding: 4px 8px;
          line-height: 1.4;
        }

        .profile-label {
          color: #0f172a;
          font-weight: 600;
          font-size: 12px;
        }

        .profile-value {
          color: #111827;
          font-weight: 500;
          margin-top: 0;
          margin-left: auto;
          font-size: 12px;
          line-height: 1.4;
          text-align: right;
        }

        .section-title {
          font-weight: 700;
          font-size: 12px;
          background: #f1f5f9;
          color: #334155;
          padding: 8px 10px;
          border: 1px solid #cbd5e1;
          margin-top: 12px;
          margin-bottom: 8px;
        }

        .salary-table {
          width: 100%;
          border-collapse: collapse;
          margin-bottom: 12px;
          font-size: 12px;
        }

        .salary-table th {
          background: #f1f5f9;
          color: #334155;
          border: 1px solid #cbd5e1;
          padding: 8px 10px;
          text-align: left;
          font-weight: 700;
          line-height: 1.4;
        }

        .salary-table td {
          border-left: 1px solid #cbd5e1;
          padding: 2px 10px;
          font-size: 12px;
          line-height: 1.4;
          word-break: break-word;
          overflow: visible;
        }

        .salary-table td:first-child {
          text-align: left;
        }

        .salary-table td:last-child {
          text-align: right;
          border-right: 1px solid #cbd5e1;
        }

        .total-row {
          font-weight: 700;
          background: #f9f9f9;
        }

        .total-row td {
          border-top: 1px solid #cbd5e1;
          border-bottom: 1px solid #cbd5e1;
        }

        .summary-section {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 12px;
          margin-top: 16px;
          padding-top: 12px;
          border-top: 1px solid #cbd5e1;
        }

        .summary-box {
          text-align: center;
          padding: 12px;
          background: #f5f5f5;
          border-radius: 4px;
        }

        .summary-label {
          font-size: 11px;
          color: #64748b;
          margin-bottom: 4px;
          font-weight: 500;
        }

        .summary-value {
          font-size: 14px;
          font-weight: 700;
          color: #111827;
        }

        .footer {
          margin-top: 20px;
          text-align: center;
          font-size: 11px;
          color: #9ca3af;
          border-top: 1px solid #e5e7eb;
          padding-top: 12px;
        }

        @media print {
          body { margin: 0; padding: 0; }
          .a4-salary-slip { margin: 0; padding: 0; }
          .section-title { page-break-inside: avoid; }
          .salary-table { page-break-inside: avoid; }
        }
      </style>
    </head>
    <body>
      <div class="a4-salary-slip">
        <!-- Header Section -->
        <div class="header-section">
          <div class="header-left">
            ${companyLogo ? `<img src="${companyLogo}" alt="Company Logo" class="company-logo" />` : ""}
            <div class="company-info">
              <div class="company-name">${companyName}</div>
              <div class="company-address">${companyAddress || ""}</div>
            </div>
          </div>
          <div class="header-right">
            <div class="slip-title">Pay slip – ${slip.month || "Month"} ${slip.year || ""}</div>
            <div class="slip-generated">Generated: ${formattedDate}</div>
          </div>
        </div>

        <!-- Profile Section -->
        <div class="profile-section">
          <table class="profile-table">
            <tbody>
              <tr class="profile-row">
                <td class="profile-cell">
                  <div class="profile-label">Name</div>
                  <div class="profile-value">${emp.firstName || emp.name || "-"} ${emp.lastName || ""}</div>
                </td>
                <td class="profile-cell">
                  <div class="profile-label">Employee ID</div>
                  <div class="profile-value">${emp.empId || "-"}</div>
                </td>
              </tr>
              <tr class="profile-row">
                <td class="profile-cell">
                  <div class="profile-label">Designation</div>
                  <div class="profile-value">${emp.designation || "-"}</div>
                </td>
                <td class="profile-cell">
                  <div class="profile-label">Department</div>
                  <div class="profile-value">${emp.department || "-"}</div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- Earnings Section -->
        <div class="section-title">EARNINGS</div>
        <table class="salary-table">
          <thead>
            <tr>
              <th>Description</th>
              <th style="width: 100px;">Amount</th>
            </tr>
          </thead>
          <tbody>
            ${earningFields.map(([label, key]) => {
              const value = getValue(slip[key]);
              if (value === 0) return "";
              return `<tr>
                <td>${label}</td>
                <td style="text-align: right;">${formatCurrency(value)}</td>
              </tr>`;
            }).join("")}
            <tr class="total-row">
              <td>TOTAL EARNINGS</td>
              <td style="text-align: right;">${formatCurrency(totalAddition)}</td>
            </tr>
          </tbody>
        </table>

        <!-- Deductions Section -->
        <div class="section-title">DEDUCTIONS</div>
        <table class="salary-table">
          <thead>
            <tr>
              <th>Description</th>
              <th style="width: 100px;">Amount</th>
            </tr>
          </thead>
          <tbody>
            ${deductionFields.map(([label, key]) => {
              const value = getValue(slip[key]);
              if (value === 0) return "";
              return `<tr>
                <td>${label}</td>
                <td style="text-align: right;">${formatCurrency(value)}</td>
              </tr>`;
            }).join("")}
            <tr class="total-row">
              <td>TOTAL DEDUCTIONS</td>
              <td style="text-align: right;">${formatCurrency(totalDeduction)}</td>
            </tr>
          </tbody>
        </table>

        <!-- Summary Section -->
        <div class="summary-section">
          <div class="summary-box">
            <div class="summary-label">TOTAL EARNINGS</div>
            <div class="summary-value">${formatCurrency(totalAddition)}</div>
          </div>
          <div class="summary-box">
            <div class="summary-label">TOTAL DEDUCTIONS</div>
            <div class="summary-value">${formatCurrency(totalDeduction)}</div>
          </div>
          <div class="summary-box">
            <div class="summary-label">NET SALARY</div>
            <div class="summary-value">${formatCurrency(netSalary)}</div>
          </div>
        </div>

        <!-- Footer -->
        <div class="footer">
          <p style="margin: 4px 0;">This is a computer-generated document. No signature required.</p>
        </div>
      </div>
    </body>
    </html>
  `;
}
