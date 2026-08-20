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

// Updated to include audio, image, and video files
const ACCEPTED = new Set([
  // Document files
  "application/pdf",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel.sheet.macroEnabled.12", // .xlsm
  "application/vnd.ms-excel.template.macroEnabled.12", // .xltm
  "application/vnd.openxmlformats-officedocument.spreadsheetml.template", // .xltx
  "text/csv", // .csv (common)
  "application/csv", // alt MIME for CSV
  "text/x-csv", // alt MIME
  "application/x-csv", // alt MIME
  "text/plain", // sometimes CSVs are uploaded as plain text
  // Audio files
  "audio/mpeg", // mp3
  "audio/wav",
  "audio/wave",
  "audio/x-wav",
  "audio/x-pn-wav",
  "audio/ogg",
  "audio/webm",
  "audio/aac",
  "audio/mp4",
  "audio/x-m4a",
  "audio/flac",
  // ZIP (important)
  "application/zip",
  "application/x-zip-compressed",
  "multipart/x-zip",
  "audio/x-flac",
  "application/msword", // .doc
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // .docx
  "application/vnd.ms-word.document.macroEnabled.12", // .docm
  "application/vnd.openxmlformats-officedocument.wordprocessingml.template", // .dotx
  "application/vnd.ms-word.template.macroEnabled.12", // .dotm
  "application/vnd.ms-powerpoint", // .ppt
  "application/vnd.openxmlformats-officedocument.presentationml.presentation", // .pptx
  "application/vnd.openxmlformats-officedocument.presentationml.slideshow", // .ppsx
  "application/vnd.openxmlformats-officedocument.presentationml.template", // .potx
  "application/vnd.ms-powerpoint.presentation.macroEnabled.12", // .pptm
  "application/rtf", // .rtf
  "text/rtf",
  // Image files
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  "image/bmp",
  "image/tiff",

  // Video files
  "video/mp4",
  "video/mpeg",
  "video/ogg",
  "video/webm",
  "video/quicktime",
  "video/x-msvideo",
  "video/x-ms-wmv",
  "video/x-flv",
  "video/3gpp",
  "video/3gpp2",
]);

// Allow all file types (size limit is handled by multer limits)
function fileFilter(req, file, cb) {
  cb(null, true);
}

const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
  fileFilter,
});

module.exports = { upload, UPLOAD_DIR };
