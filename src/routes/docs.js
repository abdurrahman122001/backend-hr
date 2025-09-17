const express = require("express");
const router = express.Router();
const Employee = require("../models/Employees");
const EmployeeDoc = require("../models/EmployeeDoc");

const SCHEMAS = {
  nda: {
    title: "NDA",
    fields: [
      { key: "companyName", label: "Company Name", type: "text", default: "Mavens Advisor Pvt. Ltd." },
      { key: "signatoryName", label: "Company Signatory Name", type: "text", default: "Mr. Adeel Shaikh" },
      { key: "signatoryTitle", label: "Company Signatory Title", type: "text", default: "HR MANAGER" },
      { key: "contactPhone", label: "Contact Phone", type: "text", default: "+1 (615) 988-0800" },
    ],
  },
  contract: {
    title: "Employment Contract",
    fields: [
      { key: "companyName", label: "Company Name", type: "text", default: "Mavens Advisor Pvt. Ltd." },
      { key: "probationMonths", label: "Probation (months)", type: "number", default: 3 },
      { key: "noticeDays", label: "Notice (days)", type: "number", default: 30 },
      { key: "officeStart", label: "Office Start", type: "text", default: "03:00 pm" },
      { key: "officeEnd", label: "Office End", type: "text", default: "12:00 am" },
      { key: "workDays", label: "Working Days", type: "text", default: "Monday to Saturday" },
      { key: "contactPhone", label: "Contact Phone", type: "text", default: "+1 (615) 988-0800" },
    ],
  },
  salary_certificate: {
    title: "Salary Certificate",
    fields: [
      { key: "hrManager", label: "HR Manager Name", type: "text", default: "ABDUL REHMAN ABID" },
      { key: "hrManagerDesignation", label: "HR Manager Title", type: "text", default: "HR MANAGER" },
      { key: "contactPhone", label: "Contact Phone", type: "text", default: "+1 (615) 988-0800" },
      { key: "overrideMonthlySalary", label: "Override Monthly Salary (PKR)", type: "number", default: "" },
    ],
  },
  experience_letter: {
    title: "Experience Letter",
    fields: [
      { key: "signName", label: "Signatory Name", type: "text", default: "ADEEL SHAIKH" },
      { key: "signTitle", label: "Signatory Title", type: "text", default: "CHIEF OF OPERATIONS" },
      { key: "qualitiesLine", label: "Qualities Sentence", type: "textarea", default: "…hardworking, punctual, precise, and honest." },
    ],
  },
};

router.get("/schema/:type", async (req, res) => {
  const schema = SCHEMAS[req.params.type];
  if (!schema) return res.status(404).json({ message: "Unknown document type" });
  res.json(schema);
});

router.get("/:type/:employeeId", async (req, res) => {
  const { type, employeeId } = req.params;
  const schema = SCHEMAS[type];
  if (!schema) return res.status(404).json({ message: "Unknown document type" });
  const emp = await Employee.findById(employeeId).lean();
  if (!emp) return res.status(404).json({ message: "Employee not found" });
  const doc = await EmployeeDoc.findOne({ employee: employeeId, type }).lean();
  const merged = {};
  for (const f of schema.fields) merged[f.key] = doc?.data?.[f.key] ?? f.default ?? "";
  res.json({ employee: { _id: emp._id, name: emp.name, cnic: emp.cnic, designation: emp.designation, position: emp.position, joiningDate: emp.joiningDate, leavingDate: emp.leavingDate }, type, data: merged });
});

router.post("/:type/:employeeId", async (req, res) => {
  const { type, employeeId } = req.params;
  const schema = SCHEMAS[type];
  if (!schema) return res.status(404).json({ message: "Unknown document type" });
  const emp = await Employee.findById(employeeId).lean();
  if (!emp) return res.status(404).json({ message: "Employee not found" });
  const incoming = req.body?.data || {};
  const filtered = {};
  for (const f of schema.fields) if (incoming[f.key] !== undefined) filtered[f.key] = incoming[f.key];
  const up = await EmployeeDoc.findOneAndUpdate({ employee: employeeId, type }, { $set: { data: filtered } }, { upsert: true, new: true });
  res.json({ ok: true, saved: up });
});

module.exports = router;
