const express = require('express');
const router = express.Router();
const crypto = require("crypto");

const PFSetting = require('../models/PFSetting');
const Employee = require('../models/Employees');
const SalarySlip = require('../models/SalarySlip');

// =====================
// GET: All employees with PF info and latest grossSalary slip (encrypted)
// =====================
router.get('/employees', async (req, res) => {
  try {
    // Fetch global PF setting
    const globalPF = await PFSetting.findOne().sort({ updatedAt: -1 }).lean();

    // Fetch employees
    const employees = await Employee.find(
      {},
      {
        name: 1,
        providentFund: 1,
        _id: 1,
      }
    ).lean();

    // Get latest salary slips for all employees
    const slips = await SalarySlip.aggregate([
      { $sort: { createdAt: -1 } },
      {
        $group: {
          _id: "$employee",
          grossSalary: { $first: "$grossSalary" },
          createdAt: { $first: "$createdAt" }
        }
      }
    ]);
    const slipMap = {};
    for (const slip of slips) {
      slipMap[slip._id.toString()] = {
        grossSalary: slip.grossSalary,
        createdAt: slip.createdAt
      };
    }

    const list = employees.map(emp => ({
      _id: emp._id,
      name: emp.name || "Unnamed",
      pfRate: emp.providentFund?.pfRate ?? null,
      years: emp.providentFund?.years ?? null,
      override: !!emp.providentFund?.override,
      grossSalary: slipMap[emp._id.toString()]?.grossSalary ?? null,
      salarySlipDate: slipMap[emp._id.toString()]?.createdAt ?? null,
    }));

    res.json({
      status: 'success',
      data: list,
      globalPF: globalPF ? { pfRate: globalPF.pfRate, years: globalPF.years } : null
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch employees PF data' });
  }
});

// =====================
// POST: Decrypt gross salary for employee with user-provided key
// =====================
router.post('/gross-salary/:empId', async (req, res) => {
  const { key } = req.body;
  if (!key) return res.status(400).json({ error: "Decryption key required." });

  try {
    const empId = req.params.empId;
    const slip = await SalarySlip.findOne({ employee: empId }).sort({ createdAt: -1 });
    if (!slip || !slip.grossSalary)
      return res.status(404).json({ error: "No salary slip found for this employee." });

    // Decrypt using key provided by user (must be 32 bytes for AES-256-CBC)
    const parts = slip.grossSalary.split(":");
    if (parts.length < 2) return res.status(400).json({ error: "Invalid encrypted format." });
    const iv = Buffer.from(parts.shift(), "base64");
    const encryptedText = parts.join(":");

    try {
      const decipher = crypto.createDecipheriv("aes-256-cbc", Buffer.from(key, "utf8"), iv);
      let decrypted = decipher.update(encryptedText, "base64", "utf8");
      decrypted += decipher.final("utf8");
      const grossSalary = Number(decrypted);
      if (isNaN(grossSalary)) return res.status(400).json({ error: "Decryption succeeded but value is not a number." });
      return res.json({ grossSalary });
    } catch (err) {
      return res.status(401).json({ error: "Invalid decryption key." });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to decrypt gross salary.' });
  }
});

// =====================
// GET: Latest global PF setting
// =====================
router.get('/', async (req, res) => {
  try {
    const latest = await PFSetting.findOne().sort({ updatedAt: -1 });
    if (!latest) {
      return res.json(null);
    }
    res.json(latest);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch PF settings.' });
  }
});

// =====================
// POST: Set new global PF setting
// =====================
router.post('/', async (req, res) => {
  try {
    const { pfRate, years } = req.body;
    if (pfRate === undefined || years === undefined) {
      return res.status(400).json({ error: "PF rate and years are required." });
    }
    const pf = await PFSetting.create({ pfRate, years, updatedBy: req.user?._id });
    res.json(pf);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to set PF setting.' });
  }
});

// =====================
// DELETE: Delete global PF setting
// =====================
router.delete('/', async (req, res) => {
  try {
    await PFSetting.deleteMany({});
    res.json({ message: 'Global PF settings deleted successfully.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete global PF settings.' });
  }
});

// =====================
// POST: Apply current global PF to all employees (except those with override)
// =====================
router.post('/apply-to-all', async (req, res) => {
  try {
    const latest = await PFSetting.findOne().sort({ updatedAt: -1 });
    if (!latest) {
      return res.status(400).json({ message: 'No global PF setting found. Please create a global PF setting first.' });
    }
    const result = await Employee.updateMany(
      { "providentFund.override": { $ne: true } },
      {
        $set: {
          "providentFund.pfRate": latest.pfRate,
          "providentFund.years": latest.years,
          "providentFund.override": false
        }
      }
    );
    res.json({ message: 'Global PF applied successfully.', updated: result.modifiedCount || 0 });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to apply PF to all employees.' });
  }
});

// =====================
// PATCH: Set override PF for single employee
// =====================
router.patch('/employee/:id', async (req, res) => {
  try {
    const { pfRate, years } = req.body;
    if (pfRate === undefined || years === undefined) {
      return res.status(400).json({ error: "PF rate and years are required." });
    }
    const emp = await Employee.findByIdAndUpdate(req.params.id, {
      "providentFund.pfRate": pfRate,
      "providentFund.years": years,
      "providentFund.override": true
    }, { new: true });
    if (!emp) {
      return res.status(404).json({ error: "Employee not found." });
    }
    res.json(emp);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update employee PF.' });
  }
});

// =====================
// PATCH: Remove override for single employee (revert to global)
// =====================
router.patch('/employee/:id/remove-override', async (req, res) => {
  try {
    const emp = await Employee.findByIdAndUpdate(req.params.id, {
      $unset: { "providentFund.pfRate": "", "providentFund.years": "" },
      "providentFund.override": false
    }, { new: true });
    if (!emp) {
      return res.status(404).json({ error: "Employee not found." });
    }
    res.json(emp);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to remove PF override.' });
  }
});

// =====================
// DELETE: Delete PF data for single employee
// =====================
router.delete('/employee/:id', async (req, res) => {
  try {
    const emp = await Employee.findByIdAndUpdate(req.params.id, {
      $unset: { 
        "providentFund.pfRate": "", 
        "providentFund.years": "",
        "providentFund.override": ""
      }
    }, { new: true });
    if (!emp) {
      return res.status(404).json({ error: "Employee not found." });
    }
    res.json({ message: 'Employee PF data deleted successfully.', employee: emp });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete employee PF data.' });
  }
});

module.exports = router;