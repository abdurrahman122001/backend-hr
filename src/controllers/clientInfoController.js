const mongoose = require("mongoose");
const ClientInfo = require("../models/ClientInfo");
const Employee = require("../models/Employees");
const EmployeeHierarchy = require("../models/EmployeeHierarchy");
const { hasCrmAccess, getCrmUserIds } = require("../utils/crmAccess");
const { syncClientAssignees } = require("../utils/clientAssignees");
const {
  createClientSpace,
  syncClientSpaceMembers,
} = require("../services/clientSpaceService");

// ⚠️ DEPRECATED role check — kept only for reference. CRM/manager powers are now
// access-based: use `await hasCrmAccess(req.employee)` instead of isManagerLike.
const isManagerLike = (role) => {
  const r = String(role || "").toLowerCase();
  return /\bmanager\b/.test(r) || /team\s*lead/.test(r) || /\bcrm\b/.test(r);
};

// Normalize one client-contact payload. `existing` is the stored sub-document
// (when editing) so fields the client doesn't echo back — emailSignature and
// photographUrl are managed by their own endpoints — survive a form save.
const normalizeCompanyEmployee = (empData, existing = null) => {
  if (!empData || !empData.name || !empData.designation) {
    throw new Error("Each company employee must have name and designation");
  }
  return {
    ...(empData._id ? { _id: empData._id } : {}),
    name: empData.name.trim(),
    designation: empData.designation.trim(),
    email: empData.email ? empData.email.trim().toLowerCase() : undefined,
    phone: empData.phone ? empData.phone.trim() : undefined,
    department: empData.department ? empData.department.trim() : undefined,
    isPrimaryContact: empData.isPrimaryContact || false,
    notes: empData.notes ? empData.notes.trim() : undefined,
    emailSignature:
      empData.emailSignature !== undefined
        ? empData.emailSignature || ""
        : existing?.emailSignature || "",
    photographUrl:
      empData.photographUrl !== undefined
        ? empData.photographUrl || undefined
        : existing?.photographUrl || undefined,
    addedAt: empData.addedAt || existing?.addedAt || new Date(),
  };
};

