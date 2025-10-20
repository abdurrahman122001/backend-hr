// controllers/managerController.js
const path = require("path");
const Employee = require("../models/Employees");
const ClientInfo = require("../models/ClientInfo");
const AssignmentMessage = require("../models/AssignmentMessage");

const isManagerLike = (role) => {
  const r = String(role || "")
    .trim()
    .toLowerCase();
  return (
    r === "manager" ||
    r === "team lead" ||
    r === "team_lead" ||
    r === "teamlead"
  );
};

exports.getRoster = async (req, res) => {
  try {
    const me = await Employee.findById(req.employee._id).select(
      "_id owner role"
    );
    if (!me) return res.status(404).json({ error: "Employee not found" });
    if (!isManagerLike(me.role))
      return res.status(403).json({ error: "Access denied" });
    if (!me.owner)
      return res
        .status(400)
        .json({ error: "Your profile is missing owner id" });

    const [employees, clients] = await Promise.all([
      Employee.find({
        owner: me.owner,
        $or: [
          { department: "Operations" },
          { role: { $in: ["Employee", "Manager", "Team Lead"] } },
        ],
      })
        .select(
          "_id name email companyEmail role department designation supervisionMode supervisor photographUrl"
        )
        .populate("supervisor", "_id name companyEmail")
        .sort({ name: 1 }),
      ClientInfo.find({ owner: me.owner })
        .select("_id clientName industry taxStatus companyLocation assignedTo")
        .populate("assignedTo", "_id name companyEmail")
        .sort({ createdAt: -1 }),
    ]);

    res.json({ employees, clients });
  } catch (err) {
    console.error("getRoster error:", err);
    res.status(500).json({ error: "Failed to load roster" });
  }
};

// GET /manager/employee/roster
exports.getEmployeeRoster = async (req, res) => {
  try {
    const me = await Employee.findById(req.employee._id).select("_id owner role");
    if (!me) return res.status(404).json({ error: "Employee not found" });

    if (!me.owner)
      return res.status(400).json({ error: "Your profile is missing owner id" });

    const { name } = req.query; // optional name search

    const isManager =
      me.role?.toLowerCase() === "manager" ||
      me.role?.toLowerCase() === "team lead" ||
      me.role?.toLowerCase() === "team_lead" ||
      me.role?.toLowerCase() === "teamlead";

    // --- Employees Query ---
    const employees = await Employee.find({
      owner: me.owner,
      _id: { $ne: me._id },
      $or: [
        { department: "Operations" },
        { role: { $in: ["Employee", "Manager", "Team Lead"] } },
      ],
    })
      .select(
        "_id name email companyEmail role department designation supervisionMode supervisor photographUrl"
      )
      .populate("supervisor", "_id name companyEmail")
      .sort({ name: 1 });

    // --- Clients Query ---
    const clientQuery = { owner: me.owner };
    if (!isManager) {
      // only show clients assigned to this employee
      clientQuery.assignedTo = me._id;
    }
    if (name && name.trim()) {
      clientQuery.clientName = { $regex: name.trim(), $options: "i" };
    }

    const clients = await ClientInfo.find(clientQuery)
      .select("_id clientName industry taxStatus companyLocation assignedTo")
      .populate("assignedTo", "_id name companyEmail")
      .sort({ clientName: 1 });

    res.json({ employees, clients });
  } catch (err) {
    console.error("getEmployeeRoster error:", err);
    res.status(500).json({ error: "Failed to load roster" });
  }
};


