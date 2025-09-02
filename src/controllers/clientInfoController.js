const mongoose = require("mongoose");
const ClientInfo = require("../models/ClientInfo");
const Employee = require("../models/Employees");

// Manager creates client info (unchanged)
exports.createClientInfo = async (req, res) => {
  try {
    const emp = await Employee.findById(req.employee._id);
    if (!emp) return res.status(404).json({ error: "Employee not found" });
    if (emp.role !== "Manager") {
      return res.status(403).json({ error: "Only Managers can create client info" });
    }

    const { ownerId, ...rest } = req.body;
    if (!ownerId) return res.status(400).json({ error: "ownerId is required" });

    const doc = await ClientInfo.create({
      ...rest,
      owner: ownerId,         // User _id
      createdBy: emp._id,     // Manager employee _id
    });

    res.status(201).json(doc);
  } catch (err) {
    console.error("createClientInfo error:", err);
    res.status(500).json({ error: "Failed to create client info" });
  }
};

// Owner or Employee fetches client info (unchanged)
exports.getClientInfo = async (req, res) => {
  try {
    const emp = await Employee.findById(req.employee._id).select("_id role owner");
    if (!emp) return res.status(404).json({ error: "Employee not found" });

    let q;
    if (emp.role === "Owner") {
      if (!emp.owner) return res.status(400).json({ error: "This owner record has no linked user id." });
      q = { owner: emp.owner };
    } else {
      q = { assignedTo: emp._id };
    }

    const clients = await ClientInfo.find(q)
      .sort({ createdAt: -1 })
      .populate("assignedTo", "_id name companyEmail");

    res.json(clients);
  } catch (err) {
    console.error("getClientInfo error:", err);
    res.status(500).json({ error: "Failed to fetch client info" });
  }
};

// ✅ Explicit: only my assigned clients (cast employeeId, add tiny debug)
exports.getMyClients = async (req, res) => {
  try {
    const employeeId = req.employee._id;
    const asObjectId = new mongoose.Types.ObjectId(employeeId);

    const clients = await ClientInfo.find({ assignedTo: asObjectId })
      .sort({ createdAt: -1 })
      .populate("assignedTo", "_id name companyEmail");

    // Optional tiny server log you can keep or remove:
    console.log(`[getMyClients] emp=${employeeId} -> ${clients.length} clients`);

    res.json(clients);
  } catch (err) {
    console.error("getMyClients error:", err);
    res.status(500).json({ error: "Server error" });
  }
};