// Normalize the businesses array. Each business owns its email, its assigned
// team members and its own contacts, so the whole array is rebuilt from the
// payload — `existingClient` supplies the stored business (matched by _id) so
// unsent fields aren't wiped. Throws on invalid input; callers turn that into a
// 400 so the message reaches the form.
const normalizeBusinesses = (businesses, existingClient = null) => {
  if (!Array.isArray(businesses)) {
    throw new Error("businesses must be an array");
  }

  return businesses.map((biz) => {
    if (!biz || !String(biz.businessName || "").trim()) {
      throw new Error("Each business must have a business name");
    }

    const existing = biz._id && existingClient?.businesses?.id
      ? existingClient.businesses.id(biz._id)
      : null;

    const assignedTo = (Array.isArray(biz.assignedTo) ? biz.assignedTo : [])
      // Accept either raw ids or populated { _id } objects coming back from the UI
      .map((e) => (e && typeof e === "object" ? e._id : e))
      .filter((eid) => eid && mongoose.Types.ObjectId.isValid(String(eid)))
      .map((eid) => new mongoose.Types.ObjectId(String(eid)));

    const contacts = (
      Array.isArray(biz.companyEmployees) ? biz.companyEmployees : []
    ).map((empData) =>
      normalizeCompanyEmployee(
        empData,
        empData._id && existing?.companyEmployees?.id
          ? existing.companyEmployees.id(empData._id)
          : null,
      ),
    );

    const websites = (Array.isArray(biz.websites) ? biz.websites : [])
      .map((w) => String(w || "").trim())
      .filter(Boolean);

    const scopeOfWork = (Array.isArray(biz.scopeOfWork) ? biz.scopeOfWork : [])
      .filter((s) => s && String(s.service || "").trim())
      .map((s) => ({
        service: String(s.service).trim(),
        // Anything other than an explicit one-off is billed as recurring,
        // matching the schema default.
        billing: s.billing === "one_off" ? "one_off" : "recurring",
      }));

    return {
      ...(biz._id ? { _id: biz._id } : {}),
      businessName: biz.businessName.trim(),
      legalBusinessName: biz.legalBusinessName?.trim() || undefined,
      dba: biz.dba?.trim() || undefined,
      email: biz.email ? biz.email.trim().toLowerCase() : undefined,
      phone: biz.phone?.trim() || undefined,
      industry: biz.industry?.trim() || undefined,
      natureOfBusiness: biz.natureOfBusiness?.trim() || undefined,
      companyLocation: biz.companyLocation?.trim() || undefined,
      bookkeepingSoftware: biz.bookkeepingSoftware?.trim() || undefined,
      nameInAccountingSoftware:
        biz.nameInAccountingSoftware?.trim() || undefined,
      naicsOrSic: biz.naicsOrSic?.trim() || undefined,
      websites,
      scopeOfWork,
      assignedTo,
      companyEmployees: contacts,
      emailSignature:
        biz.emailSignature !== undefined
          ? biz.emailSignature || ""
          : existing?.emailSignature || "",
      notes: biz.notes?.trim() || undefined,
      isActive: biz.isActive !== false,
      addedAt: biz.addedAt || existing?.addedAt || new Date(),
    };
  });
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

    const { ownerId, companyEmployees = [], businesses = [], ...rest } = req.body;

    if (!ownerId) return res.status(400).json({ error: "ownerId is required" });

    // Validate companyEmployees / businesses if provided during creation
    let validatedEmployees = [];
    let validatedBusinesses = [];
    try {
      validatedEmployees = (Array.isArray(companyEmployees) ? companyEmployees : []).map(
        (empData) => normalizeCompanyEmployee(empData),
      );
      validatedBusinesses = normalizeBusinesses(
        Array.isArray(businesses) ? businesses : [],
      );
    } catch (validationErr) {
      return res.status(400).json({ error: validationErr.message });
    }

    const doc = await ClientInfo.create({
      ...rest,
      owner: ownerId,
      createdBy: emp._id,
      companyEmployees: validatedEmployees,
      businesses: validatedBusinesses,
      // Derived from the businesses — never taken from the request body, since
      // employees are assigned per business, not to the client.
      assignedTo: syncClientAssignees({ businesses: validatedBusinesses })
        .assignedTo,
    });

    // Auto-create a Google-Chat space named after the client with the
    // assigned + supervising employees as members. Fire-and-forget: a space
    // failure must never fail client creation.
    createClientSpace({
      client: doc,
      creatorId: emp._id,
      io: req.app.get("io"),
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
      // Regular employee: clients assigned to them directly, PLUS clients where
      // they are assigned to one of the businesses (per-business assignment).
      q = {
        $or: [
          { assignedTo: emp._id },
          { "businesses.assignedTo": emp._id },
        ],
      };
    }

    const clients = await ClientInfo.find(q)
      .sort({ createdAt: -1 })
      .populate("assignedTo", "_id name companyEmail role")
      .populate("supervisedBy", "_id name companyEmail role")
      .populate("businesses.assignedTo", "_id name companyEmail role photographUrl");


    res.json(clients);
  } catch (err) {
    console.error("getClientInfo error:", err);
    res.status(500).json({ error: "Failed to fetch client info" });
  }
};

// Flat list of every client employee (ClientInfo.companyEmployees) across the
// clients the logged-in employee can see — used by the WhatsApp group member
// picker. Access is scoped exactly like getClientInfo: Owner/CRM see all clients
// under their owner, a regular employee sees only their assigned clients. Each
// embedded sub-document is returned with its own _id plus a lightweight `client`
// reference ({ _id, clientName }) so the picker can group and label them.
exports.getAllCompanyEmployees = async (req, res) => {
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
      // Assignment can be at client level or on one of the client's businesses.
      q = {
        $or: [
          { assignedTo: emp._id },
          { "businesses.assignedTo": emp._id },
        ],
      };
    }

    // Only pull client employees that belong to active clients — an inactive
    // client's contacts should not appear in the group member picker.
    const clients = await ClientInfo.find({ ...q, isActive: { $ne: false } })
      .select("_id clientName companyEmployees businesses")
      .lean();

    // Contacts live under each business now; records predating businesses still
    // carry them at client level, so both are returned. Business contacts get a
    // `business` reference so the picker can group and label them.
    const clientEmployees = [];
    for (const client of clients) {
      const clientRef = { _id: client._id, clientName: client.clientName };

      for (const business of client.businesses || []) {
        if (business.isActive === false) continue;
        for (const ce of business.companyEmployees || []) {
          clientEmployees.push({
            ...ce,
            clientEmployeeName: ce.name,
            client: clientRef,
            business: {
              _id: business._id,
              businessName: business.businessName,
              email: business.email,
            },
          });
        }
      }

      for (const ce of client.companyEmployees || []) {
        clientEmployees.push({
          ...ce,
          clientEmployeeName: ce.name,
          client: clientRef,
          business: null,
        });
      }
    }

    res.json({ clientEmployees });
  } catch (err) {
    console.error("getAllCompanyEmployees error:", err);
    res.status(500).json({ error: "Failed to fetch client employees" });
  }
};

