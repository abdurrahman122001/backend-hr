// backend/src/controllers/managerController.js
const mongoose = require("mongoose");
const Employee = require("../models/Employees");
const ClientInfo = require("../models/ClientInfo");

exports.getRoster = async (req, res) => {
  try {
    const ownerId = req.employee.owner;
    if (!ownerId) return res.status(400).json({ error: "Missing owner in token context." });

    const [employees, clients] = await Promise.all([
      Employee.find({ owner: ownerId })
        .select("_id name companyEmail email role department designation")
        .lean(),
      ClientInfo.find({ owner: ownerId })
        .select("_id clientName assignedTo industry taxStatus companyLocation")
        .populate("assignedTo", "_id name companyEmail")
        .lean(),
    ]);

    return res.json({ employees, clients });
  } catch (err) {
    console.error("getRoster error:", err);
    return res.status(500).json({ error: "Server error" });
  }
};

exports.assignClient = async (req, res) => {
  try {
    const ownerId = req.employee.owner;
    if (!ownerId) return res.status(400).json({ error: "Missing owner in token context." });

    const { clientId, employeeId } = req.body;
    if (!clientId || !employeeId) {
      return res.status(400).json({ error: "clientId and employeeId are required" });
    }

    // Validate both belong to the same owner
    const [client, employee] = await Promise.all([
      ClientInfo.findOne({ _id: clientId, owner: ownerId }),
      Employee.findOne({ _id: employeeId, owner: ownerId }),
    ]);

    if (!client) return res.status(404).json({ error: "Client not found for this owner" });
    if (!employee) return res.status(404).json({ error: "Employee not found for this owner" });

    client.assignedTo = employee._id;
    await client.save();

    const populated = await ClientInfo.findById(client._id)
      .select("_id clientName assignedTo")
      .populate("assignedTo", "_id name companyEmail")
      .lean();

    return res.json({ success: true, client: populated });
  } catch (err) {
    console.error("assignClient error:", err);
    return res.status(500).json({ error: "Server error" });
  }
};
