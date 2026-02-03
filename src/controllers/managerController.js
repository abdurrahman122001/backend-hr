// controllers/managerController.js
const path = require("path");
const mongoose = require("mongoose");
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
      "_id owner role supervisor supervise supervisionMode supervisorMode"
    );

    if (!me) return res.status(404).json({ error: "Employee not found" });
    if (!me.owner)
      return res.status(400).json({ error: "Your profile is missing owner id" });

    const role = (me.role || "").trim().toLowerCase();
    const isEmployee = role === "employee";
    const isTeamLead = role === "team lead" || role === "team_lead";
    const isManager = role === "manager";

    /* ------------------ EMPLOYEES (VISIBLE TO ALL) ------------------ */
    let employeeQuery = {
      owner: me.owner,
      status: "active",
    };

    // Regular employees can only see team leads, managers, and their supervisor
    if (isEmployee && !isTeamLead && !isManager) {
      employeeQuery.$or = [
        { _id: me.supervisor }, // Their supervisor
        { role: { $in: ["Manager", "Team Lead"] } }, // All managers and team leads
        { _id: { $in: me.supervise || [] } }, // People they supervise
      ];
    } else {
      // Team leads and managers can see all operations employees
      employeeQuery.$or = [
        { department: "Operations" },
        { role: { $in: ["Employee", "Manager", "Team Lead"] } },
      ];
    }

    const employees = await Employee.find(employeeQuery)
      .select(
        "_id name email companyEmail role department designation supervisionMode supervisor supervisorMode photographUrl"
      )
      .populate("supervisor", "_id name companyEmail")
      .sort({ name: 1 });

    /* ------------------ CLIENT FILTER ------------------ */
    let clientQuery = { owner: me.owner };

    // If it's NOT a manager or team lead, only show clients they're directly assigned to
    if (!isManager && !isTeamLead) {
      // Ensure we are using a valid ObjectId for the query
      const myId = new mongoose.Types.ObjectId(me._id);

      clientQuery = {
        ...clientQuery,
        assignedTo: myId, // Mongo 'contains' query for arrays
      };
    }

    const clients = await ClientInfo.find(clientQuery)
      .select(
        "_id clientName bookkeepingSoftware legalBusinessName dba industry taxStatus companyLocation isActive phone email assignedTo supervision owner readBy companyEmployees clientEmail createdAt updatedAt"
      )
      .populate("assignedTo", "_id name companyEmail role")
      .populate("owner", "_id name companyEmail")
      .sort({ isActive: -1, createdAt: -1 });

    // Add readBy tracking for employees
    const clientsWithReadStatus = clients.map(client => {
      const clientObj = client.toObject();
      const isRead = client.readBy?.some(r => r.employee.toString() === me._id.toString());
      return {
        ...clientObj,
        readBy: client.readBy || [],
        isNewForEmployee: !isRead && !isManager && !isTeamLead,
      };
    });

    /* ------------------ CLIENT EMPLOYEES ------------------ */
    const clientEmployees = [];

    // For regular employees, only show client employees from their assigned clients
    const allowedClientIds = isEmployee && !isTeamLead && !isManager
      ? clients.map(c => c._id.toString())
      : null;

    clients.forEach((client) => {
      if (!client.companyEmployees?.length) return;

      // Filter for regular employees
      if (allowedClientIds && !allowedClientIds.includes(client._id.toString())) {
        return;
      }

      client.companyEmployees.forEach((emp) => {
        clientEmployees.push({
          _id: `${client._id}_${emp.email || emp.name.replace(/\s+/g, "_")}`,
          name: emp.name,
          email: emp.email,
          designation: emp.designation,
          phone: emp.phone,
          department: emp.department,
          isPrimaryContact: emp.isPrimaryContact,
          clientId: client._id,
          clientName: client.clientName,
          clientEmail: client.clientEmail,
          type: "company_employee",
          addedAt: emp.addedAt,
        });
      });
    });

    /* ------------------ RESPONSE ------------------ */
    res.json({
      employees,
      clients: clientsWithReadStatus,
      clientEmployees,
      userRole: role,
    });
  } catch (err) {
    console.error("getRoster error:", err);
    res.status(500).json({ error: "Failed to load roster" });
  }
};
// GET /manager/employee/roster
exports.getEmployeeRoster = async (req, res) => {
  try {
    const me = await Employee.findById(req.employee._id).select(
      "_id owner role",
    );
    if (!me) return res.status(404).json({ error: "Employee not found" });

    if (!me.owner)
      return res
        .status(400)
        .json({ error: "Your profile is missing owner id" });

    const { name } = req.query; // optional name search

    const isManagerLike =
      me.role?.toLowerCase() === "manager" ||
      me.role?.toLowerCase() === "team lead" ||
      me.role?.toLowerCase() === "team_lead" ||
      me.role?.toLowerCase() === "teamlead";

    // --- Employees Query ---
    const employees = await Employee.find({
      owner: me.owner,
      status: "active", // Only show active employees
      _id: { $ne: me._id }, // Exclude the current user
      $or: [
        { department: "Operations" },
        { role: { $in: ["Employee", "Manager", "Team Lead"] } },
      ],
    })
      .select(
        "_id name email companyEmail role department designation supervisionMode supervisor photographUrl",
      )
      .populate("supervisor", "_id name companyEmail")
      .sort({ name: 1 });

    // --- Clients Query ---
    const clientQuery = { owner: me.owner };

    // For non-managers, show only clients assigned to them
    if (!isManagerLike) {
      clientQuery.assignedTo = { $in: [me._id, me._id.toString()] };
    }

    // Optional name filter
    if (name && name.trim()) {
      clientQuery.clientName = { $regex: name.trim(), $options: "i" };
    }

    const clients = await ClientInfo.find(clientQuery)
      .select(
        "_id clientName dba industry taxStatus companyLocation assignedTo",
      )
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
    const me = await Employee.findById(req.employee._id).select(
      "_id owner role",
    );
    if (!me) return res.status(404).json({ error: "Employee not found" });

    if (!me.owner)
      return res
        .status(400)
        .json({ error: "Your profile is missing owner id" });

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
        "_id name email companyEmail role department designation supervisionMode supervisor photographUrl",
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
      "_id owner role",
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
      { new: true, runValidators: true },
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
      "_id owner role",
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
        "_id name email companyEmail role department designation supervisionMode supervisor",
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
    if (!isManagerLike(me.role))
      return res.status(403).json({ error: "Unauthorized" });
    if (!me.owner)
      return res
        .status(400)
        .json({ error: "Your profile is missing owner id" });

    const clientId = (req.body.clientId || "").trim();
    const employeeIds = req.body.employeeIds || []; // Now accepts array
    const note = (req.body.note || "").trim();
    const subject = (req.body.subject || "").trim();

    if (!clientId)
      return res.status(400).json({ error: "clientId is required" });

    // Get the client before update
    const clientBeforeUpdate = await ClientInfo.findOne({
      _id: clientId,
      owner: me.owner,
    }).populate("assignedTo", "_id name companyEmail");

    if (!clientBeforeUpdate)
      return res
        .status(404)
        .json({ error: "Client not found or not under your owner" });

    const previousEmployeeIds = clientBeforeUpdate.assignedTo
      ? clientBeforeUpdate.assignedTo.map((emp) => (emp._id || emp).toString())
      : [];

    // Validate employee IDs are valid
    const validEmployeeIds = [];
    if (Array.isArray(employeeIds) && employeeIds.length > 0) {
      const employees = await Employee.find({
        _id: { $in: employeeIds },
        owner: me.owner,
      });
      validEmployeeIds.push(...employees.map((emp) => emp._id.toString()));
    }

    // Update the client with multiple assignments
    const client = await ClientInfo.findOneAndUpdate(
      { _id: clientId, owner: me.owner },
      {
        $set: {
          assignedTo: validEmployeeIds.length > 0 ? validEmployeeIds : [],
        },
      },
      { new: true },
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
          url: `/${rel.replace(/\\/g, "/")}`,
          uploadedBy: me._id,
        };
      });

      message = await AssignmentMessage.create({
        owner: me.owner,
        client: client._id,
        sender: me._id,
        receiver: validEmployeeIds.length > 0 ? validEmployeeIds : [me._id],
        subject: subject || `Assign: ${client.clientName}`,
        note,
        attachments,
        status: "direct",
      });
    }

    // Share historical messages with newly assigned employees
    if (validEmployeeIds.length > 0) {
      try {
        const newlyAssignedIds = validEmployeeIds.filter(
          (id) => !previousEmployeeIds.includes(id),
        );

        for (const employeeId of newlyAssignedIds) {
          if (employeeId !== String(me._id)) {
            // 1. Find ALL existing messages for this client
            const existingMessages = await AssignmentMessage.find({
              client: clientId,
              isTrashed: false,
              isSpam: false,
              $or: [{ status: "sent" }, { status: "scheduled" }],
            });

            // 2. Add employee as receiver to each message
            for (const msg of existingMessages) {
              const currentReceivers = Array.isArray(msg.receiver)
                ? msg.receiver.map((r) => r.toString())
                : msg.receiver
                  ? [msg.receiver.toString()]
                  : [];

              if (!currentReceivers.includes(employeeId)) {
                const updatedReceivers = [...currentReceivers, employeeId];
                await AssignmentMessage.findByIdAndUpdate(
                  msg._id,
                  {
                    $set: { receiver: updatedReceivers },
                    $addToSet: {
                      readBy: {
                        employee: employeeId,
                        readAt: new Date(),
                      },
                    },
                  },
                  { new: true },
                );
              }
            }

            // 3. Fetch updated messages for socket emission
            const clientMessages = await AssignmentMessage.find({
              client: clientId,
              isTrashed: false,
              isSpam: false,
              $or: [{ status: "sent" }, { status: "scheduled" }],
            })
              .populate([
                { path: "owner", select: "_id name companyEmail" },
                { path: "sender", select: "_id name companyEmail role" },
                { path: "receiver", select: "_id name companyEmail role" },
                { path: "client", select: "_id clientName" },
              ])
              .sort({ createdAt: -1 })
              .limit(50);

            // 4. Emit socket events
            const io = req.app.get("io");
            if (io) {
              clientMessages.forEach((msg) => {
                const msgReceivers = Array.isArray(msg.receiver)
                  ? msg.receiver.map((r) =>
                    r._id ? r._id.toString() : r.toString(),
                  )
                  : msg.receiver
                    ? [msg.receiver.toString()]
                    : [];

                if (msgReceivers.includes(employeeId)) {
                  io.to(`employee_${employeeId}`).emit(
                    "new_assignment_message",
                    msg,
                  );
                }
              });

              io.to(`employee_${employeeId}`).emit(
                "client_assigned_with_history",
                {
                  type: "CLIENT_ASSIGNED_WITH_HISTORY",
                  clientId,
                  clientName: client.clientName,
                  dba: client.dba || client.clientName,
                  assignedBy: {
                    _id: me._id,
                    name: me.name,
                  },
                  assignedAt: new Date().toISOString(),
                  messageCount: clientMessages.length,
                  hasAccessToHistory: true,
                },
              );
            }
          }
        }
      } catch (historyError) {
        console.error("❌ Error sharing historical messages:", historyError);
      }
    }

    // Handle employees who were removed
    const removedEmployeeIds = previousEmployeeIds.filter(
      (id) => !validEmployeeIds.includes(id),
    );

    for (const removedId of removedEmployeeIds) {
      // Remove from readBy
      await ClientInfo.updateOne(
        { _id: clientId },
        { $pull: { readBy: { employee: removedId } } },
      );

      // Notify removed employee
      const io = req.app.get("io");
      if (io) {
        io.to(`employee_${removedId}`).emit("client_assignment_updated", {
          type: "CLIENT_UNASSIGNED_FROM_YOU",
          clientId,
          clientName: client.clientName,
          dba: client.dba || client.clientName,
          assignedAt: new Date().toISOString(),
        });
      }
    }

    // Emit socket notifications for newly assigned employees
    try {
      const io = req.app.get("io");

      if (io) {
        // Notify newly assigned employees
        for (const employeeId of validEmployeeIds) {
          if (employeeId !== String(me._id)) {
            io.to(`employee_${employeeId}`).emit("client_assignment_updated", {
              type: "CLIENT_ASSIGNED_TO_YOU",
              clientId,
              clientName: client.clientName,
              dba: client.dba || client.clientName,
              assignedBy: {
                _id: me._id,
                name: me.name,
              },
              assignedAt: new Date().toISOString(),
              hasHistoricalMessages: true,
            });
          }
        }

        // Notify all managers/team leads
        io.to("assignment_managers").emit("client_assignment_updated", {
          type: "CLIENT_ASSIGNMENT_CHANGED",
          clientId,
          employeeIds: validEmployeeIds,
          assignedTo: client.assignedTo,
          clientName: client.clientName,
          dba: client.dba || client.clientName,
          assignedBy: {
            _id: me._id,
            name: me.name,
          },
          assignedAt: new Date().toISOString(),
        });

        // Emit to assignment client room
        if (clientId) {
          io.to(`assignment_client_${clientId}`).emit(
            "client_assignment_updated",
            {
              type: "CLIENT_ASSIGNMENT_CHANGED",
              clientId,
              employeeIds: validEmployeeIds,
              assignedTo: client.assignedTo,
              clientName: client.clientName,
              dba: client.dba || client.clientName,
              assignedBy: {
                _id: me._id,
                name: me.name,
              },
              assignedAt: new Date().toISOString(),
            },
          );
        }
      }
    } catch (socketError) {
      console.error("❌ Error emitting assignment notifications:", socketError);
    }

    res.json({
      client,
      message,
      historicalMessagesShared: validEmployeeIds.length > 0,
    });
  } catch (err) {
    console.error("assignClient error:", err);
    res.status(500).json({ error: "Assignment failed" });
  }
};