exports.getMyClients = async (req, res) => {
  try {
    const employeeId = req.employee._id;
    const asObjectId = new mongoose.Types.ObjectId(employeeId);

    const clients = await ClientInfo.find({ assignedTo: asObjectId })
      .sort({ createdAt: -1 })
      .populate("assignedTo", "_id name companyEmail role")
      .populate("supervisedBy", "_id name companyEmail role")
      .populate("businesses.assignedTo", "_id name companyEmail role photographUrl");

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
      .populate("supervisedBy", "_id name companyEmail role")
      .populate("businesses.assignedTo", "_id name companyEmail role photographUrl");

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
    const { companyEmployees, businesses, ...updates } = req.body;

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

    // If companyEmployees / businesses are provided in update, replace the
    // entire array. Both rebuilds carry unsent fields over from the stored doc
    // (matched by _id) — otherwise saving the client form wipes values that are
    // managed by their own endpoints, e.g. emailSignature and photographUrl.
    try {
      if (companyEmployees !== undefined) {
        if (!Array.isArray(companyEmployees)) {
          return res.status(400).json({ error: "companyEmployees must be an array" });
        }
        updates.companyEmployees = companyEmployees.map((empData) =>
          normalizeCompanyEmployee(
            empData,
            empData._id ? client.companyEmployees.id(empData._id) : null,
          ),
        );
      }

      if (businesses !== undefined) {
        updates.businesses = normalizeBusinesses(businesses, client);
        // assignedTo is the union of the businesses' assignees, never a value
        // the client sends — assignment happens per business. When no business
        // has assignees yet, leave the stored list untouched: the form posts
        // its whole businesses array on every save, so overwriting here would
        // wipe the assignees of clients that predate businesses.
        const derived = syncClientAssignees({
          businesses: updates.businesses,
        }).assignedTo;
        if (Array.isArray(derived) && derived.length > 0) {
          updates.assignedTo = derived;
        } else {
          delete updates.assignedTo;
        }
      } else {
        // Guard against a stale client-level assignment sneaking back in.
        delete updates.assignedTo;
      }
    } catch (validationErr) {
      return res.status(400).json({ error: validationErr.message });
    }

    const updated = await ClientInfo.findByIdAndUpdate(
      id,
      updates,
      { new: true }
    ).populate("assignedTo", "_id name companyEmail role")
      .populate("supervisedBy", "_id name companyEmail role")
      .populate("businesses.assignedTo", "_id name companyEmail role photographUrl");

    res.json(updated);
  } catch (err) {
    console.error("updateClientInfo error:", err);
    res.status(500).json({ error: "Failed to update client info" });
  }
};

/**
 * Add one contact to a client — either at client level or under one of its
 * businesses — without sending the whole client document back.
 *
 * This exists for the email screen: when a new person at the client's side turns
 * up in a thread, whoever is working that thread can file them straight away
 * instead of navigating to Client Information and re-saving the entire record
 * (the only route to a business contact until now was a full `PUT /:id` carrying
 * every business, which is both heavy and easy to clobber concurrently).
 *
 * Who may do it: an owner, anyone with CRM access, or an employee actually
 * attached to this client (assigned to it or supervising it) — the same people
 * who can already see and reply on the client's mail. Note this deliberately
 * does NOT reuse addCompanyEmployee's check, which compares
 * `String(client.assignedTo)` (an array) against a single id and therefore
 * never matches once a client has more than one assignee.
 */
