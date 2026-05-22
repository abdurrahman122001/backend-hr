const mongoose = require("mongoose");
const ClientInfo = require("../models/ClientInfo");
const Employee = require("../models/Employees");
const EmployeeHierarchy = require("../models/EmployeeHierarchy");

const isManagerLike = (role) => {
  const r = String(role || "").toLowerCase();
  // treat any role string containing manager or team lead as managerial
  return /\bmanager\b/.test(r) || /team\s*lead/.test(r);
};

exports.createClientInfo = async (req, res) => {
  try {
    const emp = await Employee.findById(req.employee._id);
    if (!emp) return res.status(404).json({ error: "Employee not found" });

    if (!isManagerLike(emp.role)) {
      return res.status(403).json({ error: "Only Managers/Team Leads can create client info" });
    }

    const { ownerId, companyEmployees = [], ...rest } = req.body;

    if (!ownerId) return res.status(400).json({ error: "ownerId is required" });

    // Validate companyEmployees if provided during creation
    const validatedEmployees = [];
    if (Array.isArray(companyEmployees) && companyEmployees.length > 0) {
      for (const empData of companyEmployees) {
        if (!empData.name || !empData.designation) {
          return res.status(400).json({
            error: "Each company employee must have name and designation"
          });
        }

        validatedEmployees.push({
          name: empData.name.trim(),
          designation: empData.designation.trim(),
          email: empData.email ? empData.email.trim().toLowerCase() : undefined,
          phone: empData.phone ? empData.phone.trim() : undefined,
          department: empData.department ? empData.department.trim() : undefined,
          isPrimaryContact: empData.isPrimaryContact || false,
          notes: empData.notes ? empData.notes.trim() : undefined,
          addedAt: new Date()
        });
      }
    }

    const doc = await ClientInfo.create({
      ...rest,
      owner: ownerId,
      createdBy: emp._id,
      companyEmployees: validatedEmployees,
    });


    res.status(201).json(doc);
  } catch (err) {
    console.error("createClientInfo error:", err);
    res.status(500).json({ error: "Failed to create client info" });
  }
};

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
      .populate("assignedTo", "_id name companyEmail role")
      .populate("supervisedBy", "_id name companyEmail role");


    res.json(clients);
  } catch (err) {
    console.error("getClientInfo error:", err);
    res.status(500).json({ error: "Failed to fetch client info" });
  }
};

exports.getMyClients = async (req, res) => {
  try {
    const employeeId = req.employee._id;
    const asObjectId = new mongoose.Types.ObjectId(employeeId);

    const clients = await ClientInfo.find({ assignedTo: asObjectId })
      .sort({ createdAt: -1 })
      .populate("assignedTo", "_id name companyEmail role")
      .populate("supervisedBy", "_id name companyEmail role");

    res.json(clients);
  } catch (err) {
    console.error("getMyClients error:", err);
    res.status(500).json({ error: "Server error" });
  }
};

exports.updateClientInfo = async (req, res) => {
  try {
    const emp = await Employee.findById(req.employee._id);
    if (!emp) return res.status(404).json({ error: "Employee not found" });

    const { id } = req.params;
    const { companyEmployees, ...updates } = req.body;

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

    // If companyEmployees is provided in update, replace the entire array
    if (companyEmployees !== undefined) {
      if (!Array.isArray(companyEmployees)) {
        return res.status(400).json({ error: "companyEmployees must be an array" });
      }

      const validatedEmployees = [];
      for (const empData of companyEmployees) {
        if (!empData.name || !empData.designation) {
          return res.status(400).json({
            error: "Each company employee must have name and designation"
          });
        }

        validatedEmployees.push({
          name: empData.name.trim(),
          designation: empData.designation.trim(),
          email: empData.email ? empData.email.trim().toLowerCase() : undefined,
          phone: empData.phone ? empData.phone.trim() : undefined,
          department: empData.department ? empData.department.trim() : undefined,
          isPrimaryContact: empData.isPrimaryContact || false,
          notes: empData.notes ? empData.notes.trim() : undefined,
          addedAt: empData.addedAt || new Date()
        });
      }

      updates.companyEmployees = validatedEmployees;
    }

    const updated = await ClientInfo.findByIdAndUpdate(
      id,
      updates,
      { new: true }
    ).populate("assignedTo", "_id name companyEmail role")
      .populate("supervisedBy", "_id name companyEmail role");

    res.json(updated);
  } catch (err) {
    console.error("updateClientInfo error:", err);
    res.status(500).json({ error: "Failed to update client info" });
  }
};

