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
      .select("_id clientName dba industry taxStatus companyLocation assignedTo")
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

    // 🔥 CRITICAL FIX: When assigning a client to an employee, share ALL existing messages with that employee
    if (employeeId && employeeId !== String(me._id)) {
      try {
        // 1. Find ALL existing messages for this client
        const existingMessages = await AssignmentMessage.find({
          client: clientId,
          isTrashed: false,
          isSpam: false,
          $or: [
            { status: 'sent' },
            { status: 'scheduled' }
          ]
        });

        // 2. For each existing message, add the employee as a receiver if not already
        const updatePromises = existingMessages.map(async (msg) => {
          const currentReceivers = Array.isArray(msg.receiver)
            ? msg.receiver.map(r => r.toString())
            : msg.receiver ? [msg.receiver.toString()] : [];

          // If employee is not already a receiver, add them
          if (!currentReceivers.includes(employeeId)) {
            const updatedReceivers = [...currentReceivers, employeeId];

            // Update the message to include the new employee as receiver
            return AssignmentMessage.findByIdAndUpdate(
              msg._id,
              {
                $set: { receiver: updatedReceivers },
                $addToSet: {
                  readBy: {
                    employee: employeeId,
                    readAt: new Date()
                  }
                }
              },
              { new: true }
            );
          }
          return Promise.resolve(null);
        });

        // Wait for all updates to complete
        const updatedMessages = await Promise.all(updatePromises.filter(p => p));

        console.log(`✅ Added employee ${employeeId} to ${updatedMessages.length} existing messages for client ${clientId}`);

        // 3. Fetch all updated messages for this client to send via socket
        const clientMessages = await AssignmentMessage.find({
          client: clientId,
          isTrashed: false,
          isSpam: false,
          $or: [
            { status: 'sent' },
            { status: 'scheduled' }
          ]
        })
          .populate([
            { path: "owner", select: "_id name companyEmail" },
            { path: "sender", select: "_id name companyEmail role" },
            { path: "receiver", select: "_id name companyEmail role" },
            { path: "client", select: "_id clientName" },
          ])
          .sort({ createdAt: -1 })
          .limit(50); // Limit to recent messages

        // 4. Emit socket events for each message to the newly assigned employee
        const io = req.app.get("io");
        if (io) {
          clientMessages.forEach((msg) => {
            // Check if this employee is a receiver of this message
            const msgReceivers = Array.isArray(msg.receiver)
              ? msg.receiver.map(r => r._id ? r._id.toString() : r.toString())
              : msg.receiver ? [msg.receiver.toString()] : [];

            if (msgReceivers.includes(employeeId)) {
              io.to(`employee_${employeeId}`).emit("new_assignment_message", msg);
              console.log(`📨 Sent historical message ${msg._id} to employee ${employeeId}`);
            }
          });

          // 5. Also send a special "client_assigned" event with all messages
          io.to(`employee_${employeeId}`).emit("client_assigned_with_history", {
            type: "CLIENT_ASSIGNED_WITH_HISTORY",
            clientId,
            clientName: client.clientName,
            dba: client.dba || client.clientName,
            assignedBy: {
              _id: me._id,
              name: me.name
            },
            assignedAt: new Date().toISOString(),
            messageCount: clientMessages.length,
            hasAccessToHistory: true
          });
        }

      } catch (historyError) {
        console.error("❌ Error sharing historical messages with new employee:", historyError);
        // Don't fail the assignment if history sharing fails
      }
    }

    // 🔥 NEW: Emit socket events for real-time client assignment updates
    try {
      const io = req.app.get("io"); // Get io instance from app

      if (io) {
        // 1. Notify the newly assigned employee (if any)
        if (employeeId && employeeId !== String(me._id)) {
          io.to(`employee_${employeeId}`).emit("client_assignment_updated", {
            type: "CLIENT_ASSIGNED_TO_YOU",
            clientId,
            clientName: client.clientName,
            dba: client.dba || client.clientName,
            assignedBy: {
              _id: me._id,
              name: me.name
            },
            assignedAt: new Date().toISOString(),
            hasHistoricalMessages: true // Indicate they now have access to history
          });
        }

        if (!employeeId && previousEmployeeId) {
          await ClientInfo.updateOne(
            { _id: clientId },
            { $pull: { readBy: { employee: previousEmployeeId } } }
          );
          console.log(`🧹 Removed ${previousEmployeeId} from readBy of client ${clientId}`);
        }

        // 2. Notify the previously assigned employee that they lost the client (if any)
        if (previousEmployeeId && previousEmployeeId !== employeeId) {
          io.to(`employee_${previousEmployeeId}`).emit("client_assignment_updated", {
            type: "CLIENT_UNASSIGNED_FROM_YOU",
            clientId,
            clientName: client.clientName,
            dba: client.dba || client.clientName,
            assignedAt: new Date().toISOString()
          });

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

    res.json({
      client,
      message,
      historicalMessagesShared: employeeId ? true : false
    });
  } catch (err) {
    console.error("assignClient error:", err);
    res.status(500).json({ error: "Assignment failed" });
  }
};