exports.addClientContact = async (req, res) => {
  try {
    const emp = await Employee.findById(req.employee._id);
    if (!emp) return res.status(404).json({ error: "Employee not found" });

    const { id } = req.params;
    const { businessId, name, designation } = req.body;

    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: "Name is required" });
    }
    if (!designation || !String(designation).trim()) {
      return res.status(400).json({ error: "Designation is required" });
    }

    const client = await ClientInfo.findById(id);
    if (!client) return res.status(404).json({ error: "Client not found" });
    if (String(client.owner) !== String(emp.owner)) {
      return res.status(403).json({ error: "Not authorized for this client" });
    }

    const meId = String(emp._id);
    const inList = (list) =>
      (Array.isArray(list) ? list : []).some(
        (x) => String(x?._id || x) === meId,
      );
    const allowed =
      String(emp.role || "").trim().toLowerCase() === "owner" ||
      (await hasCrmAccess(req.employee)) ||
      inList(client.assignedTo) ||
      inList(client.supervisedBy) ||
      (client.businesses || []).some((b) => inList(b?.assignedTo));

    if (!allowed) {
      return res
        .status(403)
        .json({ error: "Not authorized to add contacts to this client" });
    }

    let contact;
    try {
      contact = normalizeCompanyEmployee(req.body);
    } catch (validationErr) {
      return res.status(400).json({ error: validationErr.message });
    }
    // This endpoint only ever creates. normalizeCompanyEmployee passes an _id
    // through when it sees one, and letting a caller choose the sub-document id
    // is asking for a collision with an existing contact.
    delete contact._id;
    contact.addedAt = new Date();

    // Where does it go — one business, or the client itself?
    let business = null;
    if (businessId) {
      business = (client.businesses || []).id(businessId);
      if (!business) {
        return res.status(404).json({ error: "Business not found on this client" });
      }
    }
    const target = business ? business : client;

    // A contact is identified by email everywhere else in the app (thread
    // matching, reply re-addressing), so a duplicate address in the same bucket
    // would make those lookups ambiguous.
    if (contact.email) {
      const clash = (target.companyEmployees || []).some(
        (e) =>
          String(e?.email || "").toLowerCase().trim() ===
          String(contact.email).toLowerCase().trim(),
      );
      if (clash) {
        return res
          .status(409)
          .json({ error: "A contact with this email already exists here" });
      }
    }

    target.companyEmployees.push(contact);
    await client.save();

    const saved =
      target.companyEmployees[target.companyEmployees.length - 1];

    const updated = await ClientInfo.findById(id)
      .populate("assignedTo", "_id name companyEmail role")
      .populate("supervisedBy", "_id name companyEmail role")
      .populate(
        "businesses.assignedTo",
        "_id name companyEmail role photographUrl",
      );

    res.status(201).json({
      contact: saved,
      businessId: business ? String(business._id) : null,
      businessName: business ? business.businessName : null,
      client: updated,
    });
  } catch (err) {
    console.error("addClientContact error:", err);
    res.status(500).json({ error: "Failed to add contact" });
  }
};