// Add a single company employee to client
exports.addCompanyEmployee = async (req, res) => {
  try {
    const emp = await Employee.findById(req.employee._id);
    if (!emp) return res.status(404).json({ error: "Employee not found" });

    const { id } = req.params;
    const { name, designation, email, phone, department, isPrimaryContact, notes } = req.body;

    if (!name || !designation) {
      return res.status(400).json({ error: "Name and designation are required" });
    }

    const client = await ClientInfo.findById(id);
    if (!client) return res.status(404).json({ error: "Client not found" });

    // Check authorization
    const role = String(emp.role || "").trim().toLowerCase();
    if (
      role !== "owner" &&
      !isManagerLike(emp.role) &&
      String(client.assignedTo) !== String(emp._id)
    ) {
      return res.status(403).json({ error: "Not authorized to add employees to this client" });
    }

    const newEmployee = {
      name: name.trim(),
      designation: designation.trim(),
      email: email ? email.trim().toLowerCase() : undefined,
      phone: phone ? phone.trim() : undefined,
      department: department ? department.trim() : undefined,
      isPrimaryContact: isPrimaryContact || false,
      notes: notes ? notes.trim() : undefined,
      addedAt: new Date()
    };

    client.companyEmployees.push(newEmployee);
    await client.save();

    const updatedClient = await ClientInfo.findById(id)
      .populate("assignedTo", "_id name companyEmail role")
      .populate("supervisedBy", "_id name companyEmail role");

    res.json(updatedClient);
  } catch (err) {
    console.error("addCompanyEmployee error:", err);
    res.status(500).json({ error: "Failed to add company employee" });
  }
};

// Remove a company employee from client
exports.removeCompanyEmployee = async (req, res) => {
  try {
    const emp = await Employee.findById(req.employee._id);
    if (!emp) return res.status(404).json({ error: "Employee not found" });

    const { id, employeeIndex } = req.params;

    const client = await ClientInfo.findById(id);
    if (!client) return res.status(404).json({ error: "Client not found" });

    // Check authorization
    const role = String(emp.role || "").trim().toLowerCase();
    if (
      role !== "owner" &&
      !isManagerLike(emp.role) &&
      String(client.assignedTo) !== String(emp._id)
    ) {
      return res.status(403).json({ error: "Not authorized to remove employees from this client" });
    }

    const index = parseInt(employeeIndex);
    if (isNaN(index) || index < 0 || index >= client.companyEmployees.length) {
      return res.status(400).json({ error: "Invalid employee index" });
    }

    // Remove the employee at specified index
    client.companyEmployees.splice(index, 1);
    await client.save();

    const updatedClient = await ClientInfo.findById(id)
      .populate("assignedTo", "_id name companyEmail role")
      .populate("supervisedBy", "_id name companyEmail role");

    res.json(updatedClient);
  } catch (err) {
    console.error("removeCompanyEmployee error:", err);
    res.status(500).json({ error: "Failed to remove company employee" });
  }
};

// Update a specific company employee
exports.updateCompanyEmployee = async (req, res) => {
  try {
    const emp = await Employee.findById(req.employee._id);
    if (!emp) return res.status(404).json({ error: "Employee not found" });

    const { id, employeeIndex } = req.params;
    const { name, designation, email, phone, department, isPrimaryContact, notes } = req.body;

    const client = await ClientInfo.findById(id);
    if (!client) return res.status(404).json({ error: "Client not found" });

    // Check authorization
    const role = String(emp.role || "").trim().toLowerCase();
    if (
      role !== "owner" &&
      !isManagerLike(emp.role) &&
      String(client.assignedTo) !== String(emp._id)
    ) {
      return res.status(403).json({ error: "Not authorized to update employees of this client" });
    }

    const index = parseInt(employeeIndex);
    if (isNaN(index) || index < 0 || index >= client.companyEmployees.length) {
      return res.status(400).json({ error: "Invalid employee index" });
    }

    // Update the employee
    if (name) client.companyEmployees[index].name = name.trim();
    if (designation) client.companyEmployees[index].designation = designation.trim();
    if (email !== undefined) client.companyEmployees[index].email = email ? email.trim().toLowerCase() : undefined;
    if (phone !== undefined) client.companyEmployees[index].phone = phone ? phone.trim() : undefined;
    if (department !== undefined) client.companyEmployees[index].department = department ? department.trim() : undefined;
    if (isPrimaryContact !== undefined) client.companyEmployees[index].isPrimaryContact = isPrimaryContact;
    if (notes !== undefined) client.companyEmployees[index].notes = notes ? notes.trim() : undefined;

    await client.save();

    const updatedClient = await ClientInfo.findById(id)
      .populate("assignedTo", "_id name companyEmail role")
      .populate("supervisedBy", "_id name companyEmail role");

    res.json(updatedClient);
  } catch (err) {
    console.error("updateCompanyEmployee error:", err);
    res.status(500).json({ error: "Failed to update company employee" });
  }
};

