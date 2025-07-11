// routes/staff.js

const express           = require("express");
const multer            = require("multer");
const path              = require("path");
const fs                = require("fs");
const bcrypt            = require("bcryptjs");
const router            = express.Router();
const requireAuth       = require("../middleware/auth");

const Employee          = require("../models/Employees");
const SalarySlip        = require("../models/SalarySlip");
const EmployeeHierarchy = require("../models/EmployeeHierarchy");
const Certificate       = require("../models/Certificate");
const DecryptionKey     = require("../models/DecryptionKey");
const { encrypt, decrypt } = require("../utils/encryption");

// ——— Multer storage: photos vs. temp certificates ———
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    let destPath;
    if (file.fieldname === "photographFile") {
      destPath = path.join(__dirname, "../uploads/photos");
    } else {
      // e.g. interCertificate → "inter"
      const type = file.fieldname.replace("Certificate", "").toLowerCase();
      destPath = path.join(__dirname, "../uploads/certificates/temp", type);
    }
    fs.mkdirSync(destPath, { recursive: true });
    cb(null, destPath);
  },
  filename: (req, file, cb) => {
    const safeName = file.originalname.replace(/\s+/g, "_");
    cb(null, `${Date.now()}_${safeName}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
});

// ——— Create Employee + Certificates + SalarySlip ———
router.post(
  "/create",
  requireAuth,
  upload.fields([
    { name: "photographFile",      maxCount: 1 },
    { name: "matricCertificate",   maxCount: 1 },
    { name: "interCertificate",    maxCount: 1 },
    { name: "graduateCertificate", maxCount: 1 },
    { name: "mastersCertificate",  maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      // — Destructure unencrypted fields —
      const {
        name, email, companyEmail, password,
        fatherOrHusbandName, cnic, dateOfBirth,
        gender, nationality, cnicIssueDate, cnicExpiryDate,
        maritalStatus, religion, latestQualification, fieldOfQualification,
        phone, permanentAddress, presentAddress,
        bankName, bankAccountNumber,
        nomineeName, nomineeRelation, nomineeCnic, nomineeNo,
        emergencyContactName, emergencyContactRelation, emergencyContactNumber,
        rt, department, designation, joiningDate, leaveEntitlement,
        seniorId, juniorId, relation,
        isHR, isAdmin,
        // compensation defaults
        basic=0, dearnessAllowance=0, houseRentAllowance=0,
        conveyanceAllowance=0, medicalAllowance=0, utilityAllowance=0,
        overtimeComp=0, dislocationAllowance=0, leaveEncashment=0,
        bonus=0, arrears=0, autoAllowance=0, incentive=0,
        fuelAllowance=0, othersAllowances=0, grossSalary=0,
        // deductions defaults
        leaveDeductions=0, lateDeductions=0, eobiDeduction=0,
        sessiDeduction=0, providentFundDeduction=0, gratuityFundDeduction=0,
        vehicleLoanDeduction=0, otherLoanDeductions=0,
        advanceSalaryDeductions=0, medicalInsurance=0,
        lifeInsurance=0, penalties=0, otherDeductions=0, taxDeduction=0
      } = req.body;

      // — HR flag & password check —
      const hrFlag = isHR === "true" || isHR === true;
      if (hrFlag && !password) {
        return res.status(400).json({
          status: "error",
          message: "Password is required when isHR = true.",
        });
      }

      // — Build & encrypt compensation —
      const compMap = {
        basic, dearnessAllowance, houseRentAllowance,
        conveyanceAllowance, medicalAllowance, utilityAllowance,
        overtimeComp, dislocationAllowance, leaveEncashment,
        bonus, arrears, autoAllowance, incentive,
        fuelAllowance, othersAllowances, grossSalary
      };
      const compEntries = await Promise.all(
        Object.entries(compMap).map(async ([k, v]) => [k, await encrypt(String(v))])
      );
      const compensation = Object.fromEntries(compEntries);

      // — Build & encrypt deductions —
      const dedFlat = {
        leaveDeductions, lateDeductions,
        eobiDeduction, sessiDeduction,
        providentFundDeduction, gratuityFundDeduction,
        advanceSalaryDeductions, medicalInsurance,
        lifeInsurance, penalties, otherDeductions, taxDeduction
      };
      const dedFlatEntries = await Promise.all(
        Object.entries(dedFlat).map(async ([k, v]) => [k, await encrypt(String(v))])
      );
      const dedLoans = { vehicleLoan: vehicleLoanDeduction, otherLoans: otherLoanDeductions };
      const dedLoanEntries = await Promise.all(
        Object.entries(dedLoans).map(async ([k, v]) => [k, await encrypt(String(v))])
      );

      const deductions = Object.fromEntries(dedFlatEntries);
      deductions.loanDeductions = Object.fromEntries(dedLoanEntries);

      // — Create new Employee document —
      const emp = new Employee({
        owner:               req.user._id,
        name, email, companyEmail,
        password:            hrFlag ? password : undefined,
        fatherOrHusbandName, cnic,
        photographUrl:       req.files.photographFile?.[0]
                               ? `/uploads/photos/${req.files.photographFile[0].filename}`
                               : undefined,
        dateOfBirth:         dateOfBirth   ? new Date(dateOfBirth)   : undefined,
        gender, nationality,
        cnicIssueDate:       cnicIssueDate ? new Date(cnicIssueDate) : undefined,
        cnicExpiryDate:      cnicExpiryDate? new Date(cnicExpiryDate): undefined,
        maritalStatus, religion,
        latestQualification, fieldOfQualification,
        phone, permanentAddress, presentAddress,
        bankName, bankAccountNumber,
        nomineeName, nomineeRelation, nomineeCnic, nomineeNo,
        emergencyContactName, emergencyContactRelation, emergencyContactNumber,
        rt, department, designation,
        joiningDate:         joiningDate   ? new Date(joiningDate)   : undefined,
        leaveEntitlement: {
          total: Number(leaveEntitlement) || 0,
          usedPaid: 0, usedUnpaid: 0
        },
        compensation,
        deductions,
        isHR: hrFlag,
        isAdmin: isAdmin === "true" || isAdmin === true
      });
      await emp.save();

      // — Move & save certificates —
      const certFields = [
        { field: "matricCertificate",   type: "matric"    },
        { field: "interCertificate",    type: "inter"     },
        { field: "graduateCertificate", type: "graduate"  },
        { field: "mastersCertificate",  type: "masters"   },
      ];
      for (const { field, type } of certFields) {
        const files = req.files[field];
        if (!files?.[0]) continue;
        const file     = files[0];
        const tempPath = file.path;
        const finalDir = path.join(__dirname, "../uploads/certificates", String(emp._id), type);
        fs.mkdirSync(finalDir, { recursive: true });

        const fileName = path.basename(file.filename);
        const newPath  = path.join(finalDir, fileName);
        fs.renameSync(tempPath, newPath);

        const fileUrl = `/uploads/certificates/${emp._id}/${type}/${fileName}`;
        await Certificate.create({ employee: emp._id, type, fileUrl });
      }

      // — Create initial SalarySlip using the same encrypted values —
      const slip = new SalarySlip({
        employee: emp._id,
        generatedOn: new Date(),
        basic:                  compensation.basic,
        dearnessAllowance:      compensation.dearnessAllowance,
        houseRentAllowance:     compensation.houseRentAllowance,
        conveyanceAllowance:    compensation.conveyanceAllowance,
        medicalAllowance:       compensation.medicalAllowance,
        utilityAllowance:       compensation.utilityAllowance,
        overtimeCompensation:   compensation.overtimeComp,
        dislocationAllowance:   compensation.dislocationAllowance,
        leaveEncashment:        compensation.leaveEncashment,
        bonus:                  compensation.bonus,
        arrears:                compensation.arrears,
        autoAllowance:          compensation.autoAllowance,
        incentive:              compensation.incentive,
        fuelAllowance:          compensation.fuelAllowance,
        othersAllowances:       compensation.othersAllowances,
        grossSalary:            compensation.grossSalary,
        leaveDeductions:        deductions.leaveDeductions,
        lateDeductions:         deductions.lateDeductions,
        eobiDeduction:          deductions.eobiDeduction,
        sessiDeduction:         deductions.sessiDeduction,
        providentFundDeduction: deductions.providentFundDeduction,
        gratuityFundDeduction:  deductions.gratuityFundDeduction,
        loanDeductions:         deductions.loanDeductions,
        advanceSalaryDeductions:deductions.advanceSalaryDeductions,
        medicalInsurance:       deductions.medicalInsurance,
        lifeInsurance:          deductions.lifeInsurance,
        penalties:              deductions.penalties,
        othersDeductions:       deductions.otherDeductions,
        taxDeduction:           deductions.taxDeduction,
      });
      await slip.save();

      // — Create hierarchy links if provided —
      if (seniorId) {
        await EmployeeHierarchy.create({
          owner:  req.user._id,
          senior: seniorId,
          junior: emp._id,
          relation
        });
      }
      if (juniorId) {
        await EmployeeHierarchy.create({
          owner:  req.user._id,
          senior: emp._id,
          junior: juniorId,
          relation
        });
      }

      // — Success response —
      res.json({
        status: "success",
        data: { employee: emp, salarySlip: slip }
      });
    }
    catch (err) {
      console.error("❌ staff/create error:", err);
      res.status(500).json({ status: "error", message: err.message });
    }
  }
);

// ——— Delete all endpoint ———
router.delete("/delete-all", requireAuth, async (req, res) => {
  try {
    await SalarySlip.deleteMany({});
    await EmployeeHierarchy.deleteMany({});
    await Employee.deleteMany({});
    res.json({ status: "success", message: "All data cleared." });
  } catch (err) {
    console.error("❌ staff/delete-all error:", err);
    res.status(500).json({ status: "error", message: err.message });
  }
});

// ——— Delete single employee & related ———
router.delete("/:id", requireAuth, async (req, res) => {
  try {
    const eid = req.params.id;
    await SalarySlip.deleteMany({ employee: eid });
    await EmployeeHierarchy.deleteMany({ $or: [{ senior: eid }, { junior: eid }] });
    await Employee.deleteOne({ _id: eid });
    res.json({ status: "success", message: "Employee deleted." });
  } catch (err) {
    console.error("❌ staff/:id DELETE error:", err);
    res.status(500).json({ status: "error", message: err.message });
  }
});

// ——— Decrypt route ———
router.post("/decrypt", requireAuth, async (req, res) => {
  const { slipId, key } = req.body;
  if (!slipId || !key) {
    return res.status(400).json({ error: "slipId and key required" });
  }

  const slip = await SalarySlip.findById(slipId);
  if (!slip) {
    return res.status(404).json({ error: "Slip not found" });
  }

  // verify bcrypt hash
  const userKey = await DecryptionKey.findOne({ owner: req.user._id, active: true });
  if (!userKey) {
    return res.status(403).json({ error: "No active decryption key found" });
  }
  const match = await bcrypt.compare(key, userKey.hash);
  if (!match) {
    return res.status(403).json({ error: "Invalid decryption key" });
  }

  try {
    const out = {};
    const fields = [
      "basic","dearnessAllowance","houseRentAllowance","conveyanceAllowance",
      "medicalAllowance","utilityAllowance","overtimeCompensation","dislocationAllowance",
      "leaveEncashment","bonus","arrears","autoAllowance","incentive","fuelAllowance",
      "othersAllowances","grossSalary","leaveDeductions","lateDeductions",
      "eobiDeduction","sessiDeduction","providentFundDeduction","gratuityFundDeduction",
      "advanceSalaryDeductions","medicalInsurance","lifeInsurance","penalties",
      "othersDeductions","taxDeduction"
    ];

    for (const f of fields) {
      if (slip[f]) {
        out[f] = await decrypt(slip[f]);
      }
    }

    if (slip.loanDeductions) {
      out.loanDeductions = {
        vehicleLoan: slip.loanDeductions.vehicleLoan
          ? await decrypt(slip.loanDeductions.vehicleLoan)
          : "",
        otherLoans: slip.loanDeductions.otherLoans
          ? await decrypt(slip.loanDeductions.otherLoans)
          : ""
      };
    }

    res.json({ slipId, decryptedFields: out });
  } catch (e) {
    res.status(400).json({ error: "Decryption failed" });
  }
});

module.exports = router;
