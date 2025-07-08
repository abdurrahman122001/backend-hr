const express = require("express");
const Employee = require("../models/Employees");
const requireAuth = require("../middleware/auth");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

const router = express.Router();

// --- Ensure upload folders exist ---
const ensureDir = (dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
};
const photosDir = path.join(__dirname, "../uploads/photos");
const cvDir = path.join(__dirname, "../uploads/cv");
const otherDir = path.join(__dirname, "../uploads/other");
ensureDir(photosDir);
ensureDir(cvDir);
ensureDir(otherDir);

// --- Multer storage setup ---
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (file.fieldname === "photograph") cb(null, photosDir);
    else if (file.fieldname === "cv") cb(null, cvDir);
    else cb(null, otherDir);
  },
  filename: (req, file, cb) => {
    cb(
      null,
      file.fieldname + "-" + Date.now() + path.extname(file.originalname)
    );
  },
});
const upload = multer({ storage });

const allFields = [
  "name", "email", "fatherOrHusbandName", "cnic", "dateOfBirth", "gender", "nationality",
  "maritalStatus", "religion", "cnicIssueDate", "cnicExpiryDate", "photographUrl", "cvUrl",
  "latestQualification", "fieldOfQualification", "phone", "companyEmail", "permanentAddress",
  "presentAddress", "bankName", "bankAccountNumber", "nomineeName", "nomineeCnic",
  "nomineeRelation", "nomineeNo", "emergencyContactName", "emergencyContactRelation",
  "emergencyContactNumber", "emergencyNo", "department", "designation", "joiningDate", "rt"
];

// --- GET: Fetch all fields ---
router.get("/:id/complete", async (req, res) => {
  try {
    const { id } = req.params;
    const selectFields = allFields.join(" ");
    const emp = await Employee.findById(id).select(selectFields);
    if (!emp) return res.status(404).json({ success: false, error: "Employee not found" });
    const data = { _id: emp._id.toString() };
    allFields.forEach(field => {
      data[field] = emp[field] !== undefined && emp[field] !== null ? emp[field] : "";
    });
    return res.json({ success: true, data });
  } catch (err) {
    console.error("❌ GET /api/employees/:id/complete error:", err);
    return res.status(500).json({ success: false, error: "Server error" });
  }
});

// --- PUT: Update all fields with file support ---
router.put(
  "/:id/complete",
  upload.fields([
    { name: "photograph", maxCount: 1 },
    { name: "cv", maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      const { id } = req.params;
      const emp = await Employee.findById(id);
      if (!emp) return res.status(404).json({ success: false, error: "Employee not found" });

      // Assign uploaded files (if present)
      if (req.files?.photograph?.[0]) {
        // Use API path for frontend access (if you serve /uploads statically)
        emp.photographUrl = `/uploads/photos/${req.files.photograph[0].filename}`;
      }
      if (req.files?.cv?.[0]) {
        emp.cvUrl = `/uploads/cv/${req.files.cv[0].filename}`;
      }

      // Parse date fields
      const dateFields = ["dateOfBirth", "cnicIssueDate", "cnicExpiryDate", "joiningDate"];
      allFields.forEach(field => {
        if (req.body[field] !== undefined && req.body[field] !== null) {
          if (dateFields.includes(field) && req.body[field]) {
            emp[field] = new Date(req.body[field]);
          } else {
            emp[field] = req.body[field];
          }
        }
      });

      // Ensure owner
      if (!emp.owner) emp.owner = "6838b0b708e8629ffab534ee";
      await emp.save();

      return res.json({ success: true, data: { _id: emp._id.toString() } });
    } catch (err) {
      console.error("❌ PUT /api/employees/:id/complete error:", err);
      return res.status(500).json({ success: false, error: "Server error" });
    }
  }
);

module.exports = router;
