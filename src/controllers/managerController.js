const path = require("path");
const mongoose = require("mongoose");
const Employee = require("../models/Employees");
const ClientInfo = require("../models/ClientInfo");
const AssignmentMessage = require("../models/AssignmentMessage");
const EmployeeHierarchy = require("../models/EmployeeHierarchy");

const isManagerLike = (role) => {
  const r = String(role || "").toLowerCase();
  return /\bmanager\b/.test(r) || /team\s*lead/.test(r);
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
    const isTeamLead = role === "team lead" || role === "team_lead";
    const isManager = role === "manager";

    // Find ALL descendants in the hierarchy tree (any depth) using the path field.
    // path stores the full ancestry chain as "id1.id2.id3", so matching on me._id
    // anywhere in the path returns every junior at every level below me.
    const pathRegex = new RegExp(`(^|\\.)${String(me._id)}(\\.|$)`);
    const allDescendantLinks = await EmployeeHierarchy.find({
      owner: me.owner,
      path: pathRegex,
    }).select("junior").lean();
    const allDescendantIds = allDescendantLinks.map(l => String(l.junior));

    // Also capture direct juniors via the legacy senior: me._id index (fast lookup)
    const directJuniorLinks = await EmployeeHierarchy.find({
      owner: me.owner,
      senior: me._id,
    }).select("junior").lean();
    const directJuniorIds = directJuniorLinks.map(l => String(l.junior));

    // Also include employees whose supervisor field points to me
    const supervisorFieldJuniors = await Employee.find({
      owner: me.owner,
      supervisor: me._id,
    }).select("_id").lean();
    const supervisorFieldIds = supervisorFieldJuniors.map(e => String(e._id));

    // Combine: full descendant tree + direct juniors + supervisor-field reports
    const juniorIds = [...new Set([...allDescendantIds, ...directJuniorIds, ...supervisorFieldIds])];
    const isSenior = juniorIds.length > 0;

    // Build juniorMap: tracks which juniors have supervision enabled on their clients
    const supervisedClients = await ClientInfo.find({
      owner: me.owner,
      assignedTo: { $in: juniorIds.map(id => new mongoose.Types.ObjectId(id)) },
      supervisedBy: me._id,
    }).select("assignedTo").lean();

    const supervisedJuniorIds = new Set();
    supervisedClients.forEach(c => {
      (c.assignedTo || []).forEach(aId => {
        const idStr = String(aId);
        if (juniorIds.includes(idStr)) supervisedJuniorIds.add(idStr);
      });
    });

    const juniorMap = new Map();
    juniorIds.forEach(jid => {
      juniorMap.set(jid, supervisedJuniorIds.has(jid));
    });

    const canSeeManagementTabs = isManager || isTeamLead || isSenior;
    const isEmployee = !isManager && !isTeamLead; // but could be a senior staff

    /* ------------------ EMPLOYEES (VISIBLE TO ALL) ------------------ */
    let employeeQuery = {
      owner: me.owner,
      status: "active",
      _id: { $ne: me._id } // Exclude self from contact list
    };

    // Regular employees can now see all active employees in their organization to facilitate communication
    // (Previously restricted to supervisor, managers, and team leads)

    // Default visibility for all: see everyone in Operations or with specific roles
    employeeQuery.$or = [
      { department: "Operations" },
      { role: { $in: ["Employee", "Manager", "Team Lead"] } },
    ];

    const employees = await Employee.find(employeeQuery)
      .select(
        "_id name email companyEmail role department designation supervisionMode supervisor supervisorMode photographUrl"
      )
      .populate("supervisor", "_id name companyEmail")
      .sort({ name: 1 });

    /* ------------------ CLIENT FILTER ------------------ */
    let clientQuery = { owner: me.owner };

    // If it's NOT a manager or team lead, only show clients they're directly assigned to (or their juniors)
    if (!isManager && !isTeamLead) {
      const myId = new mongoose.Types.ObjectId(me._id);
      const targetIds = [myId, ...juniorIds.map(id => new mongoose.Types.ObjectId(id))];

      clientQuery = {
        ...clientQuery,
        assignedTo: { $in: targetIds },
      };
    }

    const clients = await ClientInfo.find(clientQuery)
      .select(
        "_id clientName bookkeepingSoftware legalBusinessName dba industry taxStatus companyLocation isActive phone email assignedTo supervision supervisedBy owner readBy companyEmployees clientEmail createdAt updatedAt"
      )
      .populate("assignedTo", "_id name companyEmail role")
      .populate("owner", "_id name companyEmail")
      .sort({ isActive: -1, createdAt: -1 });

    // **auto-apply supervision marks based on hierarchy and self-assignments**
    // Add the current user for clients they should supervise even if the DB
    // hasn't been updated yet.  The two triggers are:
    // 1. assigned to one of our juniors with an active supervision flag (from
    //    juniorMap)
    // 2. assigned to ourselves (self-supervision)
    clients.forEach(client => {
      if (!client.supervisedBy) client.supervisedBy = [];
      const assignedIds = (client.assignedTo || []).map(a => String(a._id));
      const meIdStr = String(me._id);

      // managers/team leads automatically supervise everything returned
      const auto = isManager || isTeamLead;
      const superviseJunior = assignedIds.some(id => juniorIds.includes(id));
      const superviseSelf = assignedIds.includes(meIdStr);
      if (auto || superviseJunior || superviseSelf) {
        if (!client.supervisedBy.some(sid => String(sid._id || sid) === meIdStr)) {
          client.supervisedBy.push(me._id);
          client.supervision = "needs_approval";
        }
      }
    });

    // persist any added supervision back to the database so that subsequent
    // requests (or other services) see the updated state without relying on
    // the login sync job.
    try {
      const meObjId = new mongoose.Types.ObjectId(me._id);
      const juniorObjIds = juniorIds.map(id => new mongoose.Types.ObjectId(id));
      await ClientInfo.updateMany(
        {
          owner: me.owner,
          assignedTo: { $in: [...juniorObjIds, meObjId] }
        },
        {
          $addToSet: { supervisedBy: meObjId },
          $set: { supervision: "needs_approval" }
        }
      );
    } catch (dbErr) {
      console.error("getRoster supervision persistence error:", dbErr);
    }

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

    /* ------------------ DIRECT JUNIOR MAP (for ContactsPanel supervised count) ----------- */
    // Fetch all hierarchy links where any of our juniors is a senior themselves.
    // This gives us the direct-junior relationships for the full descendant tree
    // so the frontend can BFS without relying on the Employee.supervisor field
    // (which may be out of sync with EmployeeHierarchy).
    const seniorToDirectJuniors = {};
    if (juniorIds.length > 0) {
      const juniorAsseniorLinks = await EmployeeHierarchy.find({
        owner: me.owner,
        senior: { $in: juniorIds.map(id => new mongoose.Types.ObjectId(id)) },
        junior: { $in: juniorIds.map(id => new mongoose.Types.ObjectId(id)) },
      }).select("senior junior").lean();

      for (const link of juniorAsseniorLinks) {
        const sid = String(link.senior);
        if (!seniorToDirectJuniors[sid]) seniorToDirectJuniors[sid] = [];
        const jid = String(link.junior);
        if (!seniorToDirectJuniors[sid].includes(jid)) {
          seniorToDirectJuniors[sid].push(jid);
        }
      }
    }

    /* ------------------ RESPONSE ------------------ */
    const employeesWithHierarchyStatus = employees.map(emp => {
      const empObj = emp.toObject();
      if (juniorMap.has(String(emp._id))) {
        empObj.supervisionEnabled = juniorMap.get(String(emp._id));
      }
      // Attach direct junior IDs from EmployeeHierarchy (authoritative source)
      empObj.directJuniorIds = seniorToDirectJuniors[String(emp._id)] || [];
      return empObj;
    });

    res.json({
      employees: employeesWithHierarchyStatus,
      teamMembers: employeesWithHierarchyStatus.filter(emp =>
        isManager || isTeamLead ? String(emp._id) !== String(me._id) : juniorIds.includes(String(emp._id))
      ),
      clients: clientsWithReadStatus,
      clientEmployees,
      isSenior,
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

    const isManagerRole =
      me.role?.toLowerCase() === "manager" ||
      me.role?.toLowerCase() === "team lead" ||
      me.role?.toLowerCase() === "team_lead" ||
      me.role?.toLowerCase() === "teamlead";

    // Get direct juniors from hierarchy
    let juniorIds = [];
    if (!isManagerRole) {
      const juniorLinks = await EmployeeHierarchy.find({
        owner: me.owner,
        senior: me._id,
      }).select("junior");
      juniorIds = juniorLinks.map((l) => l.junior);
    }

    const isHierarchySenior = juniorIds.length > 0;

    // --- Employees Query ---
    const employees = await Employee.find({
      owner: me.owner,
      status: "active",
      _id: { $ne: me._id },
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

    if (isManagerRole) {
      // Managers/Team Leads see all owner clients
    } else if (isHierarchySenior) {
      // Seniors see only clients where their juniors are assigned
      clientQuery.assignedTo = { $in: juniorIds };
    } else {
      // Regular employees see only their own assigned clients
      clientQuery.assignedTo = { $in: [me._id] };
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
    const me = await Employee.findById(req.employee._id).select("_id owner role");
    if (!me) return res.status(404).json({ error: "Employee not found" });

    const { id } = req.params; // junior id
    const { supervisionMode } = req.body;

    if (!me.owner)
      return res.status(400).json({ error: "Your profile is missing owner id" });

    const isApproval = supervisionMode === "needs_approval";

    // Supervision is tracked only on ClientInfo. Update all clients assigned
    // to this junior so they reflect the new supervision state.
    const juniorClients = await ClientInfo.find({
      owner: me.owner,
      assignedTo: id
    });

    const myIdStr = String(me._id);
    for (const client of juniorClients) {
      if (!client.supervisedBy) client.supervisedBy = [];
      const currentlySupervising = client.supervisedBy.some(sid => String(sid._id || sid) === myIdStr);

      if (isApproval && !currentlySupervising) {
        client.supervisedBy.push(me._id);
      } else if (!isApproval && currentlySupervising) {
        client.supervisedBy = client.supervisedBy.filter(sid => String(sid._id || sid) !== myIdStr);
      }

      // Update legacy field
      client.supervision = client.supervisedBy.length > 0 ? "needs_approval" : "direct";
      client.markModified("supervisedBy");
      await client.save();
    }

    // 3. Update legacy Employee field for compatibility
    const updated = await Employee.findOneAndUpdate(
      { _id: id, owner: me.owner },
      { $set: { supervisionMode } },
      { new: true }
    ).select("_id name supervisionMode supervisor");

    res.json({
      status: "success",
      employee: updated,
      hierarchyEnabled: isApproval
    });
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

    // Allow if: Manager/Team Lead role OR is a senior in EmployeeHierarchy for any of the target employees
    const isManagerRole = isManagerLike(me.role);
    let isHierarchySenior = false;
    if (!isManagerRole && Array.isArray(employeeIds) && employeeIds.length > 0) {
      const seniorLink = await EmployeeHierarchy.exists({
        owner: me.owner,
        senior: me._id,
        junior: { $in: employeeIds },
      });
      isHierarchySenior = !!seniorLink;
    }

    if (!isManagerRole && !isHierarchySenior) {
      return res.status(403).json({ error: "Unauthorized: you are not a manager/team lead and do not supervise any of the target employees" });
    }

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