exports.getClientById = async (req, res) => {
  try {
    const emp = await Employee.findById(req.employee._id).select("role");
    if (!emp) return res.status(404).json({ error: "Employee not found" });

    const { id } = req.params;

    // 🔥 HANDLE GROUP IDs: If it starts with group_, it's not a client
    if (id.startsWith("group_")) {
      const gId = id.replace("group_", "");
      const WhatsAppGroup = require("../models/WhatsAppGroup");
      const group = await WhatsAppGroup.findById(gId);
      if (!group) return res.status(404).json({ error: "Group not found" });
      
      return res.json({
        _id: id,
        clientName: group.name,
        type: "group",
        isGroup: true,
        groupData: group
      });
    }

    const client = await ClientInfo.findById(id)
      .populate("assignedTo", "_id name companyEmail role")
      .populate("supervisedBy", "_id name companyEmail role");

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

// Keep your existing toggleWhatsAppFlag and getWhatsAppFlags functions
exports.toggleWhatsAppFlag = async (req, res) => {
  try {
    const emp = await Employee.findById(req.employee._id);
    if (!emp) return res.status(404).json({ error: "Employee not found" });

    const { id, flag } = req.params;
    const validFlags = [
      "whatsappMuted",
      "whatsappFavourite",
      "whatsappPinned",
      "whatsappArchived",
    ];

    if (!validFlags.includes(flag)) {
      return res.status(400).json({ error: "Invalid flag type" });
    }

    // 🔥 HANDLE GROUP IDs
    if (id.startsWith("group_")) {
       return res.json({
         success: true,
         message: `${flag} toggled locally (groups not supported yet)`,
         flag,
         newValue: false,
       });
    }

    const client = await ClientInfo.findById(id);
    if (!client) return res.status(404).json({ error: "Client not found" });

    // Authorization: same rules as view/update
    const role = String(emp.role || "").trim().toLowerCase();
    const authorized =
      role === "owner" ||
      ["manager", "team lead", "team_lead", "teamlead"].includes(role) ||
      String(client.assignedTo) === String(emp._id);

    if (!authorized) {
      return res.status(403).json({ error: "Not authorized to toggle this flag" });
    }

    // Toggle logic
    client[flag] = !client[flag];
    await client.save();

    res.json({
      success: true,
      message: `${flag} toggled successfully`,
      flag,
      newValue: client[flag],
    });
  } catch (err) {
    console.error("toggleWhatsAppFlag error:", err);
    res.status(500).json({ error: "Failed to toggle WhatsApp flag" });
  }
};
// Search clients by NAME (Team Lead & Team Member primarily)
exports.searchClientByName = async (req, res) => {
  try {
    const emp = await Employee.findById(req.employee._id).select("_id role owner");
    if (!emp) return res.status(404).json({ error: "Employee not found" });

    const { search } = req.query;
    if (!search) {
      return res.status(400).json({ error: "Search query parameter is required" });
    }

    const role = String(emp.role || "").trim().toLowerCase();

    // Base query: always scope by owner
    let query = {
      owner: emp.owner,
      $or: [
        { clientName: { $regex: search, $options: "i" } },
        { dba: { $regex: search, $options: "i" } },
        { company: { $regex: search, $options: "i" } },
      ],
    };

    // 🔒 Non-managers can ONLY search their assigned clients
    if (role !== "manager") {
      query.assignedTo = emp._id;
    }

    const clients = await ClientInfo.find(query)
      .populate("assignedTo", "_id name companyEmail role")
      .populate("supervisedBy", "_id name companyEmail role")
      .limit(10)
      .sort({ clientName: 1 });

    res.json(clients);
  } catch (err) {
    console.error("searchClientByName error:", err);
    res.status(500).json({ error: "Failed to search clients by name" });
  }
};


exports.getWhatsAppFlags = async (req, res) => {
  try {
    const emp = await Employee.findById(req.employee._id);
    if (!emp) return res.status(404).json({ error: "Employee not found" });

    const { id } = req.params;

    // 🔥 HANDLE GROUP IDs
    if (id.startsWith("group_")) {
      return res.json({
        isPinned: false,
        isRead: true,
        isFavourite: false,
        isMuted: false,
        isArchived: false,
      });
    }

    const client = await ClientInfo.findById(id);
    if (!client) return res.status(404).json({ error: "Client not found" });

    // Authorization: same rules as view/update
    const role = String(emp.role || "").trim().toLowerCase();
    const authorized =
      role === "owner" ||
      ["manager", "team lead", "team_lead", "teamlead"].includes(role) ||
      String(client.assignedTo) === String(emp._id);

    if (!authorized) {
      return res.status(403).json({ error: "Not authorized to view this client" });
    }

    // Return all WhatsApp flags
    res.json({
      isPinned: client.whatsappPinned || false,
      isRead: client.whatsappRead || false,
      isFavourite: client.whatsappFavourite || false,
      isMuted: client.whatsappMuted || false,
      isArchived: client.whatsappArchived || false,
    });
  } catch (err) {
    console.error("getWhatsAppFlags error:", err);
    res.status(500).json({ error: "Failed to fetch WhatsApp flags" });
  }
};

exports.markClientRead = async (req, res) => {
  try {
    const employeeId = req.employee._id;
    const { id } = req.params; // clientId

    if (id.startsWith("group_")) {
       return res.json({ success: true, message: "Group read status not tracked here" });
    }

    const client = await ClientInfo.findById(id);
    if (!client) return res.status(404).json({ error: "Client not found" });

    // If already read by this employee → do nothing
    const alreadyRead = client.readBy.some(
      r => String(r.employee) === String(employeeId)
    );
    if (!alreadyRead) {
      client.readBy.push({ employee: employeeId, readAt: new Date() });
      await client.save();
    }

    res.json({ success: true, readBy: client.readBy });
  } catch (err) {
    console.error("markClientRead error:", err);
    res.status(500).json({ error: "Server error" });
  }
};

// Check if user has any new/unread clients
exports.hasNewClients = async (req, res) => {
  try {
    const emp = await Employee.findById(req.employee._id).select("_id role owner");
    if (!emp) return res.status(404).json({ error: "Employee not found" });

    const role = String(emp.role || "").trim().toLowerCase();

    // 🚫 Managers never see new clients indicator
    if (role === "manager") {
      return res.json({ hasNewClients: false, unreadCount: 0 });
    }

    let query = {};

    // Team Lead: All clients under their owner
    if (role.includes("team lead") || role === "owner") {
      if (!emp.owner) {
        return res.status(400).json({ error: "Owner ID missing in profile" });
      }
      query = { owner: emp.owner };
    }
    // Employee: Only their assigned clients
    else {
      query = { assignedTo: emp._id };
    }

    // Find clients that match the query
    const clients = await ClientInfo.find(query).select("_id readBy");

    // Check if any client is unread (not in readBy array)
    const hasUnread = clients.some(client => {
      return !client.readBy?.some(read =>
        String(read.employee) === String(emp._id)
      );
    });

    const unreadCount = clients.filter(client => {
      return !client.readBy?.some(read =>
        String(read.employee) === String(emp._id)
      );
    }).length;

    res.json({
      hasNewClients: hasUnread,
      unreadCount,
      role: emp.role
    });
  } catch (err) {
    console.error("hasNewClients error:", err);
    res.status(500).json({ error: "Failed to check new clients" });
  }
};
// client-info.controller.js

// Search clients by email (for managers, team leads, and team members - only assigned clients)
exports.searchClientByEmail = async (req, res) => {
  try {
    const emp = await Employee.findById(req.employee._id);
    if (!emp) return res.status(404).json({ error: "Employee not found" });

    const { email } = req.query;
    if (!email) {
      return res.status(400).json({ error: "Email query parameter is required" });
    }

    // Build query based on role
    let query = { owner: emp.owner };

    // For non-managers, only search assigned clients
    if (emp.role?.toLowerCase() !== "manager") {
      query.assignedTo = emp._id;
    }

    // Add email search
    query.clientEmail = { $regex: email, $options: "i" };

    const clients = await ClientInfo.find(query)
      .populate("assignedTo", "_id name companyEmail role")
      .populate("supervisedBy", "_id name companyEmail role")
      .limit(10);

    res.json(clients);
  } catch (err) {
    console.error("searchClientByEmail error:", err);
    res.status(500).json({ error: "Failed to search clients by email" });
  }
};

// Search company employees by email (for all roles - only within assigned clients)
exports.searchCompanyEmployeeByEmail = async (req, res) => {
  try {
    const emp = await Employee.findById(req.employee._id);
    if (!emp) return res.status(404).json({ error: "Employee not found" });

    const { email } = req.query;
    if (!email) {
      return res.status(400).json({ error: "Email query parameter is required" });
    }

    // Build query based on role
    let query = { owner: emp.owner };

    // For non-managers, only search within assigned clients
    if (emp.role?.toLowerCase() !== "manager") {
      query.assignedTo = emp._id;
    }

    // Add email search for company employees
    query["companyEmployees.email"] = { $regex: email, $options: "i" };

    const clients = await ClientInfo.find(query)
      .populate("assignedTo", "_id name companyEmail role")
      .populate("supervisedBy", "_id name companyEmail role")
      .limit(10);

    const results = [];
    clients.forEach(client => {
      client.companyEmployees.forEach(employee => {
        if (employee.email && employee.email.toLowerCase().includes(email.toLowerCase())) {
          results.push({
            client: {
              _id: client._id,
              clientName: client.clientName,
              dba: client.dba,
              assignedTo: client.assignedTo
            },
            employee: employee
          });
        }
      });
    });

    res.json(results);
  } catch (err) {
    console.error("searchCompanyEmployeeByEmail error:", err);
    res.status(500).json({ error: "Failed to search company employees by email" });
  }
};

// Search team members (role-aware)
exports.searchTeamMembers = async (req, res) => {
  try {
    const emp = await Employee.findById(req.employee._id).select(
      "_id role owner teamLead"
    );
    if (!emp) {
      return res.status(404).json({ error: "Employee not found" });
    }

    const { search } = req.query;
    if (!search) {
      return res.status(400).json({ error: "Search query parameter is required" });
    }

    const role = String(emp.role || "").toLowerCase().trim();
    const searchRegex = new RegExp(search, "i");

    // Base query: same owner, exclude self
    let employeesQuery = {
      owner: emp.owner,
      _id: { $ne: emp._id },
      $or: [
        { name: searchRegex },
        { email: searchRegex },
        { companyEmail: searchRegex }
      ]
    };

    const isSenior = await EmployeeHierarchy.exists({ owner: emp.owner, senior: emp._id });

    /* ---------------- ROLE RULES ---------------- */

    // ✅ Anyone can search all employees in their organization (Active only)
    employeesQuery.status = "active";
    // no extra restriction based on role here to allow messaging colleagues

    const employees = await Employee.find(employeesQuery)
      .select("_id name email companyEmail role designation")
      .limit(10);

    res.json(employees);
  } catch (err) {
    console.error("searchTeamMembers error:", err);
    res.status(500).json({ error: "Failed to search team members" });
  }
};


exports.updateClientSupervision = async (req, res) => {
  try {
    const me = await Employee.findById(req.employee._id).select("_id owner role");
    if (!me) return res.status(404).json({ error: "Employee not found" });

    const { id } = req.params; // client id
    const { supervision } = req.body;

    if (!["direct", "needs_approval"].includes(supervision)) {
      return res.status(400).json({ error: "Invalid supervision value" });
    }

    // 🔥 HIERARCHY-BASED: Check if current user is senior to ANYONE assigned to this client
    const client = await ClientInfo.findOne({ _id: id, owner: me.owner }).populate("assignedTo");
    if (!client) return res.status(404).json({ error: "Client not found" });

    const assignedIds = client.assignedTo?.map(emp => emp._id) || [];

    // determine if user is authorized to change supervision on this client
    let authorized = false;

    // managers and team leads always have permission
    if (isManagerLike(me.role)) {
      authorized = true;
    }

    // if they are already supervising the client (self or via prior toggle)
    const meIdStr = String(me._id);
    if (!authorized && client.supervisedBy?.some(id => String(id._id || id) === meIdStr)) {
      authorized = true;
    }

    // check hierarchical relationship (any descendant)
    if (!authorized && assignedIds.length) {
      const pathRegex = new RegExp(`(^|\\.)${me._id}(\\.|$)`);
      const hasRelation = await EmployeeHierarchy.exists({
        owner: me.owner,
        path: pathRegex,
        junior: { $in: assignedIds }
      });
      if (hasRelation) authorized = true;
    }

    if (!authorized) {
      return res.status(403).json({ error: "Unauthorized: You don't supervise anyone assigned to this client" });
    }

    // Initialize supervisedBy if missing
    if (!client.supervisedBy) client.supervisedBy = [];

    const myIdStr = String(me._id);
    const currentlySupervising = client.supervisedBy.some(id => String(id._id || id) === myIdStr);

    if (supervision === "needs_approval") {
      if (!currentlySupervising) {
        client.supervisedBy.push(me._id);
      }
    } else if (supervision === "direct") {
      client.supervisedBy = client.supervisedBy.filter(id => String(id._id || id) !== myIdStr);
    }

    // Ensure Mongoose tracks the array change
    client.markModified("supervisedBy");

    // Keep legacy supervision field in sync (needs_approval if ANYONE supervises)
    client.supervision = client.supervisedBy.length > 0 ? "needs_approval" : "direct";

    await client.save();

    const updatedClient = await ClientInfo.findById(id)
      .select("_id clientName supervision supervisedBy assignedTo")
      .populate("supervisedBy", "_id name companyEmail")
      .populate("assignedTo", "_id name companyEmail role");


    return res.json({
      status: "success",
      message: "Supervision updated",
      client: updatedClient
    });
  } catch (err) {
    console.error("updateClientSupervision error:", err);
    res.status(500).json({ error: "Failed to update supervision" });
  }
};

exports.updateAllClientSupervisionForEmployee = async (req, res) => {
  try {
    const me = await Employee.findById(req.employee._id).select("_id owner role");
    if (!me || !me.owner) {
      return res.status(403).json({ error: "Access denied" });
    }

    const { employeeId } = req.params;
    const { supervision } = req.body;

    if (!["direct", "needs_approval"].includes(supervision)) {
      return res.status(400).json({ error: "Invalid supervision value" });
    }

    // 🔥 HIERARCHY-BASED: Check if current user is senior to this employee
    const isSenior = await EmployeeHierarchy.exists({
      owner: me.owner,
      senior: me._id,
      junior: employeeId
    });

    if (!isManagerLike(me.role) && !isSenior) {
      return res.status(403).json({ error: "Unauthorized: You don't supervise this employee" });
    }

    // Get all clients assigned to this employee
    const clients = await ClientInfo.find({
      assignedTo: employeeId,
      owner: me.owner
    });

    const myIdStr = String(me._id);
    const updatedIds = [];

    // Supervision is now tracked solely on ClientInfo (supervisedBy / supervision).
    // No per-link flag on EmployeeHierarchy is updated anymore.

    for (const client of clients) {
      if (!client.supervisedBy) client.supervisedBy = [];
      const currentlySupervising = client.supervisedBy.some(id => String(id._id || id) === myIdStr);

      if (supervision === "needs_approval" && !currentlySupervising) {
        client.supervisedBy.push(me._id);
        client.supervision = "needs_approval";
        client.markModified("supervisedBy");
        await client.save();
        updatedIds.push(client._id);
      } else if (supervision === "direct" && currentlySupervising) {
        client.supervisedBy = client.supervisedBy.filter(id => String(id._id || id) !== myIdStr);
        client.supervision = client.supervisedBy.length > 0 ? "needs_approval" : "direct";
        client.markModified("supervisedBy");
        await client.save();
        updatedIds.push(client._id);
      }
    }

    res.json({
      updated: updatedIds,
      supervision
    });
  } catch (err) {
    console.error("updateAllClientSupervision error:", err);
    res.status(500).json({ error: "Failed to update supervision" });
  }
};

