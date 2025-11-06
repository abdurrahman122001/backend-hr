const path = require("path");
const fs = require("fs");
const multer = require("multer");

/**
 * Ensure directory exists
 */
function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/* ======================================================
   📁 1. Assignment Upload Configuration
   ====================================================== */
const ASSIGN_DIR = path.join(__dirname, "..", "uploads", "assignments");
ensureDir(ASSIGN_DIR);

const assignmentStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, ASSIGN_DIR),
  filename: (req, file, cb) => {
    const timestamp = Date.now();
    const ext = path.extname(file.originalname) || "";
    const base = path.basename(file.originalname, ext).replace(/\s+/g, "_");
    cb(null, `${base}__${timestamp}${ext}`);
  },
});

const ASSIGN_ACCEPTED = new Set([
  "application/pdf",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

function assignmentFileFilter(req, file, cb) {
  if (ASSIGN_ACCEPTED.has(file.mimetype)) return cb(null, true);
  const ok = /\.(pdf|xls|xlsx)$/i.test(file.originalname);
  if (ok) return cb(null, true);
  cb(new Error("Only PDF, XLS, and XLSX files are allowed"));
}

const uploadAssignments = multer({
  storage: assignmentStorage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB
  fileFilter: assignmentFileFilter,
});

/* ======================================================
   🖼️ 2. Employee Photo Upload Configuration
   ====================================================== */
const PHOTO_DIR = path.join(__dirname, "..", "uploads", "photos");
ensureDir(PHOTO_DIR);

const photoStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, PHOTO_DIR),
  filename: (req, file, cb) => {
    const timestamp = Date.now();
    const ext = path.extname(file.originalname) || "";
    const base = path.basename(file.originalname, ext).replace(/\s+/g, "_");
    cb(null, `${base}__${timestamp}${ext}`);
  },
});

function photoFileFilter(req, file, cb) {
  const allowed = ["image/jpeg", "image/png", "image/jpg", "image/webp"];
  if (allowed.includes(file.mimetype)) return cb(null, true);
  cb(new Error("Only image files (jpg, jpeg, png, webp) are allowed"));
}

const uploadPhotos = multer({
  storage: photoStorage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter: photoFileFilter,
});

module.exports = {
  uploadAssignments,
  uploadPhotos,
};
