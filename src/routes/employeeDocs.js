const express = require("express");
const path = require("path");
const fs = require("fs");
const multer = require("multer");

const Employee = require("../models/Employees");
const EmployeeDocument = require("../models/EmployeeDocument");

const router = express.Router();

/* ---------- ensure upload dirs ---------- */
const ensureDir = (dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
};
const uploadsRoot = path.join(__dirname, "../uploads");
const cnicDir = path.join(uploadsRoot, "cnic");
const cvDir   = path.join(uploadsRoot, "cv");
ensureDir(uploadsRoot);
ensureDir(cnicDir);
ensureDir(cvDir);

/* ---------- multer setup (PDF only) ---------- */
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (file.fieldname === "cnicFront" || file.fieldname === "cnicBack") {
      cb(null, cnicDir);
    } else if (file.fieldname === "resume") {
      cb(null, cvDir);
    } else {
      cb(null, uploadsRoot);
    }
  },
  filename: (req, file, cb) => {
    const stamp = Date.now();
    const ext = path.extname(file.originalname) || ".pdf";
    cb(null, `${file.fieldname}-${stamp}${ext}`);
  },
});

const fileFilter = (req, file, cb) => {
  if (file.mimetype === "application/pdf") return cb(null, true);
  cb(new Error("Only PDF files are allowed."), false);
};

const upload = multer({ storage, fileFilter });

/* ---------- helpers ---------- */
const relPath = (abs) =>
  abs.replace(path.join(__dirname, ".."), "").replace(/\\/g, "/"); // -> /uploads/...

const removeFileIfExists = (absolutePath) => {
  try {
    if (absolutePath && fs.existsSync(absolutePath)) fs.unlinkSync(absolutePath);
  } catch (_) {}
};

/* 
  GET /api/employee-docs/:employeeId
  -> returns current document record
*/
router.get("/:employeeId", async (req, res) => {
  try {
    const { employeeId } = req.params;

    const emp = await Employee.findById(employeeId).select("_id");
    if (!emp) return res.status(404).json({ success: false, error: "Employee not found" });

    const record = await EmployeeDocument.findOne({ employee: emp._id });
    return res.json({ success: true, data: record || null });
  } catch (err) {
    console.error("GET /employee-docs error:", err);
    res.status(500).json({ success: false, error: "Server error" });
  }
});

/*
  POST /api/employee-docs/:employeeId
  multipart/form-data
  fields: cnic (pdf), resume (pdf)
  -> upsert document record
*/
router.post(
  "/:employeeId",
  upload.fields([
    { name: "cnicFront", maxCount: 1 },
    { name: "cnicBack",  maxCount: 1 },
    { name: "resume",    maxCount: 1 },
    // Aliases for compatibility with different frontend components
    { name: "cnic",          maxCount: 1 },
    { name: "cnicFrontFile", maxCount: 1 },
    { name: "cnicBackFile",  maxCount: 1 },
    { name: "resumeFile",    maxCount: 1 },
    { name: "file",          maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      console.log("POST /employee-docs received files:", Object.keys(req.files || {}));
      const { employeeId } = req.params;

      const emp = await Employee.findById(employeeId).select("_id");
      if (!emp) return res.status(404).json({ success: false, error: "Employee not found" });

      const existing = await EmployeeDocument.findOne({ employee: emp._id });

      let cnicFrontUrl = existing?.cnicFrontUrl || "";
      let cnicBackUrl  = existing?.cnicBackUrl  || "";
      let resumeUrl    = existing?.resumeUrl     || "";

      if (req.files?.cnicFront?.[0] || req.files?.cnicFrontFile?.[0] || req.files?.cnic?.[0] || req.files?.file?.[0]) {
        const file = req.files.cnicFront?.[0] || req.files.cnicFrontFile?.[0] || req.files.cnic?.[0] || req.files.file?.[0];
        if (cnicFrontUrl) removeFileIfExists(path.join(__dirname, "..", cnicFrontUrl));
        cnicFrontUrl = relPath(file.path);
      }

      if (req.files?.cnicBack?.[0] || req.files?.cnicBackFile?.[0]) {
        const file = req.files.cnicBack?.[0] || req.files.cnicBackFile?.[0];
        if (cnicBackUrl) removeFileIfExists(path.join(__dirname, "..", cnicBackUrl));
        cnicBackUrl = relPath(file.path);
      }

      if (req.files?.resume?.[0] || req.files?.resumeFile?.[0]) {
        const file = req.files.resume?.[0] || req.files.resumeFile?.[0];
        if (resumeUrl) removeFileIfExists(path.join(__dirname, "..", resumeUrl));
        resumeUrl = relPath(file.path);
      }

      const updated = await EmployeeDocument.findOneAndUpdate(
        { employee: emp._id },
        { $set: { cnicFrontUrl, cnicBackUrl, resumeUrl } },
        { upsert: true, new: true }
      );

      return res.json({ success: true, data: updated });
    } catch (err) {
      console.error("POST /employee-docs error:", err);
      return res.status(400).json({ success: false, error: err.message || "Upload failed" });
    }
  }
);

/*
  DELETE /api/employee-docs/:employeeId/:type
  :type = cnic | resume
  -> remove single file & clear field
*/
router.delete("/:employeeId/:type", async (req, res) => {
  try {
    const { employeeId, type } = req.params;
    if (!["cnicFront", "cnicBack", "resume"].includes(type)) {
      return res.status(400).json({ success: false, error: "Invalid type" });
    }

    const emp = await Employee.findById(employeeId).select("_id");
    if (!emp) return res.status(404).json({ success: false, error: "Employee not found" });

    const doc = await EmployeeDocument.findOne({ employee: emp._id });
    if (!doc) return res.json({ success: true, data: null });

    const fieldMap = {
      cnicFront: "cnicFrontUrl",
      cnicBack: "cnicBackUrl",
      resume: "resumeUrl",
    };
    const field = fieldMap[type];

    if (doc[field]) {
      removeFileIfExists(path.join(__dirname, "..", doc[field]));
      doc[field] = "";
      await doc.save();
    }

    res.json({ success: true, data: doc });
  } catch (err) {
    console.error("DELETE /employee-docs error:", err);
    res.status(500).json({ success: false, error: "Server error" });
  }
});

module.exports = router;
