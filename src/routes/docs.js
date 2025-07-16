// routes/docs.js (or similar)
const express = require("express");
const router = express.Router();
const fs = require("fs-extra");
const path = require("path");
const Employee = require("../models/Employees");
const PDFDocument = require("pdfkit");

const UPLOAD_DIR = path.join(__dirname, "../uploads");

// Helper: ensure uploads folder exists
fs.ensureDirSync(UPLOAD_DIR);

// ----- PDF GENERATION HELPERS -----

// NDA PDF generator
function generateNdaPdf(employee) {
  const pdfPath = path.join(UPLOAD_DIR, `nda_${employee._id}.pdf`);
  const doc = new PDFDocument();

  doc.pipe(fs.createWriteStream(pdfPath));
  doc.fontSize(24).text("NON-DISCLOSURE AGREEMENT", { align: "center" });
  doc.moveDown();
  doc.fontSize(14).text(`This NDA is entered into by ${employee.name} (CNIC: ${employee.cnic}) for employment as ${employee.designation} in ${employee.department}.`);
  doc.moveDown();
  doc.text("Date: " + new Date().toLocaleDateString());
  doc.moveDown();
  doc.text("Confidentiality and terms...");
  doc.end();

  return pdfPath;
}

// Contract PDF generator
function generateContractPdf(employee) {
  const pdfPath = path.join(UPLOAD_DIR, `contract_${employee._id}.pdf`);
  const doc = new PDFDocument();

  doc.pipe(fs.createWriteStream(pdfPath));
  doc.fontSize(24).text("EMPLOYMENT CONTRACT", { align: "center" });
  doc.moveDown();
  doc.fontSize(14).text(`This contract is made between the employer and ${employee.name} for the position of ${employee.designation} in ${employee.department}.`);
  doc.moveDown();
  doc.text("Joining Date: " + (employee.joiningDate?.toISOString?.() || employee.joiningDate || "-"));
  doc.moveDown();
  doc.text("Terms and conditions...");
  doc.end();

  return pdfPath;
}

// Salary Certificate PDF generator
function generateSalaryCertificatePdf(employee) {
  const pdfPath = path.join(UPLOAD_DIR, `salary_certificate_${employee._id}.pdf`);
  const doc = new PDFDocument();

  doc.pipe(fs.createWriteStream(pdfPath));
  doc.fontSize(22).text("SALARY CERTIFICATE", { align: "center" });
  doc.moveDown();
  doc.fontSize(14).text(`This is to certify that ${employee.name} (CNIC: ${employee.cnic}) is employed as ${employee.designation} in ${employee.department}.`);
  doc.moveDown();
  doc.text(`Gross Salary: PKR ${employee.compensation?.grossSalary || "-"}`);
  doc.moveDown();
  doc.text("Issued on: " + new Date().toLocaleDateString());
  doc.end();

  return pdfPath;
}

// Helper: Wait for file write
async function waitForFileWrite(filepath, timeout = 3000) {
  const started = Date.now();
  while (!fs.existsSync(filepath)) {
    await new Promise((r) => setTimeout(r, 100));
    if (Date.now() - started > timeout) break;
  }
  return fs.existsSync(filepath);
}

// ----- ROUTES -----

// GET NDA PDF by employeeId (auto-generate if missing)
router.get("/nda/:employeeId", async (req, res) => {
  const emp = await Employee.findById(req.params.employeeId);
  if (!emp) return res.status(404).send("Employee not found.");

  let ndaPath = emp.ndaPath;
  // If path is missing or file does not exist, generate
  if (!ndaPath || !fs.existsSync(ndaPath)) {
    ndaPath = generateNdaPdf(emp);
    await waitForFileWrite(ndaPath);
    emp.ndaPath = ndaPath;
    await emp.save();
  }
  if (!fs.existsSync(ndaPath)) return res.status(500).send("Failed to generate NDA.");
  res.set("Content-Type", "application/pdf");
  res.set("Content-Disposition", "inline; filename=NDA.pdf");
  res.sendFile(path.resolve(ndaPath));
});

// GET Contract PDF by employeeId (auto-generate if missing)
router.get("/contract/:employeeId", async (req, res) => {
  const emp = await Employee.findById(req.params.employeeId);
  if (!emp) return res.status(404).send("Employee not found.");

  let contractPath = emp.contractPath;
  if (!contractPath || !fs.existsSync(contractPath)) {
    contractPath = generateContractPdf(emp);
    await waitForFileWrite(contractPath);
    emp.contractPath = contractPath;
    await emp.save();
  }
  if (!fs.existsSync(contractPath)) return res.status(500).send("Failed to generate contract.");
  res.set("Content-Type", "application/pdf");
  res.set("Content-Disposition", "inline; filename=Contract.pdf");
  res.sendFile(path.resolve(contractPath));
});

// GET Salary Certificate PDF by employeeId (auto-generate if missing)
router.get("/salary-certificate/:employeeId", async (req, res) => {
  const emp = await Employee.findById(req.params.employeeId);
  if (!emp) return res.status(404).send("Employee not found.");

  let salaryCertPath = emp.salaryCertificatePath;
  if (!salaryCertPath || !fs.existsSync(salaryCertPath)) {
    salaryCertPath = generateSalaryCertificatePdf(emp);
    await waitForFileWrite(salaryCertPath);
    emp.salaryCertificatePath = salaryCertPath;
    await emp.save();
  }
  if (!fs.existsSync(salaryCertPath)) return res.status(500).send("Failed to generate salary certificate.");
  res.set("Content-Type", "application/pdf");
  res.set("Content-Disposition", "inline; filename=SalaryCertificate.pdf");
  res.sendFile(path.resolve(salaryCertPath));
});

module.exports = router;
