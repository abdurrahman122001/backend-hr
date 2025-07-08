// middleware/upload.js
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    // employeeId might come from either params or body
    const empId = req.params.employeeId || req.body.employeeId || req.params.id || req.body.id;
    if (!empId) return cb(new Error("No employee ID in route"), false);
    const folder = path.join(__dirname, '../uploads/employee', empId);
    fs.mkdirSync(folder, { recursive: true });
    cb(null, folder);
  },
  filename: function (req, file, cb) {
    cb(null, file.fieldname + '-' + Date.now() + path.extname(file.originalname));
  }
});

const fileFilter = function (req, file, cb) {
  if (file.fieldname.startsWith("certificate_") || file.fieldname === "file") {
    if (file.mimetype !== "application/pdf") {
      return cb(new Error("Only PDF files allowed for certificates"), false);
    }
  } else if (file.fieldname === "photograph") {
    if (!file.mimetype.startsWith("image/")) {
      return cb(new Error("Only image files allowed for photograph"), false);
    }
  }
  cb(null, true);
};

const upload = multer({ storage, fileFilter });

module.exports = upload;
