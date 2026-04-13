const express = require("express");
const router = express.Router();
const ScheduledAllowance = require("../models/ScheduledAllowance");

// NOTE: anyPayrollAuth middleware is applied to this router in index.js

// Create a Scheduled Allowance
router.post("/", async (req, res) => {
  try {
    const { employee, allowanceType, amount, startMonth, endMonth } = req.body;
    const newAllowance = new ScheduledAllowance({
      owner: req.user.owner,
      employee,
      allowanceType,
      amount,
      startMonth,
      endMonth,
    });
    await newAllowance.save();
    res.status(201).json(newAllowance);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all Scheduled Allowances for owner
router.get("/", async (req, res) => {
  try {
    const allowances = await ScheduledAllowance.find({ owner: req.user.owner })
      .populate("employee", "name email companyEmail department designation")
      .sort({ createdAt: -1 });
    res.json(allowances);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update a Scheduled Allowance
router.put("/:id", async (req, res) => {
  try {
    const updated = await ScheduledAllowance.findOneAndUpdate(
      { _id: req.params.id, owner: req.user.owner },
      req.body,
      { new: true }
    );
    if (!updated) return res.status(404).json({ error: "Not found" });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a Scheduled Allowance
router.delete("/:id", async (req, res) => {
  try {
    const deleted = await ScheduledAllowance.findOneAndDelete({
      _id: req.params.id,
      owner: req.user.owner,
    });
    if (!deleted) return res.status(404).json({ error: "Not found" });
    res.json({ message: "Deleted successfully" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
