// controllers/managerController.js
const path = require("path");
const Employee = require("../models/Employees");
const ClientInfo = require("../models/ClientInfo");
const AssignmentMessage = require("../models/AssignmentMessage");

// GET /manager/roster
exports.getRoster = async (req, res) => {
  try {
    const me = await Employee.findById(req.employee._id).select(
      "_id owner role"
    );
    if (!me) return res.status(404).json({ error: "Employee not found" });
    if (me.role !== "Manager")
      return res.status(403).json({ error: "Only Managers" });
    if (!me.owner)
      return res.status(400).json({ error: "Manager has no linked owner id" });

    const [employees, clients] = await Promise.all([
      Employee.find({
        owner: me.owner,
        $or: [
          { department: "Operations" }, // ✅ department match
          { role: { $in: ["Employee", "Manager"] } }, // ✅ OR role match
        ],
      })
        .select("_id name email companyEmail role department designation")
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

// POST /manager/assign  (accepts JSON OR multipart with files[])
exports.assignClient = async (req, res) => {
  try {
    const me = await Employee.findById(req.employee._id);
    if (!me) return res.status(404).json({ error: "Employee not found" });
    if (me.role !== "Manager")
      return res.status(403).json({ error: "Only Managers can assign" });
    if (!me.owner)
      return res.status(400).json({ error: "Manager has no linked owner id" });

    // Fields can come from multipart/form-data or JSON
    const clientId = (req.body.clientId || "").trim();
    const employeeId = (req.body.employeeId || "").trim() || null;
    const note = (req.body.note || "").trim();
    const subject = (req.body.subject || "").trim();

    if (!clientId)
      return res.status(400).json({ error: "clientId is required" });

    // Update assignment on client
    const client = await ClientInfo.findOneAndUpdate(
      { _id: clientId, owner: me.owner },
      { $set: { assignedTo: employeeId || null } },
      { new: true }
    ).populate("assignedTo", "_id name companyEmail");
    if (!client)
      return res
        .status(404)
        .json({ error: "Client not found or not under your owner" });

    // If there are files or a note/subject, create an AssignmentMessage (audit trail)
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
        manager: me._id,
        client: client._id,
        toEmployee: employeeId || me._id, // if unassigning, still record to manager
        subject: subject || `Assign: ${client.clientName}`,
        note,
        attachments,
      });
    }

    res.json({ client, message });
  } catch (err) {
    console.error("assignClient error:", err);
    res.status(500).json({ error: "Assignment failed" });
  }
};
