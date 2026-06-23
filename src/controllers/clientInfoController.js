const mongoose = require("mongoose");
const ClientInfo = require("../models/ClientInfo");
const Employee = require("../models/Employees");
const EmployeeHierarchy = require("../models/EmployeeHierarchy");
const { hasCrmAccess, getCrmUserIds } = require("../utils/crmAccess");

// ⚠️ DEPRECATED role check — kept only for reference. CRM/manager powers are now
// access-based: use `await hasCrmAccess(req.employee)` instead of isManagerLike.
const isManagerLike = (role) => {
  const r = String(role || "").toLowerCase();
  return /\bmanager\b/.test(r) || /team\s*lead/.test(r) || /\bcrm\b/.test(r);
};

exports.createClientInfo = async (req, res) => {
  try {
    const emp = await Employee.findById(req.employee._id);
    if (!emp) return res.status(404).json({ error: "Employee not found" });

    let authorized = await hasCrmAccess(req.employee);
    if (!authorized) {
      // Only the top-level senior (has juniors but is not a junior to anyone else) can create clients
      const isSenior = await EmployeeHierarchy.exists({ owner: emp.owner, senior: emp._id });
      const isJunior = isSenior
        ? await EmployeeHierarchy.exists({ owner: emp.owner, junior: emp._id })
        : true;
      authorized = !!isSenior && !isJunior;
    }
    if (!authorized) {
      return res.status(403).json({ error: "Only Managers/Team Leads or the top-level senior can create client info" });
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
    } else if (await hasCrmAccess(req.employee)) {
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

// Walk the EmployeeHierarchy senior→junior edges breadth-first to collect every
// descendant (junior, sub-junior, …) of an employee. Edges are stored one per
// direct relationship, so the subtree must be traversed level by level rather
// than read from a single field. Employee.supervisor is consulted too, in case
// a link was never mirrored into EmployeeHierarchy. A visited set prevents loops.
async function getDescendantEmployeeIds(ownerId, rootId) {
  const descendants = new Set();
  const visited = new Set([String(rootId)]);
  let frontier = [String(rootId)];

  for (let depth = 0; depth < 25 && frontier.length > 0; depth++) {
    const frontierObjIds = frontier
      .filter((id) => mongoose.isValidObjectId(id))
      .map((id) => new mongoose.Types.ObjectId(id));

    const hierFilter = { senior: { $in: frontierObjIds } };
    const repFilter = { supervisor: { $in: frontierObjIds } };
    if (ownerId) {
      hierFilter.owner = ownerId;
      repFilter.owner = ownerId;
    }

    const [links, reports] = await Promise.all([
      EmployeeHierarchy.find(hierFilter).select("junior").lean(),
      Employee.find(repFilter).select("_id").lean(),
    ]);

    const next = [];
    const consider = (id) => {
      const s = String(id || "");
      if (s && !visited.has(s)) {
        visited.add(s);
        descendants.add(s);
        next.push(s);
      }
    };
    links.forEach((l) => consider(l.junior));
    reports.forEach((r) => consider(r._id));
    frontier = next;
  }

  return [...descendants];
}

// The set of employee IDs whose assigned clients a given employee may act on:
// themselves PLUS their entire downline (juniors, sub-juniors, …). Returns
// ObjectIds ready to drop into an { assignedTo: { $in: [...] } } query so that
// client searches respect the same hierarchy as getMyAssignedClients.
async function getAssignableSubtreeIds(emp) {
  const ownerId = emp.owner || null;
  const descendantIds = await getDescendantEmployeeIds(ownerId, emp._id);
  return [
    new mongoose.Types.ObjectId(emp._id),
    ...descendantIds
      .filter((id) => mongoose.isValidObjectId(id))
      .map((id) => new mongoose.Types.ObjectId(id)),
  ];
}

// Clients the logged-in employee can act on in Compose: their own assigned
// clients PLUS every client assigned to someone below them in the hierarchy
// (juniors, sub-juniors, … — the whole subtree). This lets a senior compose to
// their entire downline while strictly following the hierarchy. Computed live
// from EmployeeHierarchy so it never goes stale between logins. Shape
// ({ clients: [...] }) matches what ComposeDialog expects.
exports.getMyAssignedClients = async (req, res) => {
  try {
    const ownerId = req.employee.owner || null;
    const meId = new mongoose.Types.ObjectId(req.employee._id);

    const descendantIds = await getDescendantEmployeeIds(ownerId, req.employee._id);
    const subtreeIds = [
      meId,
      ...descendantIds
        .filter((id) => mongoose.isValidObjectId(id))
        .map((id) => new mongoose.Types.ObjectId(id)),
    ];

    const clients = await ClientInfo.find({ assignedTo: { $in: subtreeIds } })
      .sort({ createdAt: -1 })
      .populate("assignedTo", "_id name companyEmail role")
      .populate("supervisedBy", "_id name companyEmail role");

    res.json({ clients });
  } catch (err) {
    console.error("getMyAssignedClients error:", err);
    res.status(500).json({ error: "Server error" });
  }
};

// The CRM (manager) recipient(s) a senior should route a client's email to,
// instead of the assigned junior/sub-junior. Resolved server-side so it does
// NOT depend on the roster's role casing/filters: every ACTIVE employee under
// the same owner whose role is "manager" (case-insensitive), excluding the
// caller. For a single-CRM org this is exactly that one manager.
exports.getCrmRecipients = async (req, res) => {
  try {
    const me = await Employee.findById(req.employee._id).select("_id owner role");
    if (!me) return res.status(404).json({ error: "Employee not found" });
    if (!me.owner) return res.status(400).json({ error: "Owner ID missing in profile" });

    // 🔑 ACCESS-BASED: CRM recipients are the CRM-access holders + rootManager
    // (was role: /manager/i), excluding the caller.
    const crmIds = (await getCrmUserIds(me.owner)).filter(
      (id) => String(id) !== String(me._id)
    );
    const managers = await Employee.find({
      owner: me.owner,
      status: "active",
      _id: { $in: crmIds.map((id) => new mongoose.Types.ObjectId(id)) },
    }).select("_id name email companyEmail role designation employeeId empId");

    res.json({ managers });
  } catch (err) {
    console.error("getCrmRecipients error:", err);
    res.status(500).json({ error: "Failed to fetch CRM recipients" });
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
      !(await hasCrmAccess(req.employee)) &&
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
          _id: empData._id,
          name: empData.name.trim(),
          designation: empData.designation.trim(),
          email: empData.email ? empData.email.trim().toLowerCase() : undefined,
          phone: empData.phone ? empData.phone.trim() : undefined,
          department: empData.department ? empData.department.trim() : undefined,
          isPrimaryContact: empData.isPrimaryContact || false,
          notes: empData.notes ? empData.notes.trim() : undefined,
          photographUrl: empData.photographUrl || undefined,
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
      !(await hasCrmAccess(req.employee)) &&
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
      !(await hasCrmAccess(req.employee)) &&
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
      !(await hasCrmAccess(req.employee)) &&
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

    // Restrict access: Owner, Manager/Team Lead, assigned employee, or supervised employee
    const role = String(emp.role || "").trim().toLowerCase();
    const empIdStr = String(emp._id);
    const isAssigned = Array.isArray(client.assignedTo)
      ? client.assignedTo.some((a) => String(a._id || a) === empIdStr)
      : false;
    const isSupervised = Array.isArray(client.supervisedBy)
      ? client.supervisedBy.some((a) => String(a._id || a) === empIdStr)
      : false;
    if (role !== "owner" && !(await hasCrmAccess(req.employee)) && !isAssigned && !isSupervised) {
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
      !(await hasCrmAccess(req.employee)) &&
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

    // 🔥 HANDLE GROUP IDs — flags are stored per member on the group, so
    // archiving/pinning a group only affects the member who toggled it
    if (id.startsWith("group_")) {
      const WhatsAppGroup = require("../models/WhatsAppGroup");
      const groupId = id.replace(/^group_/, "");
      if (!mongoose.isValidObjectId(groupId)) {
        return res.status(400).json({ error: "Invalid group ID" });
      }

      const group = await WhatsAppGroup.findById(groupId);
      if (!group || group.isActive === false) {
        return res.status(404).json({ error: "Group not found" });
      }

      const isMember = (group.members || []).some(
        (m) => String(m.memberId) === String(emp._id)
      );
      if (!isMember) {
        return res.status(403).json({ error: "Not a member of this group" });
      }

      const key = String(emp._id);
      const current = (group.memberFlags && group.memberFlags.get(key)) || {};
      const newValue = !current[flag];
      group.memberFlags.set(key, { ...current, [flag]: newValue });
      group.markModified("memberFlags");
      await group.save();

      return res.json({
        success: true,
        message: `${flag} toggled successfully`,
        flag,
        newValue,
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

    // Base query: always scope by owner, exclude inactive clients from search results
    let query = {
      owner: emp.owner,
      isActive: { $ne: false },
      $or: [
        { clientName: { $regex: search, $options: "i" } },
        { dba: { $regex: search, $options: "i" } },
        { company: { $regex: search, $options: "i" } },
      ],
    };

    // 🔑 ACCESS-BASED: non-CRM users search their own assigned clients PLUS every
    // client assigned to their downline (juniors, sub-juniors, …), matching the
    // hierarchy used by getMyAssignedClients. CRM users search all owner clients.
    if (!(await hasCrmAccess(req.employee))) {
      const subtreeIds = await getAssignableSubtreeIds(emp);
      query.assignedTo = { $in: subtreeIds };
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

    // 🔥 HANDLE GROUP IDs — return this member's own flags for the group
    if (id.startsWith("group_")) {
      const WhatsAppGroup = require("../models/WhatsAppGroup");
      const groupId = id.replace(/^group_/, "");
      let flags = {};
      if (mongoose.isValidObjectId(groupId)) {
        const group = await WhatsAppGroup.findById(groupId)
          .select("memberFlags")
          .lean();
        const mf = group?.memberFlags || {};
        flags =
          (mf instanceof Map ? mf.get(String(emp._id)) : mf[String(emp._id)]) ||
          {};
      }
      return res.json({
        isPinned: !!flags.whatsappPinned,
        isRead: true,
        isFavourite: !!flags.whatsappFavourite,
        isMuted: !!flags.whatsappMuted,
        isArchived: !!flags.whatsappArchived,
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
      photographUrl: client.photographUrl || null,
    });
  } catch (err) {
    console.error("getWhatsAppFlags error:", err);
    res.status(500).json({ error: "Failed to fetch WhatsApp flags" });
  }
};

// Bulk WhatsApp flags — one request returns flags for ALL my clients + groups,
// replacing the per-chat /:id/whatsapp-flags fan-out in the chat sidebar.
exports.getWhatsAppFlagsBulk = async (req, res) => {
  try {
    const emp = await Employee.findById(req.employee._id).select("_id role owner");
    if (!emp) return res.status(404).json({ error: "Employee not found" });

    const role = String(emp.role || "").trim().toLowerCase();
    const isPrivileged =
      role === "owner" ||
      ["manager", "team lead", "team_lead", "teamlead"].includes(role);

    const clientQuery = { owner: emp.owner };
    if (!isPrivileged) {
      clientQuery.$or = [{ assignedTo: emp._id }, { supervisedBy: emp._id }];
    }

    const WhatsAppGroup = require("../models/WhatsAppGroup");
    const [clients, groups] = await Promise.all([
      ClientInfo.find(clientQuery)
        .select("_id whatsappPinned whatsappRead whatsappFavourite whatsappMuted whatsappArchived photographUrl")
        .lean(),
      WhatsAppGroup.find({
        owner: emp.owner,
        isActive: true,
        "members.memberId": String(emp._id),
      })
        .select("_id memberFlags")
        .lean(),
    ]);

    const flags = {};
    for (const c of clients) {
      flags[String(c._id)] = {
        isPinned: !!c.whatsappPinned,
        isRead: !!c.whatsappRead,
        isFavourite: !!c.whatsappFavourite,
        isMuted: !!c.whatsappMuted,
        isArchived: !!c.whatsappArchived,
        photographUrl: c.photographUrl || null,
      };
    }
    for (const g of groups) {
      const mf = g.memberFlags || {};
      const f =
        (mf instanceof Map ? mf.get(String(emp._id)) : mf[String(emp._id)]) || {};
      flags[`group_${g._id}`] = {
        isPinned: !!f.whatsappPinned,
        isRead: true,
        isFavourite: !!f.whatsappFavourite,
        isMuted: !!f.whatsappMuted,
        isArchived: !!f.whatsappArchived,
      };
    }

    res.json({ flags });
  } catch (err) {
    console.error("getWhatsAppFlagsBulk error:", err);
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

    // 🚫 CRM users never see the new-clients indicator (they see all clients anyway)
    if (await hasCrmAccess(req.employee)) {
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
    let query = { owner: emp.owner, isActive: { $ne: false } };

    // For non-managers, search assigned clients plus their downline's clients
    if (emp.role?.toLowerCase() !== "manager") {
      const subtreeIds = await getAssignableSubtreeIds(emp);
      query.assignedTo = { $in: subtreeIds };
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
    let query = { owner: emp.owner, isActive: { $ne: false } };

    // For non-managers, search within assigned clients plus downline clients
    if (emp.role?.toLowerCase() !== "manager") {
      const subtreeIds = await getAssignableSubtreeIds(emp);
      query.assignedTo = { $in: subtreeIds };
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
      .select("_id name email companyEmail role designation employeeId")
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
    if (await hasCrmAccess(req.employee)) {
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

exports.uploadClientPhoto = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    const { id } = req.params;
    const client = await ClientInfo.findById(id);
    if (!client) return res.status(404).json({ error: "Client not found" });

    client.photographUrl = `/uploads/${req.file.filename}`;
    await client.save();

    res.json({ photographUrl: client.photographUrl });
  } catch (err) {
    console.error("uploadClientPhoto error:", err);
    res.status(500).json({ error: "Failed to upload photo" });
  }
};

exports.uploadCompanyEmployeePhoto = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    const { id, employeeIndex } = req.params;

    const client = await ClientInfo.findById(id);
    if (!client) return res.status(404).json({ error: "Client not found" });

    const index = parseInt(employeeIndex);
    if (isNaN(index) || index < 0 || index >= client.companyEmployees.length) {
      return res.status(400).json({ error: "Invalid employee index" });
    }

    client.companyEmployees[index].photographUrl = `/uploads/${req.file.filename}`;
    client.markModified("companyEmployees");
    await client.save();

    res.json({ photographUrl: client.companyEmployees[index].photographUrl });
  } catch (err) {
    console.error("uploadCompanyEmployeePhoto error:", err);
    res.status(500).json({ error: "Failed to upload photo" });
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

    if (!(await hasCrmAccess(req.employee)) && !isSenior) {
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

