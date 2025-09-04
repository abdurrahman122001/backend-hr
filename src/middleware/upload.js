// middleware/upload.js
const path = require("path");
const fs = require("fs");
const multer = require("multer");

// ensure directory exists
function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

const ASSIGN_DIR = path.join(__dirname, "..", "uploads", "assignments");
ensureDir(ASSIGN_DIR);

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, ASSIGN_DIR);
  },
  filename: (req, file, cb) => {
    // safe unique filename
    const ts = Date.now();
    const ext = path.extname(file.originalname) || "";
    const base = path.basename(file.originalname, ext).replace(/\s+/g, "_");
    cb(null, `${base}__${ts}${ext}`);
  },
});

const ACCEPTED = new Set([
  "application/pdf",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

function fileFilter(req, file, cb) {
  if (ACCEPTED.has(file.mimetype)) return cb(null, true);
  // allow by extension fallback
  const ok = /\.(pdf|xls|xlsx)$/i.test(file.originalname);
  if (ok) return cb(null, true);
  cb(new Error("Only PDF, XLS, XLSX are allowed"));
}

const uploadAssignments = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
  fileFilter,
});

module.exports = { uploadAssignments };