// PATCH /manager/employee/:id/supervision  { supervisionMode }
exports.updateEmployeeSupervision = async (req, res) => {
  try {
    const me = await Employee.findById(req.employee._id).select(
      "_id owner role"
    );
    if (!me) return res.status(404).json({ error: "Employee not found" });
    if (!isManagerLike(me.role)) return res.status(403).json({ error: "" });
    if (!me.owner)
      return res
        .status(400)
        .json({ error: "Your profile is missing owner id" });

    const { id } = req.params;
    const { supervisionMode } = req.body;
    if (!["direct", "needs_approval"].includes(String(supervisionMode))) {
      return res.status(400).json({ error: "Invalid supervision mode" });
    }

    const updated = await Employee.findOneAndUpdate(
      { _id: id, owner: me.owner },
      { $set: { supervisionMode } },
      { new: true, runValidators: true }
    ).select("_id name supervisionMode supervisor");

    if (!updated) return res.status(404).json({ error: "Employee not found" });

    res.json(updated);
  } catch (err) {
    console.error("updateEmployeeSupervision error:", err);
    res.status(500).json({ error: "Failed to update supervision" });
  }
};
// GET /manager/supervision-status
exports.getEmployeeSupervisionStatus = async (req, res) => {
  try {
    const me = await Employee.findById(req.employee._id).select(
      "_id owner role"
    );
    if (!me) return res.status(404).json({ error: "Employee not found" });
    if (!isManagerLike(me.role)) return res.status(403).json({ error: "" });
    if (!me.owner)
      return res
        .status(400)
        .json({ error: "Your profile is missing owner id" });

    const { id } = req.params;

    const emp = await Employee.findOne({ _id: id, owner: me.owner })
      .select(
        "_id name email companyEmail role department designation supervisionMode supervisor"
      )
      .populate("supervisor", "_id name companyEmail");

    if (!emp) return res.status(404).json({ error: "Employee not found" });

    res.json({
      ...emp.toObject(),
      hasSupervisionEnabled: emp.supervisionMode === "needs_approval",
    });
  } catch (err) {
    console.error("getEmployeeSupervisionStatus error:", err);
    res.status(500).json({ error: "Failed to load supervision status" });
  }
};

// POST /manager/assign  (accepts JSON OR multipart with files[])
// Requires Manager/Team Lead (same owner scope)
exports.assignClient = async (req, res) => {
  try {
    const me = await Employee.findById(req.employee._id);
    if (!me) return res.status(404).json({ error: "Employee not found" });
    if (!isManagerLike(me.role)) return res.status(403).json({ error: "" });
    if (!me.owner)
      return res
        .status(400)
        .json({ error: "Your profile is missing owner id" });

    // Fields can come from multipart/form-data or JSON
    const clientId = (req.body.clientId || "").trim();
    const employeeId = (req.body.employeeId || "").trim() || null;
    const note = (req.body.note || "").trim();
    const subject = (req.body.subject || "").trim();

    if (!clientId)
      return res.status(400).json({ error: "clientId is required" });

    const client = await ClientInfo.findOneAndUpdate(
      { _id: clientId, owner: me.owner },
      { $set: { assignedTo: employeeId || null } },
      { new: true }
    ).populate("assignedTo", "_id name companyEmail");
    if (!client)
      return res
        .status(404)
        .json({ error: "Client not found or not under your owner" });

    let message = null;

    const hasFiles = Array.isArray(req.files) && req.files.length > 0;
    const hasText = !!(note || subject);

    if (hasFiles || hasText) {
      const attachments = (req.files || []).map((f) => {
        const rel = path.join("uploads", "assignments", path.basename(f.path));
        return {
          filename: path.basename(f.path),
          originalName: f.originalname,
          mimetype: f.mimetype,
          size: f.size,
          url: `/${rel.replace(/\\/g, "/")}`, // served statically
          uploadedBy: me._id,
        };
      });

      message = await AssignmentMessage.create({
        owner: me.owner,
        client: client._id,
        sender: me._id,
        receiver: employeeId || me._id,
        subject: subject || `Assign: ${client.clientName}`,
        note,
        attachments,
        status: "direct",
      });
    }

    res.json({ client, message });
  } catch (err) {
    console.error("assignClient error:", err);
    res.status(500).json({ error: "Assignment failed" });
  }
};