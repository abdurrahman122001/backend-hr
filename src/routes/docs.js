const express = require("express");
const router = express.Router();
const Employee = require("../models/Employees");
const {
  fetchNdaPdf,
  fetchContractPdf,
  fetchSalaryCertificatePdf, // <--- ADD THIS
} = require("../services/ndaService");

// GET NDA PDF by employeeId
router.get("/nda/:employeeId", async (req, res) => {
  const emp = await Employee.findById(req.params.employeeId).lean();
  if (!emp || !emp.ndaPath) return res.status(404).send("NDA not found.");
  const pdf = fetchNdaPdf(req.params.employeeId);
  if (!pdf) return res.status(404).send("NDA file missing.");
  res.set("Content-Type", "application/pdf");
  res.set("Content-Disposition", "inline; filename=NDA.pdf");
  res.send(pdf);
});

// GET Contract PDF by employeeId
router.get("/contract/:employeeId", async (req, res) => {
  const emp = await Employee.findById(req.params.employeeId).lean();
  if (!emp || !emp.contractPath) return res.status(404).send("Contract not found.");
  const pdf = fetchContractPdf(req.params.employeeId);
  if (!pdf) return res.status(404).send("Contract file missing.");
  res.set("Content-Type", "application/pdf");
  res.set("Content-Disposition", "inline; filename=Contract.pdf");
  res.send(pdf);
});

// GET Salary Certificate PDF by employeeId
router.get("/salary-certificate/:employeeId", async (req, res) => {
  const emp = await Employee.findById(req.params.employeeId).lean();
  if (!emp) 
    return res.status(404).send("Employee not found.");
  const pdf = fetchSalaryCertificatePdf(req.params.employeeId);
  if (!pdf) return res.status(404).send("Salary Certificate file missing.");
  res.set("Content-Type", "application/pdf");
  res.set("Content-Disposition", "inline; filename=SalaryCertificate.pdf");
  res.send(pdf);
});

module.exports = router;
