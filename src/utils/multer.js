// utils/multer.js
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const { randomUUID } = require("crypto");

const UPLOAD_DIR = path.join(process.cwd(), "uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || "");
    const safeBase = path
      .basename(file.originalname || "file", ext)
      .replace(/[^\w\-]+/g, "_")
      .slice(0, 60);
    cb(null, `${safeBase}_${Date.now()}_${randomUUID()}${ext}`);
  },
});

const ACCEPTED = new Set([
  "application/pdf",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

function fileFilter(req, file, cb) {
  if (ACCEPTED.has(file.mimetype)) cb(null, true);
  else cb(new Error("Only PDF, XLS, XLSX are allowed"));
}

const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
  fileFilter,
});

module.exports = { upload, UPLOAD_DIR };
