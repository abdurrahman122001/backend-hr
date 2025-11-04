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
        .select("_id clientName legalBusinessName industry taxStatus companyLocation assignedTo")
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

    const isManagerLike =
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

    // For non-managers, show only clients assigned to them
    if (!isManagerLike) {
      clientQuery.assignedTo = me._id;
    }

    // Optional name filter
    if (name && name.trim()) {
      clientQuery.clientName = { $regex: name.trim(), $options: "i" };
    }

    const clients = await ClientInfo.find(clientQuery)
      .select("_id clientName legalBusinessName industry taxStatus companyLocation assignedTo")
      .populate("assignedTo", "_id name companyEmail")
      .sort({ clientName: 1 });

    res.json({ employees, clients });
  } catch (err) {
    console.error("getEmployeeRoster error:", err);
    res.status(500).json({ error: "Failed to load roster" });
  }
};

exports.getMentionedEmployees = async (req, res) => {
  try {
    const me = await Employee.findById(req.employee._id).select("_id owner role");
    if (!me) return res.status(404).json({ error: "Employee not found" });

    if (!me.owner)
      return res.status(400).json({ error: "Your profile is missing owner id" });

    const { name } = req.query; // optional name search

    const isManagerLike =
      me.role?.toLowerCase() === "manager" ||
      me.role?.toLowerCase() === "team lead" ||
      me.role?.toLowerCase() === "team_lead" ||
      me.role?.toLowerCase() === "teamlead";

    // --- Employees Query ---
    const employeeQuery = {
      owner: me.owner,
      _id: { $ne: me._id },
      $or: [
        { department: "Operations" },
        { role: { $in: ["Employee", "Manager", "Team Lead"] } },
      ],
    };

    // Optional name filter
    if (name && name.trim()) {
      employeeQuery.name = { $regex: name.trim(), $options: "i" };
    }

    const employees = await Employee.find(employeeQuery)
      .select(
        "_id name email companyEmail role department designation supervisionMode supervisor photographUrl"
      )
      .populate("supervisor", "_id name companyEmail")
      .sort({ name: 1 });

    res.json({ employees });
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

// // POST /manager/assign  (accepts JSON OR multipart with files[])
// // Requires Manager/Team Lead (same owner scope)
// exports.assignClient = async (req, res) => {
//   try {
//     const me = await Employee.findById(req.employee._id);
//     if (!me) return res.status(404).json({ error: "Employee not found" });
//     if (!isManagerLike(me.role)) return res.status(403).json({ error: "" });
//     if (!me.owner)
//       return res
//         .status(400)
//         .json({ error: "Your profile is missing owner id" });

//     // Fields can come from multipart/form-data or JSON
//     const clientId = (req.body.clientId || "").trim();
//     const employeeId = (req.body.employeeId || "").trim() || null;
//     const note = (req.body.note || "").trim();
//     const subject = (req.body.subject || "").trim();

//     if (!clientId)
//       return res.status(400).json({ error: "clientId is required" });

//     const client = await ClientInfo.findOneAndUpdate(
//       { _id: clientId, owner: me.owner },
//       { $set: { assignedTo: employeeId || null } },
//       { new: true }
//     ).populate("assignedTo", "_id name companyEmail");
//     if (!client)
//       return res
//         .status(404)
//         .json({ error: "Client not found or not under your owner" });

//     let message = null;

//     const hasFiles = Array.isArray(req.files) && req.files.length > 0;
//     const hasText = !!(note || subject);

//     if (hasFiles || hasText) {
//       const attachments = (req.files || []).map((f) => {
//         const rel = path.join("uploads", "assignments", path.basename(f.path));
//         return {
//           filename: path.basename(f.path),
//           originalName: f.originalname,
//           mimetype: f.mimetype,
//           size: f.size,
//           url: `/${rel.replace(/\\/g, "/")}`, // served statically
//           uploadedBy: me._id,
//         };
//       });

//       message = await AssignmentMessage.create({
//         owner: me.owner,
//         client: client._id,
//         sender: me._id,
//         receiver: employeeId || me._id,
//         subject: subject || `Assign: ${client.clientName}`,
//         note,
//         attachments,
//         status: "direct",
//       });
//     }

//     res.json({ client, message });
//   } catch (err) {
//     console.error("assignClient error:", err);
//     res.status(500).json({ error: "Assignment failed" });
//   }
// };
// In your managerController.js or wherever you handle client assignments
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

    // Get the client before update to know previous assignment
    const clientBeforeUpdate = await ClientInfo.findOne({ 
      _id: clientId, 
      owner: me.owner 
    }).populate("assignedTo", "_id name companyEmail");

    if (!clientBeforeUpdate)
      return res
        .status(404)
        .json({ error: "Client not found or not under your owner" });

    const previousEmployeeId = clientBeforeUpdate.assignedTo ? 
      (clientBeforeUpdate.assignedTo._id || clientBeforeUpdate.assignedTo).toString() : null;

    // Update the client assignment
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

    // 🔥 NEW: Emit socket events for real-time client assignment updates
    try {
      const io = req.app.get("io"); // Get io instance from app

      if (io) {
        // 1. Notify the newly assigned employee (if any)
        if (employeeId && employeeId !== String(me._id)) {
          io.to(`client_updates_${employeeId}`).emit("client_assignment_updated", {
            type: "CLIENT_ASSIGNED_TO_YOU",
            clientId,
            clientName: client.clientName,
            dba: client.dba || client.clientName,
            assignedBy: {
              _id: me._id,
              name: me.name
            },
            assignedAt: new Date().toISOString()
          });

          console.log(`✅ Notified employee ${employeeId} about new client assignment`);
        }

        // 2. Notify the previously assigned employee that they lost the client (if any)
        if (previousEmployeeId && previousEmployeeId !== employeeId) {
          io.to(`client_updates_${previousEmployeeId}`).emit("client_assignment_updated", {
            type: "CLIENT_UNASSIGNED_FROM_YOU",
            clientId,
            clientName: client.clientName,
            dba: client.dba || client.clientName,
            assignedAt: new Date().toISOString()
          });

          console.log(`✅ Notified previous employee ${previousEmployeeId} about client unassignment`);
        }

        // 3. Notify all managers/team leads about the assignment change
        io.to("assignment_managers").emit("client_assignment_updated", {
          type: "CLIENT_ASSIGNMENT_CHANGED",
          clientId,
          employeeId,
          assignedTo: client.assignedTo,
          clientName: client.clientName,
          dba: client.dba || client.clientName,
          assignedBy: {
            _id: me._id,
            name: me.name
          },
          assignedAt: new Date().toISOString()
        });

        console.log(`✅ Notified managers about client assignment change`);

        // 4. Also emit to assignment client room for real-time updates in the chat
        if (clientId) {
          io.to(`assignment_client_${clientId}`).emit("client_assignment_updated", {
            type: "CLIENT_ASSIGNMENT_CHANGED",
            clientId,
            employeeId,
            assignedTo: client.assignedTo,
            clientName: client.clientName,
            dba: client.dba || client.clientName,
            assignedBy: {
              _id: me._id,
              name: me.name
            },
            assignedAt: new Date().toISOString()
          });
        }
      }
    } catch (socketError) {
      console.error("❌ Error emitting assignment notifications:", socketError);
      // Don't fail the request if socket emission fails
    }

    // 🔥 NEW: Also send historical messages to newly assigned employee
    if (employeeId && employeeId !== String(me._id)) {
      try {
        const io = req.app.get("io");
        if (io) {
          // Get all messages for this client to notify the new assignee
          const clientMessages = await AssignmentMessage.find({
            client: clientId,
            isTrashed: false,
            isSpam: false,
          })
            .populate([
              { path: "owner", select: "_id name companyEmail" },
              { path: "sender", select: "_id name companyEmail role" },
              { path: "receiver", select: "_id name companyEmail role" },
              { path: "client", select: "_id clientName" },
            ])
            .sort({ createdAt: -1 })
            .limit(50); // Limit to recent messages

          // Emit each message to the newly assigned employee
          clientMessages.forEach((msg) => {
            io.to(`employee_${employeeId}`).emit("new_assignment_message", msg);
          });

          console.log(`✅ Notified employee ${employeeId} about ${clientMessages.length} historical messages for client ${clientId}`);
        }
      } catch (socketError) {
        console.error("❌ Error emitting historical messages:", socketError);
        // Don't fail the request if socket emission fails
      }
    }

    res.json({ client, message });
  } catch (err) {
    console.error("assignClient error:", err);
    res.status(500).json({ error: "Assignment failed" });
  }
};