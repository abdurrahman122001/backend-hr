// routes/pf.js
const express = require('express');
const router = express.Router();
const PFSetting = require('../models/PFSetting');
const Employee = require('../models/Employees'); // path as per your project

// Get latest PF setting
router.get('/', async (req, res) => {
  try {
    const latest = await PFSetting.findOne().sort({ updatedAt: -1 });
    res.json(latest);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch PF settings' });
  }
});

// Set new global PF setting (admin)
router.post('/', async (req, res) => {
  try {
    const { pfRate, years } = req.body;
    // Optional: set req.user._id if using auth
    const pf = await PFSetting.create({ pfRate, years, updatedBy: req.user?._id });
    res.json(pf);
  } catch (err) {
    res.status(500).json({ error: 'Failed to set PF setting' });
  }
});

// Apply current global PF to all employees (can be restricted to admin only)
router.post('/apply-to-all', async (req, res) => {
  try {
    const latest = await PFSetting.findOne().sort({ updatedAt: -1 });
    if (!latest) return res.status(400).json({ message: 'No PF setting found' });
    // Only update employees **without override**
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
    res.json({ updated: result.nModified || result.modifiedCount || 0 });
  } catch (err) {
    res.status(500).json({ error: 'Failed to apply PF to all employees' });
  }
});

// Set PF override for a single employee
router.patch('/employee/:id', async (req, res) => {
  try {
    const { pfRate, years } = req.body;
    const emp = await Employee.findByIdAndUpdate(req.params.id, {
      "providentFund.pfRate": pfRate,
      "providentFund.years": years,
      "providentFund.override": true
    }, { new: true });
    res.json(emp);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update employee PF' });
  }
});

// Remove override for a single employee (back to global)
router.patch('/employee/:id/remove-override', async (req, res) => {
  try {
    const emp = await Employee.findByIdAndUpdate(req.params.id, {
      $unset: { "providentFund.pfRate": "", "providentFund.years": "" },
      "providentFund.override": false
    }, { new: true });
    res.json(emp);
  } catch (err) {
    res.status(500).json({ error: 'Failed to remove PF override' });
  }
});

module.exports = router;
