const ClientInfo = require("../models/ClientInfo");
const Employee = require("../models/Employees");

// Manager creates client info
exports.createClientInfo = async (req, res) => {
  try {
    const emp = await Employee.findById(req.employee._id);

    if (!emp) return res.status(404).json({ error: "Employee not found" });
    if (emp.role !== "Manager") {
      return res.status(403).json({ error: "Only Managers can create client info" });
    }

    const { ownerId, ...rest } = req.body;

    if (!ownerId) {
      return res.status(400).json({ error: "ownerId is required" });
    }

    const doc = await ClientInfo.create({
      ...rest,
      owner: ownerId,
      createdBy: emp._id,
    });

    res.status(201).json(doc);
  } catch (err) {
    console.error("createClientInfo error:", err);
    res.status(500).json({ error: "Failed to create client info" });
  }
};

// Owner fetches all their client info
exports.getClientInfoByOwner = async (req, res) => {
  try {
    const emp = await Employee.findById(req.employee._id);

    if (!emp) return res.status(404).json({ error: "Employee not found" });
    if (emp.role !== "Owner") {
      return res.status(403).json({ error: "Only Owners can view client info" });
    }

    const clients = await ClientInfo.find({ owner: emp._id }).sort({ createdAt: -1 });
    res.json(clients);
  } catch (err) {
    console.error("getClientInfoByOwner error:", err);
    res.status(500).json({ error: "Failed to fetch client info" });
  }
};
