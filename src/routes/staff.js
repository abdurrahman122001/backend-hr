const express           = require("express");
const multer            = require("multer");
const path              = require("path");
const router            = express.Router();
const requireAuth       = require("../middleware/auth");
const Employee          = require("../models/Employees");
const SalarySlip        = require("../models/SalarySlip");
const EmployeeHierarchy = require("../models/EmployeeHierarchy");
const { encrypt, decrypt } = require("../utils/encryption");
const DecryptionKey    = require("../models/DecryptionKey");
const bcrypt = require('bcryptjs');
const fs = require("fs");
const Certificate = require("../models/Certificate");
// Multer setup for photo uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.join(__dirname, "../uploads/photos"));
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB max
});

router.post(
  "/create",
  requireAuth,
  upload.fields([
    { name: "photographFile", maxCount: 1 },
    { name: "matricCertificate", maxCount: 1 },
    { name: "interCertificate", maxCount: 1 },
    { name: "graduateCertificate", maxCount: 1 },
    { name: "mastersCertificate", maxCount: 1 },
  ]),
  async (req, res) => {
    const {
      name, email, companyEmail, password, fatherOrHusbandName, cnic, dateOfBirth,
      gender, nationality, cnicIssueDate, cnicExpiryDate, maritalStatus, religion,
      latestQualification, fieldOfQualification, phone, permanentAddress, presentAddress,
      bankName, bankAccountNumber, photographUrl, nomineeName, nomineeRelation, nomineeCnic,
      nomineeNo, emergencyNo, rt, department, designation, joiningDate, leaveEntitlement,
      basic, dearnessAllowance, houseRentAllowance, conveyanceAllowance, medicalAllowance,
      utilityAllowance, overtimeComp, dislocationAllowance, leaveEncashment, bonus, arrears,
      autoAllowance, incentive, fuelAllowance, othersAllowances, grossSalary,
      leaveDeductions, lateDeductions, eobiDeduction, sessiDeduction, providentFundDeduction,
      gratuityFundDeduction, vehicleLoanDeduction, otherLoanDeductions, advanceSalaryDeductions,
      medicalInsurance, lifeInsurance, penalties, otherDeductions, taxDeduction,
      emergencyContactName, emergencyContactRelation, emergencyContactNumber,
      seniorId, juniorId, relation, isHR, isAdmin
    } = req.body;

    try {
      const hrFlag = isHR === "true" || isHR === true;
      if (hrFlag && !password) {
        return res.status(400).json({
          status: "error",
          message: "Password is required when isHR = true.",
        });
      }

      // Encrypt all salary/compensation fields
      const compensation = {
        basic: encrypt(String(basic || 0)),
        dearnessAllowance: encrypt(String(dearnessAllowance || 0)),
        houseRentAllowance: encrypt(String(houseRentAllowance || 0)),
        conveyanceAllowance: encrypt(String(conveyanceAllowance || 0)),
        medicalAllowance: encrypt(String(medicalAllowance || 0)),
        utilityAllowance: encrypt(String(utilityAllowance || 0)),
        overtimeComp: encrypt(String(overtimeComp || 0)),
        dislocationAllowance: encrypt(String(dislocationAllowance || 0)),
        leaveEncashment: encrypt(String(leaveEncashment || 0)),
        bonus: encrypt(String(bonus || 0)),
        arrears: encrypt(String(arrears || 0)),
        autoAllowance: encrypt(String(autoAllowance || 0)),
        incentive: encrypt(String(incentive || 0)),
        fuelAllowance: encrypt(String(fuelAllowance || 0)),
        others: encrypt(String(othersAllowances || 0)),
        grossSalary: encrypt(String(grossSalary || 0)),
      };

      const deductions = {
        leaveDeductions: encrypt(String(leaveDeductions || 0)),
        lateDeductions: encrypt(String(lateDeductions || 0)),
        eobi: encrypt(String(eobiDeduction || 0)),
        sessi: encrypt(String(sessiDeduction || 0)),
        providentFund: encrypt(String(providentFundDeduction || 0)),
        gratuityFund: encrypt(String(gratuityFundDeduction || 0)),
        loanDeductions: {
          vehicleLoan: encrypt(String(vehicleLoanDeduction || 0)),
          otherLoans: encrypt(String(otherLoanDeductions || 0)),
        },
        advanceSalary: encrypt(String(advanceSalaryDeductions || 0)),
        medicalInsurance: encrypt(String(medicalInsurance || 0)),
        lifeInsurance: encrypt(String(lifeInsurance || 0)),
        penalties: encrypt(String(penalties || 0)),
        others: encrypt(String(otherDeductions || 0)),
        tax: encrypt(String(taxDeduction || 0)),
      };

      // Console log to check!
      console.log("Saving Encrypted: ", compensation, deductions);

      const emp = new Employee({
        owner: req.user._id,
        name,
        email,
        companyEmail,
        password: hrFlag ? password : undefined,
        fatherOrHusbandName,
        cnic,
        photographUrl: req.files && req.files["photographFile"] && req.files["photographFile"][0]
          ? `/uploads/photos/${req.files["photographFile"][0].filename}`
          : undefined,
        dateOfBirth: dateOfBirth ? new Date(dateOfBirth) : undefined,
        gender,
        nationality,
        cnicIssueDate: cnicIssueDate ? new Date(cnicIssueDate) : undefined,
        cnicExpiryDate: cnicExpiryDate ? new Date(cnicExpiryDate) : undefined,
        maritalStatus,
        religion,
        latestQualification,
        fieldOfQualification,
        phone,
        permanentAddress,
        presentAddress,
        bankName,
        bankAccountNumber,
        nomineeName,
        nomineeRelation,
        nomineeCnic,
        nomineeNo,
        emergencyNo,
        rt,
        emergencyContactName,
        emergencyContactRelation,
        emergencyContactNumber,
        department,
        designation,
        joiningDate: joiningDate ? new Date(joiningDate) : undefined,
        leaveEntitlement: {
          total: Number(leaveEntitlement) || 0,
          usedPaid: 0,
          usedUnpaid: 0,
        },
        compensation,
        deductions,
        isHR: hrFlag,
        isAdmin: isAdmin === "true" || isAdmin === true,
      });

      await emp.save();

      // Certificate upload handling
      const certTypes = [
        { key: "matricCertificate", type: "matric" },
        { key: "interCertificate", type: "inter" },
        { key: "graduateCertificate", type: "graduate" },
        { key: "mastersCertificate", type: "masters" },
      ];

      for (const { key, type } of certTypes) {
        if (req.files && req.files[key] && req.files[key][0]) {
          const fileObj = req.files[key][0];

          // Move the file to a dedicated directory (uploads/certificates/:empId/:type/)
          const destDir = path.join(
            __dirname,
            "..",
            "uploads",
            "certificates",
            String(emp._id),
            type
          );
          fs.mkdirSync(destDir, { recursive: true });

          // Rename file (use originalname, replace spaces)
          const newPath = path.join(destDir, fileObj.originalname.replace(/\s+/g, "_"));

          fs.renameSync(fileObj.path, newPath);

          // Store the fileUrl as a relative URL for static serving
          const fileUrl = `/uploads/certificates/${emp._id}/${type}/${fileObj.originalname.replace(/\s+/g, "_")}`;

          // Save Certificate document
          await Certificate.create({
            employee: emp._id,
            type,
            fileUrl,
          });
        }
      }

      // Save SalarySlip as encrypted
      const slip = new SalarySlip({
        employee: emp._id,
        generatedOn: new Date(),
        basic: compensation.basic,
        dearnessAllowance: compensation.dearnessAllowance,
        houseRentAllowance: compensation.houseRentAllowance,
        conveyanceAllowance: compensation.conveyanceAllowance,
        medicalAllowance: compensation.medicalAllowance,
        utilityAllowance: compensation.utilityAllowance,
        overtimeCompensation: compensation.overtimeComp,
        dislocationAllowance: compensation.dislocationAllowance,
        leaveEncashment: compensation.leaveEncashment,
        bonus: compensation.bonus,
        arrears: compensation.arrears,
        autoAllowance: compensation.autoAllowance,
        incentive: compensation.incentive,
        fuelAllowance: compensation.fuelAllowance,
        othersAllowances: compensation.others,
        grossSalary: compensation.grossSalary,
        leaveDeductions: deductions.leaveDeductions,
        lateDeductions: deductions.lateDeductions,
        eobiDeduction: deductions.eobi,
        sessiDeduction: deductions.sessi,
        providentFundDeduction: deductions.providentFund,
        gratuityFundDeduction: deductions.gratuityFund,
        loanDeductions: {
          vehicleLoan: deductions.loanDeductions.vehicleLoan,
          otherLoans: deductions.loanDeductions.otherLoans,
        },
        advanceSalaryDeductions: deductions.advanceSalary,
        medicalInsurance: deductions.medicalInsurance,
        lifeInsurance: deductions.lifeInsurance,
        penalties: deductions.penalties,
        othersDeductions: deductions.others,
        taxDeduction: deductions.tax,
      });
      await slip.save();

      if (seniorId) {
        await EmployeeHierarchy.create({
          owner: req.user._id,
          senior: seniorId,
          junior: emp._id,
          relation,
        });
      }
      if (juniorId) {
        await EmployeeHierarchy.create({
          owner: req.user._id,
          senior: emp._id,
          junior: juniorId,
          relation,
        });
      }

      res.json({
        status: "success",
        data: { employee: emp, salarySlip: slip },
      });
    } catch (err) {
      console.error("❌ staff/create error:", err);
      res.status(500).json({ status: "error", message: err.message });
    }
  }
);
router.delete("/delete-all", requireAuth, async (req, res) => {
  try {
    // Delete all SalarySlips
    await SalarySlip.deleteMany({});
    // Delete all EmployeeHierarchy links
    await EmployeeHierarchy.deleteMany({});
    // Delete all Employees
    await Employee.deleteMany({});

    res.json({ status: "success", message: "All employees, salary slips, and hierarchies deleted." });
  } catch (err) {
    console.error("❌ staff/delete-all error:", err);
    res.status(500).json({ status: "error", message: err.message });
  }
});
router.delete("/:id", requireAuth, async (req, res) => {
  const employeeId = req.params.id;
  try {
    // Delete all salary slips related to this employee
    await SalarySlip.deleteMany({ employee: employeeId });
    // Delete all hierarchies where this employee is a senior or junior
    await EmployeeHierarchy.deleteMany({ $or: [{ senior: employeeId }, { junior: employeeId }] });
    // Delete the employee
    await Employee.deleteOne({ _id: employeeId });

    res.json({ status: "success", message: "Employee and related records deleted." });
  } catch (err) {
    console.error("❌ staff/:id DELETE error:", err);
    res.status(500).json({ status: "error", message: err.message });
  }
});
router.post("/decrypt", requireAuth, async (req, res) => {
  const { slipId, key } = req.body;
  if (!slipId || !key) return res.status(400).json({ error: "slipId and key required" });

  const slip = await SalarySlip.findById(slipId);
  if (!slip) return res.status(404).json({ error: "Slip not found" });

  // Get user's active decryption key
  const userKey = await DecryptionKey.findOne({ owner: req.user._id, active: true });
  if (!userKey) return res.status(403).json({ error: "No active decryption key found" });

  // Compare input key to stored hash
  const match = await bcrypt.compare(key, userKey.hash);
  if (!match) return res.status(403).json({ error: "Invalid decryption key" });

  try {
    const decryptedFields = {};
    const fieldsToDecrypt = [
      "basic", "dearnessAllowance", "houseRentAllowance", "conveyanceAllowance",
      "medicalAllowance", "utilityAllowance", "overtimeCompensation", "dislocationAllowance",
      "leaveEncashment", "bonus", "arrears", "autoAllowance", "incentive", "fuelAllowance",
      "othersAllowances", "grossSalary", "leaveDeductions", "lateDeductions", "eobiDeduction",
      "sessiDeduction", "providentFundDeduction", "gratuityFundDeduction",
      "advanceSalaryDeductions", "medicalInsurance", "lifeInsurance", "penalties", "othersDeductions",
      "taxDeduction"
    ];

    for (const field of fieldsToDecrypt) {
      if (slip[field]) {
        decryptedFields[field] = decrypt(slip[field], key);
      }
    }

    if (slip.loanDeductions) {
      decryptedFields.loanDeductions = {
        vehicleLoan: slip.loanDeductions.vehicleLoan
          ? decrypt(slip.loanDeductions.vehicleLoan, key)
          : "",
        otherLoans: slip.loanDeductions.otherLoans
          ? decrypt(slip.loanDeductions.otherLoans, key)
          : ""
      };
    }

    return res.json({ slipId, decryptedFields });

  } catch (e) {
    return res.status(400).json({ error: "Wrong decryption key or corrupted data" });
  }
});
module.exports = router;