// Add a single company employee to client
exports.addCompanyEmployee = async (req, res) => {
  try {
    const emp = await Employee.findById(req.employee._id);
    if (!emp) return res.status(404).json({ error: "Employee not found" });

    const { id } = req.params;
    const { name, designation, email, phone, department, isPrimaryContact, notes, emailSignature } = req.body;

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
      emailSignature: emailSignature || "",
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
    const { name, designation, email, phone, department, isPrimaryContact, notes, emailSignature } = req.body;

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
    if (emailSignature !== undefined) client.companyEmployees[index].emailSignature = emailSignature || "";

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

// Replace the team members assigned to ONE business of a client. Mirrors the
// client-level assignment flow but scoped to businesses[businessId], so a
// business can be handled by a different set of people than its parent client.
exports.assignBusinessEmployees = async (req, res) => {
  try {
    const emp = await Employee.findById(req.employee._id);
    if (!emp) return res.status(404).json({ error: "Employee not found" });

    const { id, businessId } = req.params;
    const { employeeIds } = req.body;

    if (!Array.isArray(employeeIds)) {
      return res.status(400).json({ error: "employeeIds must be an array" });
    }

    const client = await ClientInfo.findById(id);
    if (!client) return res.status(404).json({ error: "Client not found" });

    const business = client.businesses.id(businessId);
    if (!business) return res.status(404).json({ error: "Business not found" });

    const invalid = employeeIds.find(
      (eid) => !mongoose.Types.ObjectId.isValid(String(eid)),
    );
    if (invalid) {
      return res.status(400).json({ error: `Invalid employee id: ${invalid}` });
    }

    // Only employees under the same owner may be assigned.
    const validIds = await Employee.find({
      _id: { $in: employeeIds },
      owner: client.owner,
    }).distinct("_id");

    business.assignedTo = validIds;
    // Client-level assignedTo is the union of all business assignees — keep it
    // in step so chat lists, email routing and visibility queries stay correct.
    syncClientAssignees(client);
    await client.save();

    const updated = await ClientInfo.findById(id)
      .populate("assignedTo", "_id name companyEmail role")
      .populate("supervisedBy", "_id name companyEmail role")
      .populate("businesses.assignedTo", "_id name companyEmail role photographUrl");

    res.json(updated);
  } catch (err) {
    console.error("assignBusinessEmployees error:", err);
    res.status(500).json({ error: "Failed to assign business team members" });
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
      .populate("supervisedBy", "_id name companyEmail role")
      .populate("businesses.assignedTo", "_id name companyEmail role photographUrl");

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

/** ObjectId | ObjectId[] | null → array of id strings. */
function idList(value) {
  if (!value) return [];
  return (Array.isArray(value) ? value : [value]).filter(Boolean).map(String);
}

/**
 * May this employee see — and therefore set their OWN sidebar flags on — this
 * client's chat?
 *
 * Deliberately the same bar as getWhatsAppFlagsBulk's client query, which is
 * what actually fills the sidebar. The old check compared
 * `String(client.assignedTo)` — an ARRAY — against a single id, so it happened
 * to hold for clients with exactly one assignee and 403'd every client with
 * two or more, even though the bulk endpoint had already shown that chat. It
 * also predated access-based CRM and ignored supervisedBy.
 */
async function canManageClientChatFlags(emp, client, reqEmployee) {
  const role = String(emp.role || "").trim().toLowerCase();
  if (role === "owner") return true;
  if (["manager", "team lead", "team_lead", "teamlead"].includes(role)) return true;

  const me = String(emp._id);
  if (idList(client.assignedTo).includes(me)) return true;
  if (idList(client.supervisedBy).includes(me)) return true;

  return await hasCrmAccess(reqEmployee);
}

/**
 * This employee's own flags for a client chat. Handles both a hydrated Map and
 * the plain object a .lean() query returns.
 */
function employeeFlagsFor(client, empId) {
  const ef = client?.employeeFlags;
  if (!ef) return {};
  const key = String(empId);
  return (ef instanceof Map ? ef.get(key) : ef[key]) || {};
}

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

    const client = await ClientInfo.findById(id).select(
      "_id assignedTo supervisedBy employeeFlags"
    );
    if (!client) return res.status(404).json({ error: "Client not found" });

    if (!(await canManageClientChatFlags(emp, client, req.employee))) {
      return res.status(403).json({ error: "Not authorized to toggle this flag" });
    }

    // Per-employee, exactly like WhatsAppGroup.memberFlags. This is a personal
    // sidebar preference, so the old `client[flag] = !client[flag]` pinned /
    // muted / archived the chat for EVERY employee who could see that client.
    const key = String(emp._id);
    const current = employeeFlagsFor(client, key);
    const newValue = !current[flag];
    await ClientInfo.updateOne(
      { _id: client._id },
      { $set: { [`employeeFlags.${key}`]: { ...current, [flag]: newValue } } }
    );

    res.json({
      success: true,
      message: `${flag} toggled successfully`,
      flag,
      newValue,
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

    if (!(await canManageClientChatFlags(emp, client, req.employee))) {
      return res.status(403).json({ error: "Not authorized to view this client" });
    }

    // Read THIS employee's own map. The legacy shared booleans are deliberately
    // not consulted, so a pin someone else set can never surface here.
    const myFlags = employeeFlagsFor(client, emp._id);
    res.json({
      isPinned: !!myFlags.whatsappPinned,
      isRead: client.whatsappRead || false,
      isFavourite: !!myFlags.whatsappFavourite,
      isMuted: !!myFlags.whatsappMuted,
      isArchived: !!myFlags.whatsappArchived,
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
        .select("_id whatsappRead employeeFlags photographUrl")
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
      // Same per-employee read as the single-chat endpoint — this is the query
      // that fills the sidebar, so it is where a colleague's pin used to leak.
      const f = employeeFlagsFor(c, emp._id);
      flags[String(c._id)] = {
        isPinned: !!f.whatsappPinned,
        isRead: !!c.whatsappRead,
        isFavourite: !!f.whatsappFavourite,
        isMuted: !!f.whatsappMuted,
        isArchived: !!f.whatsappArchived,
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

    // Match the client's own address OR any of its businesses' addresses —
    // each business has its own email and is a valid recipient.
    query.$or = [
      { clientEmail: { $regex: email, $options: "i" } },
      { "businesses.email": { $regex: email, $options: "i" } },
    ];

    const clients = await ClientInfo.find(query)
      .populate("assignedTo", "_id name companyEmail role")
      .populate("supervisedBy", "_id name companyEmail role")
      .populate("businesses.assignedTo", "_id name companyEmail role photographUrl")
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

    // Contacts now live under a business; older records still carry them at
    // client level, so match either place.
    query.$or = [
      { "companyEmployees.email": { $regex: email, $options: "i" } },
      { "companyEmployees.name": { $regex: email, $options: "i" } },
      { "businesses.companyEmployees.email": { $regex: email, $options: "i" } },
      { "businesses.companyEmployees.name": { $regex: email, $options: "i" } },
    ];

    const clients = await ClientInfo.find(query)
      .populate("assignedTo", "_id name companyEmail role")
      .populate("supervisedBy", "_id name companyEmail role")
      .populate("businesses.assignedTo", "_id name companyEmail role photographUrl")
      .limit(10);

    const needle = email.toLowerCase();
    const results = [];

    clients.forEach((client) => {
      const clientRef = {
        _id: client._id,
        clientName: client.clientName,
        dba: client.dba,
        assignedTo: client.assignedTo,
      };

      // Contacts under each business — the business carries its own email and
      // its own assigned team, both of which the composer needs.
      (client.businesses || []).forEach((business) => {
        (business.companyEmployees || []).forEach((employee) => {
          if (
            employee.email?.toLowerCase().includes(needle) ||
            employee.name?.toLowerCase().includes(needle)
          ) {
            results.push({
              client: clientRef,
              business: {
                _id: business._id,
                businessName: business.businessName,
                email: business.email,
                assignedTo: business.assignedTo,
              },
              employee,
            });
          }
        });
      });

      // Legacy client-level contacts
      (client.companyEmployees || []).forEach((employee) => {
        if (
          employee.email?.toLowerCase().includes(needle) ||
          employee.name?.toLowerCase().includes(needle)
        ) {
          results.push({ client: clientRef, business: null, employee });
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

    // Keep the client's Google-Chat space membership in sync (fire-and-forget).
    syncClientSpaceMembers({
      clientId: id,
      actorId: me._id,
      io: req.app.get("io"),
    });

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

// Photo for a contact that belongs to a BUSINESS
// (businesses[businessIndex].companyEmployees[employeeIndex]). Mirrors
// uploadCompanyEmployeePhoto, which only reaches the legacy client-level list.
exports.uploadBusinessEmployeePhoto = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    const { id, businessIndex, employeeIndex } = req.params;

    const client = await ClientInfo.findById(id);
    if (!client) return res.status(404).json({ error: "Client not found" });

    const bIndex = parseInt(businessIndex, 10);
    if (isNaN(bIndex) || bIndex < 0 || bIndex >= (client.businesses || []).length) {
      return res.status(400).json({ error: "Invalid business index" });
    }

    const business = client.businesses[bIndex];
    const eIndex = parseInt(employeeIndex, 10);
    if (
      isNaN(eIndex) ||
      eIndex < 0 ||
      eIndex >= (business.companyEmployees || []).length
    ) {
      return res.status(400).json({ error: "Invalid employee index" });
    }

    business.companyEmployees[eIndex].photographUrl = `/uploads/${req.file.filename}`;
    client.markModified("businesses");
    await client.save();

    res.json({
      photographUrl: business.companyEmployees[eIndex].photographUrl,
    });
  } catch (err) {
    console.error("uploadBusinessEmployeePhoto error:", err);
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

