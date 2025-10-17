const mongoose = require("mongoose");
const ClientInfo = require("../models/ClientInfo");
const Employee = require("../models/Employees");

/* ---------- helpers ---------- */
const isManagerLike = (role) => {
  const r = String(role || "").trim().toLowerCase();
  return r === "manager" || r === "team lead" || r === "team_lead" || r === "teamlead";
};

/**
 * POST /api/client-info
 * Manager/Team Lead creates client info
 */
exports.createClientInfo = async (req, res) => {
  try {
    const emp = await Employee.findById(req.employee._id);
    if (!emp) return res.status(404).json({ error: "Employee not found" });

    if (!isManagerLike(emp.role)) {
      return res.status(403).json({ error: "Only Managers/Team Leads can create client info" });
    }

    const { ownerId, ...rest } = req.body;
    if (!ownerId) return res.status(400).json({ error: "ownerId is required" });

    const doc = await ClientInfo.create({
      ...rest,
      owner: ownerId,       // User _id
      createdBy: emp._id,   // creator (manager or team lead)
    });

    res.status(201).json(doc);
  } catch (err) {
    console.error("createClientInfo error:", err);
    res.status(500).json({ error: "Failed to create client info" });
  }
};

/**
 * GET /api/client-info
 * - Owner: all clients under their linked `owner` id
 * - Manager/Team Lead: all clients under their `owner`
 * - Employee: only clients assigned to them
 */
exports.getClientInfo = async (req, res) => {
  try {
    const emp = await Employee.findById(req.employee._id).select("_id role owner");
    if (!emp) return res.status(404).json({ error: "Employee not found" });

    let q;
    const role = String(emp.role || "").trim();

    if (role === "Owner") {
      if (!emp.owner)
        return res.status(400).json({ error: "This owner record has no linked user id." });
      q = { owner: emp.owner };
    } else if (isManagerLike(role)) {
      if (!emp.owner)
        return res.status(400).json({ error: "Your profile is missing owner id." });
      q = { owner: emp.owner };
    } else {
      // regular employee
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

/**
 * GET /api/client-info/my
 * Explicit: only my assigned clients (any role)
 */
exports.getMyClients = async (req, res) => {
  try {
    const employeeId = req.employee._id;
    const asObjectId = new mongoose.Types.ObjectId(employeeId);

    const clients = await ClientInfo.find({ assignedTo: asObjectId })
      .sort({ createdAt: -1 })
      .populate("assignedTo", "_id name companyEmail");

    console.log(`[getMyClients] emp=${employeeId} -> ${clients.length} clients`);

    res.json(clients);
  } catch (err) {
    console.error("getMyClients error:", err);
    res.status(500).json({ error: "Server error" });
  }
};

/**
 * PUT /api/client-info/:id
 * Update a client info record (all fields allowed)
 */
exports.updateClientInfo = async (req, res) => {
  try {
    const emp = await Employee.findById(req.employee._id);
    if (!emp) return res.status(404).json({ error: "Employee not found" });

    const { id } = req.params;
    const client = await ClientInfo.findById(id);
    if (!client) return res.status(404).json({ error: "Client not found" });

    // Role-based access
    const role = String(emp.role || "").trim().toLowerCase();
    if (
      role !== "owner" &&
      !isManagerLike(emp.role) &&
      String(client.assignedTo) !== String(emp._id)
    ) {
      return res.status(403).json({ error: "Not authorized to update this client info" });
    }

    // Allow all fields from body to be updated
    const updates = req.body;

    const updated = await ClientInfo.findByIdAndUpdate(id, updates, { new: true })
      .populate("assignedTo", "_id name companyEmail");

    res.json(updated);
  } catch (err) {
    console.error("updateClientInfo error:", err);
    res.status(500).json({ error: "Failed to update client info" });
  }
};

/**
 * DELETE /api/client-info/:id
 * Delete a client info record
 */
exports.deleteClientInfo = async (req, res) => {
  try {
    const emp = await Employee.findById(req.employee._id);
    if (!emp) return res.status(404).json({ error: "Employee not found" });

    const { id } = req.params;
    const client = await ClientInfo.findById(id);
    if (!client) return res.status(404).json({ error: "Client not found" });

    const role = String(emp.role || "").trim().toLowerCase();

    // Authorization: only Owner, Manager, Team Lead, or creator can delete
    if (
      role !== "owner" &&
      !isManagerLike(emp.role) &&
      String(client.createdBy) !== String(emp._id)
    ) {
      return res.status(403).json({ error: "Not authorized to delete this client info" });
    }

    await client.deleteOne();

    res.json({ success: true, message: "Client info deleted successfully" });
  } catch (err) {
    console.error("deleteClientInfo error:", err);
    res.status(500).json({ error: "Failed to delete client info" });
  }
};

exports.getClientById = async (req, res) => {
  try {
    const emp = await Employee.findById(req.employee._id).select("role");
    if (!emp) return res.status(404).json({ error: "Employee not found" });

    const { id } = req.params;
    const client = await ClientInfo.findById(id).populate(
      "assignedTo",
      "_id name companyEmail"
    );

    if (!client) return res.status(404).json({ error: "Client not found" });

    // Optional: restrict access (only Owner, Manager/Team Lead, or assigned employee)
    const role = String(emp.role || "").trim().toLowerCase();
    if (
      role !== "owner" &&
      !isManagerLike(emp.role) &&
      String(client.assignedTo?._id) !== String(emp._id)
    ) {
      return res.status(403).json({ error: "Not authorized to view this client" });
    }

    res.json(client);
  } catch (err) {
    console.error("getClientById error:", err);
    res.status(500).json({ error: "Failed to fetch client info" });
  }
};